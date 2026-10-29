import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import {
  HOUR_MS,
  WINDOW_SPAN_MS,
  buildAccounts,
  capacity5h,
  TIERS,
  type AccountInfo,
  buildWindows,
  groupSamplesByAccount,
  type QuotaWindow,
  type WindowKind,
} from '../src/features/usageHistory/model';
import {
  projectAccount,
  simulatePool,
  type AccountProjection,
} from '../src/features/usageHistory/projection';
import {
  axisPosition,
  buildCapacityChart,
  type ChartData,
} from '../src/features/usageHistory/chartData';
import { CapacityChart } from '../src/features/usageHistory/components/CapacityChart';
import { NowTable } from '../src/features/usageHistory/components/NowTable';
import { RunwayTile } from '../src/features/usageHistory/components/RunwayTile';
import { buildNowRows, buildPools } from '../src/features/usageHistory/pools';
import type { QuotaHistorySample } from '../src/services/api/quotaHistory';
import { NOW, quotaHistoryResponse } from './fixtures/quotaHistory';

const HOSTILE = '<img src=x onerror=alert(1)> team';
const raw = {
  ...quotaHistoryResponse,
  accounts: quotaHistoryResponse.accounts.map((account) =>
    account.auth_id === 'claude-c3' ? { ...account, label: HOSTILE } : account
  ),
};
const history = normalizeQuotaHistory(raw);
const accounts = buildAccounts(history);
const samples = groupSamplesByAccount(history.samples);
const windowsOf = (kind: WindowKind) =>
  new Map<string, QuotaWindow[]>(
    accounts.map((account) => [
      account.authId,
      buildWindows(account.authId, samples.get(account.authId) ?? [], kind),
    ])
  );
const projectionsOf = (kind: WindowKind) =>
  new Map<string, AccountProjection>(
    accounts.map((account) => [
      account.authId,
      projectAccount(account.authId, samples.get(account.authId) ?? [], kind, NOW),
    ])
  );
const windows5 = windowsOf('5h');
const projections = projectionsOf('5h');
const projections7 = projectionsOf('7d');
const team = accounts.filter((account) => account.plan === 'team');
const FIVE_H = 5 * HOUR_MS;
const poolOf = (list: AccountProjection[]) => simulatePool(list, NOW, FIVE_H);
const teamPool = poolOf(
  team.map((account) => projections.get(account.authId) as AccountProjection)
);
/** Sum of the series at a grid index: the top of the stacked chart. */
const drawnTotalAt = (data: ChartData, index: number): number =>
  data.series.reduce((total, entry) => total + (entry.values[index] ?? 0), 0);
const valuesOf = (
  data: { series: Array<{ account: { authId: string }; values: number[] }> },
  id: string
) => data.series.find((entry) => entry.account.authId === id)?.values ?? [];

const chart5 = buildCapacityChart({
  accounts: team,
  samples,
  windows: windows5,
  kind: '5h',
  from: NOW - 48 * HOUR_MS,
  to: NOW,
  points: 360,
  tail: { horizonMs: FIVE_H, projections, pool: teamPool },
});

/** The fixed fields of a hand-made projection. */
const handMade = (
  authId: string,
  left: number,
  rate: number,
  reset: number | null
): AccountProjection => ({
  authId,
  left,
  rate,
  reset,
  hoursToReset: reset === null ? null : (reset - NOW) / HOUR_MS,
  emptyInHours: rate > 0 ? left / rate : Number.POSITIVE_INFINITY,
  projectedLeftover: null,
  blockedUntil: null,
});

/** A 24h 5h-chart over hand-made accounts with no history, tail from their pool. */
function pooledChart(list: AccountProjection[]) {
  const pool = poolOf(list);
  const chartAccounts = list.map((entry, slot) => ({
    authId: entry.authId,
    label: entry.authId,
    tier: 'team_premium' as const,
    defaultTier: 'team_premium' as const,
    plan: 'team' as const,
    slot,
    status: 'active' as const,
  }));
  const data = buildCapacityChart({
    accounts: chartAccounts,
    samples: new Map(),
    windows: new Map(),
    kind: '5h',
    from: NOW - 24 * HOUR_MS,
    to: NOW,
    points: 360,
    tail: {
      horizonMs: FIVE_H,
      projections: new Map(list.map((entry) => [entry.authId, entry])),
      pool,
    },
  });
  return { pool, data };
}

describe('usage history chart data', () => {
  test('5h chart puts a dot before every reset in range', () => {
    const data = buildCapacityChart({
      accounts: team,
      samples,
      windows: windows5,
      kind: '5h',
      from: NOW - 48 * 60 * 60 * 1000,
      to: NOW,
      points: 360,
    });
    expect(data.series).toHaveLength(4);
    // Three active Team accounts, four resets each in the last 48h; the idle one has none.
    expect(data.dots).toHaveLength(12);
    data.dots.forEach((dot) => expect(data.times[dot.index]).toBeLessThan(NOW));
  });

  test('5h tail pools the accounts for the next 5 hours and refills at each reset', () => {
    const { times, positions, splitIndex = -1 } = chart5;
    expect(splitIndex).toBe(359);
    expect(times[splitIndex]).toBe(NOW);
    expect(times.at(-1)).toBeGreaterThanOrEqual(NOW + FIVE_H);
    // The observed part is even; the tail adds the simulation's breakpoints.
    const step = times[1] - times[0];
    times
      .slice(1, splitIndex + 1)
      .forEach((time, index) => expect(time - times[index]).toBeCloseTo(step, 3));
    times.slice(1).forEach((time, index) => expect(time).toBeGreaterThan(times[index]));
    times.forEach((time, index) => expect(positions[index]).toBe(axisPosition(times, time)));
    teamPool.breakpoints.forEach((time) => expect(times).toContain(time));
    chart5.dots.forEach((dot) => expect(dot.index).toBeLessThanOrEqual(splitIndex));

    const at = (hours: number) => times.indexOf(NOW + hours * HOUR_MS);
    const alex = valuesOf(chart5, 'claude-a1');
    const james = valuesOf(chart5, 'claude-b2');
    const kay = valuesOf(chart5, 'claude-c3');
    // Combined demand 0.5/h. Each account first takes its own rate.
    expect(teamPool.demand).toBeCloseTo(0.5, 3);
    expect(alex[splitIndex]).toBeCloseTo(0.55, 10);
    const early = times.findLastIndex((time) => time <= NOW + 0.5 * HOUR_MS);
    expect(alex[early]).toBeCloseTo(0.55 - (0.15 * (times[early] - NOW)) / HOUR_MS, 2);
    // James is dry after about an hour; his share moves to Alex and Kay in proportion.
    const jamesDry = teamPool.accountEmptyAt.get('claude-b2') ?? 0;
    expect(Math.abs(jamesDry - (NOW + HOUR_MS))).toBeLessThanOrEqual(60 * 1000);
    expect(james[times.indexOf(jamesDry)]).toBe(0);
    const beforeReset = at(2) - 1;
    expect(times[beforeReset]).toBe(NOW + 2 * HOUR_MS - 60 * 1000);
    expect(alex[beforeReset]).toBeCloseTo(0.4 - 0.3 * (59 / 60), 2);
    expect(kay[beforeReset]).toBeCloseTo(0.6 - 0.2 * (59 / 60), 2);
    expect(james[beforeReset]).toBe(0);
    // All three refill at the 14:00 reset and drain at their own rates again.
    expect([alex, james, kay].map((values) => values[at(2)])).toEqual([1, 1, 1]);
    expect(alex.at(-1)).toBeCloseTo(1 - 0.15 * 3, 2);
    expect(james.at(-1)).toBeCloseTo(1 - 0.25 * 3, 2);
    // Pete has never been seen: no data observed and no tail.
    expect(valuesOf(chart5, 'claude-d4').every((value) => value === null)).toBe(true);

    // One reset tick per account with a known reset in the tail.
    const reset = NOW + 2 * HOUR_MS;
    expect(chart5.resetTicks).toHaveLength(3);
    chart5.resetTicks.forEach((tick) =>
      expect(tick.position).toBeCloseTo(axisPosition(times, reset), 10)
    );
  });

  test('without a tail the chart ends at now', () => {
    const data = buildCapacityChart({
      accounts: team,
      samples,
      windows: windows5,
      kind: '5h',
      from: NOW - 24 * HOUR_MS,
      to: NOW,
      points: 120,
    });
    expect(data.times).toHaveLength(120);
    expect(data.times.at(-1)).toBe(NOW);
    expect(data.splitIndex).toBeUndefined();
    expect(data.resetTicks).toEqual([]);
  });

  test('runway marker: a busy account and an idle one run dry together at 1.4h', () => {
    const reset = NOW + 4 * HOUR_MS;
    const { pool, data } = pooledChart([
      handMade('a', 0.5, 1, reset),
      handMade('b', 0.9, 0, reset),
    ]);
    expect(pool.emptyAt).toBe(NOW + 1.4 * HOUR_MS);
    const marker = data.times.indexOf(NOW + 1.4 * HOUR_MS);
    expect(marker).toBeGreaterThan(data.splitIndex ?? Infinity);
    expect(data.positions[marker]).toBe(axisPosition(data.times, pool.emptyAt ?? 0));
    expect(drawnTotalAt(data, marker)).toBe(0);
    expect(drawnTotalAt(data, marker - 1)).toBeGreaterThan(0);
    // Idle 'b' holds still while 'a' carries the demand, then drains to 0.
    expect(valuesOf(data, 'b')[data.times.indexOf(NOW + 30 * 60 * 1000)]).toBe(0.9);
  });

  test('runway marker: the fixture trio, resets moved past their empty point, is drawn at 0', () => {
    // 0.55 + 0.25 + 0.7 left at a combined 0.5/h: the pool is dry at 3 hours.
    const trio = ['claude-a1', 'claude-b2', 'claude-c3'].map((id) => {
      const entry = projections.get(id) as AccountProjection;
      return { ...entry, reset: NOW + 4 * HOUR_MS };
    });
    const { pool, data } = pooledChart(trio);
    const emptyAt = pool.emptyAt ?? 0;
    expect(Math.abs(emptyAt - (NOW + 3 * HOUR_MS))).toBeLessThanOrEqual(60 * 1000);
    const marker = data.times.indexOf(emptyAt);
    expect(marker).toBeGreaterThan(data.splitIndex ?? Infinity);
    expect(drawnTotalAt(data, marker)).toBe(0);
    expect(drawnTotalAt(data, marker - 1)).toBeGreaterThan(0);
    // Every account is at 0 at the marker: none was left untouched.
    data.series.forEach((entry) => expect(entry.values[marker]).toBe(0));
  });

  test('a refill inside the horizon: no marker and the tile reads beyond 5h', () => {
    // The real trio refills at 14:00, an hour before it would run dry.
    const trio = ['claude-a1', 'claude-b2', 'claude-c3'].map(
      (id) => projections.get(id) as AccountProjection
    );
    const { pool, data } = pooledChart(trio);
    expect(pool.emptyAt).toBeNull();
    // These hand-made accounts have no history, so only the simulated tail has values.
    const tail = data.series.map((entry) => entry.values.slice((data.splitIndex ?? 0) + 1));
    tail[0].forEach((_, index) =>
      expect(tail.reduce((total, values) => total + (values[index] ?? 0), 0)).toBeGreaterThan(0)
    );
    const markup = renderToStaticMarkup(
      createElement(RunwayTile, {
        pool,
        now: NOW,
        formatDuration: (ms: number) => `${Math.round(ms / 60000)}min`,
        formatClock: (time: number) => new Date(time).toISOString().slice(11, 16),
      })
    );
    expect(markup).toContain('Team 5h runway');
    expect(markup).toContain('>—<');
    expect(markup).toContain('beyond 5h, next refill 14:00');
    expect(markup).not.toMatch(/ignoring/i);

    const dry = renderToStaticMarkup(
      createElement(RunwayTile, {
        pool: poolOf([handMade('a', 0.5, 1, NOW + 4 * HOUR_MS), handMade('b', 0.9, 0, null)]),
        now: NOW,
        formatDuration: (ms: number) => `${Math.round(ms / 60000)}min`,
        formatClock: (time: number) => new Date(time).toISOString().slice(11, 16),
      })
    );
    expect(dry).toContain('>84min<');
    // 1.0/h of demand on a pool of two equal accounts: half its capacity per hour.
    expect(dry).toContain(
      'pool empty at 13:24, demand 50% of its capacity per hour, refills included'
    );
    const idle = renderToStaticMarkup(
      createElement(RunwayTile, {
        pool: poolOf([handMade('a', 1, 0, null)]),
        now: NOW,
        formatDuration: () => '',
        formatClock: () => '',
      })
    );
    expect(idle).toContain('>beyond 5h<');
  });

  test('weekly chart carries a window open at the range start in from the lead', () => {
    const reset = NOW - 20 * 24 * HOUR_MS;
    const from = NOW - 28 * 24 * HOUR_MS;
    // Only one sample, two days before the range start, of a window that resets inside it.
    const own: QuotaHistorySample[] = [
      { t: from - 2 * 24 * HOUR_MS, authId: 'x', u7: 0.35, r7: reset },
    ];
    const account = {
      authId: 'x',
      label: 'x',
      tier: 'max_20x' as const,
      defaultTier: 'max_20x' as const,
      plan: 'max' as const,
      slot: 0,
      status: 'active',
    };
    const data = buildCapacityChart({
      accounts: [account],
      samples: new Map([['x', own]]),
      windows: new Map([['x', buildWindows('x', own, '7d')]]),
      kind: '7d',
      from,
      to: NOW,
      points: 360,
      labelDots: () => true,
    });
    const values = valuesOf(data, 'x');
    expect(data.times[0]).toBe(from);
    expect(values[0]).toBeCloseTo(0.65, 10);
    expect(values[data.times.findLastIndex((time) => time < reset)]).toBeCloseTo(0.65, 10);
    expect(values[data.times.findIndex((time) => time >= reset)]).toBe(1);
    expect(data.dots).toEqual([
      {
        series: 0,
        index: data.times.findLastIndex((time) => time < reset),
        value: 0.65,
        labelled: true,
      },
    ]);
  });

  test('weekly tail reaches every next reset at the whole-window burn', () => {
    const data = buildCapacityChart({
      accounts,
      samples,
      windows: windowsOf('7d'),
      kind: '7d',
      from: NOW - 28 * 24 * HOUR_MS,
      to: NOW,
      points: 360,
      labelDots: (account) => account.plan === 'max',
      tail: { horizonMs: WINDOW_SPAN_MS['7d'], projections: projections7 },
    });
    const { times, splitIndex = -1 } = data;
    expect(times[splitIndex]).toBe(NOW);
    expect(times.at(-1)).toBeGreaterThanOrEqual(NOW + WINDOW_SPAN_MS['7d']);
    // Every account with an open weekly window (all but idle Pete) shows its reset.
    expect(data.resetTicks).toHaveLength(5);
    data.resetTicks.forEach((tick) => {
      expect(tick.position).toBeGreaterThan(axisPosition(times, NOW));
      expect(tick.position).toBeLessThanOrEqual(1);
    });

    // Alex NT team: the window to 1 Nov rises to 0.4 over six days, 0.4/144 per hour.
    const reset = Date.parse('2026-11-01T00:00:00Z');
    const alexProjection = projections7.get('claude-a1') as AccountProjection;
    expect(alexProjection.rate).toBeCloseTo(0.4 / 144, 5);
    const alex = valuesOf(data, 'claude-a1');
    const beforeReset = times.findLastIndex((time) => time < reset);
    const atReset = alexProjection.left - (alexProjection.rate * (reset - NOW)) / HOUR_MS;
    expect(atReset).toBeCloseTo(0.534, 2);
    expect(alex[beforeReset]).toBeGreaterThanOrEqual(atReset);
    expect(alex[beforeReset]).toBeLessThan(atReset + 0.01);
    expect(alex[beforeReset + 1]).toBeGreaterThan(0.99);
    expect(alex.at(-1)).toBeLessThan(alex[beforeReset + 1]);
  });
});

describe('usage history rendering', () => {
  test('renders labels from the API as text, never as markup', () => {
    const data = buildCapacityChart({
      accounts,
      samples,
      windows: windows5,
      kind: '5h',
      from: NOW - 24 * 60 * 60 * 1000,
      to: NOW,
      points: 120,
    });
    const markup = renderToStaticMarkup(
      createElement(CapacityChart, {
        data,
        mode: 'multiples',
        xTicks: [{ position: 1, label: 'now' }],
        formatTime: (time: number) => new Date(time).toISOString(),
        ariaLabel: 'chart',
      })
    );
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt; team');
    expect(markup).toContain('Alex Gmail');
  });

  test('charts have no table view but keep their accessible name and hint', () => {
    const markup = renderToStaticMarkup(
      createElement(CapacityChart, {
        data: chart5,
        mode: 'stacked',
        xTicks: [{ position: 1, label: 'end' }],
        markers: [
          { position: 0.9, tone: 'now' },
          { position: 0.95, tone: 'runway', label: 'runway 3h 00m (15:00)' },
        ],
        formatTime: (time: number) => new Date(time).toISOString(),
        ariaLabel: 'five hour chart',
      })
    );
    expect(markup).not.toContain('<table');
    expect(markup).not.toContain('<details');
    expect(markup).toContain('aria-label="five hour chart"');
    expect(markup).toMatch(/aria-describedby="[^"]+"/);
    expect(markup).toContain('tabindex="0"');
    expect(markup).toContain('runway 3h 00m (15:00)');
    // Each series with data: observed band, projected band and its dashed top edge. Pete,
    // never seen, draws nothing.
    expect(markup.match(/<path /g)).toHaveLength((team.length - 1) * 3);
  });

  test('a held tooltip index past a shrunk grid reads the last point, never NaN', () => {
    const render = (data: ChartData, index: number) =>
      renderToStaticMarkup(
        createElement(CapacityChart, {
          data,
          mode: 'stacked',
          xTicks: [],
          formatTime: (time: number) => new Date(time).toISOString(),
          ariaLabel: 'chart',
          defaultActiveIndex: index,
        })
      );
    const grid = (points: number) =>
      buildCapacityChart({
        accounts: team,
        samples,
        windows: windows5,
        kind: '5h',
        from: NOW - 24 * HOUR_MS,
        to: NOW,
        points,
      });
    const full = grid(120);
    const shrunk = grid(118);
    expect(full.times).toHaveLength(120);
    expect(shrunk.times).toHaveLength(118);
    expect(render(full, 119)).toContain('role="status"');
    // The index held from the 120-point render, against the 118-point grid.
    const markup = render(shrunk, 119);
    const tooltip = markup.slice(markup.indexOf('role="status"'));
    expect(tooltip).not.toContain('NaN');
    expect(tooltip).not.toContain('Invalid');
    expect(tooltip).toContain(new Date(shrunk.times[117]).toISOString());
  });

  test('right-now table shows the pooled empty-in after the 5h resets-in, a dash when it lasts', () => {
    const markup = renderToStaticMarkup(
      createElement(NowTable, {
        rows: accounts.map((account) => {
          const p5 = projections.get(account.authId) as AccountProjection;
          const emptyAt = teamPool.accountEmptyAt.get(account.authId) ?? null;
          return {
            account,
            used5: p5.left === null ? null : 1 - p5.left,
            reset5: p5.reset,
            emptyIn5: emptyAt === null ? null : (emptyAt - NOW) / HOUR_MS,
            blocked5: false,
            used7: 0,
            reset7: null,
            lastLeftover: null,
            nextLeftover: null,
          };
        }),
        now: NOW,
        formatDuration: (ms: number) => `${Math.round(ms / 60000)}min`,
        onPlanChange: () => undefined,
      })
    );
    const headers = [...markup.matchAll(/<th scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headers.slice(2, 5)).toEqual(['5h used', 'Resets in', 'Empty in']);
    const row = (label: string) => {
      const start = markup.indexOf(label);
      return markup.slice(start, markup.indexOf('</tr>', start));
    };
    const cells = (label: string) =>
      [...row(label).matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
    // James: 0.25 left at about 0.25/h; resets in 2h.
    const james = cells('James team');
    expect(james.slice(0, 2)).toEqual(['75%', '120min']);
    expect(['60min', '61min']).toContain(james[2]);
    // Alex is drawn on harder once James is dry but refills at 14:00 first.
    expect(cells('Alex NT team').slice(0, 3)).toEqual(['45%', '120min', '—']);
    // Pete: never seen, so no reading at all.
    expect(cells('Pete team').slice(0, 3)).toEqual(['—', '—', '—']);
  });
});

describe('usage history stacked chart weights', () => {
  // Team Premium 'a' with 20% left and Max 20x 'm' with 90%, both idle.
  const list: AccountInfo[] = [
    {
      authId: 'a',
      label: 'a team',
      tier: 'team_premium',
      defaultTier: 'team_premium',
      plan: 'team',
      slot: 0,
      status: 'active',
    },
    {
      authId: 'm',
      label: 'm max',
      tier: 'max_20x',
      defaultTier: 'max_20x',
      plan: 'max',
      slot: 1,
      status: 'active',
    },
  ];
  const projections5 = new Map(
    [handMade('a', 0.2, 0, null), handMade('m', 0.9, 0, null)].map((entry) => [entry.authId, entry])
  );
  const pools = buildPools(list, projections5, 'all', NOW, FIVE_H);
  const chartOf = (weighted: boolean) =>
    buildCapacityChart({
      accounts: list,
      samples: new Map(),
      windows: new Map(),
      kind: '5h',
      from: NOW - HOUR_MS,
      to: NOW,
      points: 13,
      weightOf: weighted ? capacity5h : undefined,
      tail: { horizonMs: FIVE_H, projections: projections5, pool: pools.chart },
    });
  const render = (data: ChartData, index: number) =>
    renderToStaticMarkup(
      createElement(CapacityChart, {
        data,
        mode: 'stacked',
        xTicks: [],
        formatTime: (time: number) => new Date(time).toISOString(),
        ariaLabel: 'chart',
        defaultActiveIndex: index,
      })
    );

  test('bands are as tall as their window and the group is the share of the pool left', () => {
    const data = chartOf(true);
    expect(data.series.map((entry) => entry.weight)).toEqual([6.25, 20]);
    // Hand-made accounts have no history: the first tail point carries both.
    const index = (data.splitIndex ?? 0) + 1;
    const markup = render(data, index);
    // 'a' tops out at 1.25 of 26.25 sessions (y 95.24), 'm' 18 more above it (y 26.67).
    const tops = [...markup.matchAll(/<path [^>]*d="M[\d.]+ ([\d.]+) /g)].map((m) => m[1]);
    expect(tops).toContain('95.24');
    expect(tops).toContain('26.67');
    // The individual rows stay shares of each account's own window.
    expect(markup).toContain('>20%</b>');
    expect(markup).toContain('>90%</b>');
    expect(markup).toContain('>73%</b></span></div>');
  });

  test('an account never seen takes no room in the stack', () => {
    const unseen: AccountInfo = {
      authId: 'n',
      label: 'n new',
      tier: 'max_20x',
      defaultTier: 'max_20x',
      plan: 'max',
      slot: 2,
      status: 'active',
    };
    const data = buildCapacityChart({
      accounts: [...list, unseen],
      samples: new Map(),
      windows: new Map(),
      kind: '5h',
      from: NOW - HOUR_MS,
      to: NOW,
      points: 13,
      weightOf: capacity5h,
      tail: { horizonMs: FIVE_H, projections: projections5, pool: pools.chart },
    });
    const markup = render(data, (data.splitIndex ?? 0) + 1);
    const tops = [...markup.matchAll(/<path [^>]*d="M[\d.]+ ([\d.]+) /g)].map((m) => m[1]);
    // The same tops as without 'n': its 20 sessions would otherwise squash the others.
    expect(tops).toContain('95.24');
    expect(tops).toContain('26.67');
    expect(markup).toContain('Group left (2 of 3 accounts)');
  });

  test('without weights every band is the same height and the group is the plain mean', () => {
    const data = chartOf(false);
    expect(data.series.map((entry) => entry.weight)).toEqual([1, 1]);
    const markup = render(data, (data.splitIndex ?? 0) + 1);
    expect(markup).toContain('>55%</b></span></div>');
  });
});

describe('usage history right-now rows', () => {
  // Team 'a' burns 1/h with 0.2 left, Team 'b' is idle at 0.6, Max 'm' burns 0.5/h at 0.9.
  const reset = NOW + 4 * HOUR_MS;
  const list: AccountInfo[] = [
    {
      authId: 'a',
      label: 'a team',
      tier: 'team_premium',
      defaultTier: 'team_premium',
      plan: 'team',
      slot: 0,
      status: 'active',
    },
    {
      authId: 'b',
      label: 'b team',
      tier: 'team_premium',
      defaultTier: 'team_premium',
      plan: 'team',
      slot: 1,
      status: 'active',
    },
    {
      authId: 'm',
      label: 'm max',
      tier: 'max_20x',
      defaultTier: 'max_20x',
      plan: 'max',
      slot: 2,
      status: 'active',
    },
  ];
  const projections5 = new Map(
    [
      handMade('a', 0.2, 1, reset),
      handMade('b', 0.6, 0, reset),
      handMade('m', 0.9, 0.5, reset),
    ].map((entry) => [entry.authId, entry])
  );
  const rowsFor = (scope: 'team' | 'all') => {
    const pools = buildPools(list, projections5, scope, NOW, FIVE_H);
    const rows = buildNowRows({
      accounts: list,
      projections5,
      projections7: new Map(),
      windows5: new Map(),
      windows7: new Map(),
      pools,
      now: NOW,
    });
    return { pools, rows };
  };

  test('the chart scope moves the chart pool, never a table row or the tile', () => {
    const team = rowsFor('team');
    const all = rowsFor('all');
    expect(all.rows).toEqual(team.rows);
    expect(all.pools.team).toEqual(team.pools.team);
    // The chart itself does follow the scope: pooled with 'm', the accounts last longer.
    expect(team.pools.chart.emptyAt).toBe(NOW + 48 * 60 * 1000);
    // In Pro sessions: 'a' burns 6.25/h and is dry at 12 minutes; Max 20x 'm' then holds
    // 16 at 16.25/h, dry at about 71 minutes; idle 'b' holds 3.75 and lasts to 85.
    expect(all.pools.chart.demand).toBeCloseTo(16.25, 10);
    expect(all.pools.chart.accountEmptyAt.get('a')).toBe(NOW + 12 * 60 * 1000);
    expect(all.pools.chart.accountEmptyAt.get('m')).toBe(NOW + 72 * 60 * 1000);
    expect(all.pools.chart.emptyAt).toBe(NOW + 85 * 60 * 1000);
    expect(all.pools.chart.accountEmptyAt.get('b')).toBe(NOW + 85 * 60 * 1000);
  });

  test("a Team row's empty-in matches the tile when the Team pool runs dry", () => {
    const { pools, rows } = rowsFor('all');
    const emptyAt = pools.team.emptyAt ?? 0;
    expect(emptyAt).toBe(NOW + 48 * 60 * 1000);
    const b = rows.find((row) => row.account.authId === 'b');
    expect(b?.emptyIn5).toBeCloseTo((emptyAt - NOW) / HOUR_MS, 10);
    const format = (ms: number) => `${Math.round(ms / 60000)}min`;
    const tile = renderToStaticMarkup(
      createElement(RunwayTile, {
        pool: pools.team,
        now: NOW,
        formatDuration: format,
        formatClock: format,
      })
    );
    expect(tile).toContain('>48min<');
    // Max rows read the Max-only pool: 'm' alone at 0.5/h runs dry at 1.8h.
    const m = rows.find((row) => row.account.authId === 'm');
    expect(m?.emptyIn5).toBeCloseTo(1.8, 10);
  });
});

describe('usage history no-data gaps and weekly blocks', () => {
  const r5 = NOW + 4 * HOUR_MS;
  const r7 = NOW + 2 * HOUR_MS;
  const later7 = NOW + 3 * 24 * HOUR_MS;
  const list: AccountInfo[] = [
    {
      authId: 'a',
      label: 'a team',
      tier: 'team_premium',
      defaultTier: 'team_premium',
      plan: 'team',
      slot: 0,
      status: 'active',
    },
    {
      authId: 'n',
      label: 'n team',
      tier: 'team_premium',
      defaultTier: 'team_premium',
      plan: 'team',
      slot: 1,
      status: 'active',
    },
    {
      authId: 'z',
      label: 'z team',
      tier: 'team_premium',
      defaultTier: 'team_premium',
      plan: 'team',
      slot: 2,
      status: 'active',
    },
    {
      authId: 'w',
      label: 'w team',
      tier: 'team_premium',
      defaultTier: 'team_premium',
      plan: 'team',
      slot: 3,
      status: 'active',
    },
  ];
  // 'a' is seen throughout, 'n' from two hours ago, 'z' never; 'w' is weekly-exhausted
  // since an hour ago with 0.8 of its 5h window left.
  const own = new Map<string, QuotaHistorySample[]>([
    [
      'a',
      [
        { t: NOW - 6 * HOUR_MS, authId: 'a', u5: 0.1, r5, u7: 0.2, r7: later7 },
        { t: NOW - 10 * 60 * 1000, authId: 'a', u5: 0.3, r5, u7: 0.25, r7: later7 },
      ],
    ],
    [
      'n',
      [
        { t: NOW - 2 * HOUR_MS, authId: 'n', u5: 0.3, r5, u7: 0.1, r7: later7 },
        { t: NOW - 10 * 60 * 1000, authId: 'n', u5: 0.5, r5, u7: 0.12, r7: later7 },
      ],
    ],
    [
      'w',
      [
        { t: NOW - 3 * HOUR_MS, authId: 'w', u5: 0.1, r5, u7: 0.95, r7 },
        { t: NOW - HOUR_MS, authId: 'w', u5: 0.2, r5, u7: 1, r7, s7: 'rejected' },
      ],
    ],
  ]);
  const projections5 = new Map(
    list.map(({ authId }) => [authId, projectAccount(authId, own.get(authId) ?? [], '5h', NOW)])
  );
  const pools = buildPools(list, projections5, 'team', NOW, FIVE_H);
  // Every 30 minutes over the last 6 hours, then the pooled 5h tail.
  const data = buildCapacityChart({
    accounts: list,
    samples: own,
    windows: new Map(),
    kind: '5h',
    from: NOW - 6 * HOUR_MS,
    to: NOW,
    points: 13,
    tail: { horizonMs: FIVE_H, projections: projections5, pool: pools.team },
  });
  const firstSeen = data.times.indexOf(NOW - 2 * HOUR_MS);
  const split = data.splitIndex ?? -1;

  test('an account first seen mid-range adds nothing to the stack before its first sample', () => {
    const n = valuesOf(data, 'n');
    expect(firstSeen).toBe(8);
    expect(n.slice(0, firstSeen).every((value) => value === null)).toBe(true);
    expect(n.slice(firstSeen, split + 1).every((value) => value !== null)).toBe(true);
    // Before it is seen the stack is 'a' plus 'w' only.
    const a = valuesOf(data, 'a');
    const w = valuesOf(data, 'w');
    for (let index = 0; index < firstSeen; index += 1) {
      expect(drawnTotalAt(data, index)).toBeCloseTo((a[index] ?? 0) + (w[index] ?? 0), 10);
    }
    // 'z' was never seen: no data observed and no tail.
    expect(valuesOf(data, 'z').every((value) => value === null)).toBe(true);
    expect(data.resetTicks.map((tick) => tick.series)).toEqual([0, 1, 3]);
  });

  test('stacked and per-account views draw no band and no seam where there is no data', () => {
    const render = (mode: 'stacked' | 'multiples', index: number | null = null) =>
      renderToStaticMarkup(
        createElement(CapacityChart, {
          data,
          mode,
          xTicks: [],
          formatTime: (time: number) => new Date(time).toISOString(),
          ariaLabel: 'chart',
          defaultActiveIndex: index,
        })
      );
    const paths = (markup: string) =>
      [...markup.matchAll(/<path [^>]*d="([^"]*)"/g)].map((m) => m[1]);
    // 'a', 'n' and 'w': observed band, projected band, dashed edge. 'z': nothing.
    expect(paths(render('stacked'))).toHaveLength(9);
    expect(paths(render('multiples'))).toHaveLength(9);
    // 'n' (the second series) starts at its first sample, not at the left edge.
    const nBand = paths(render('stacked'))[2];
    expect(nBand.startsWith(`M${(data.positions[firstSeen] * 1000).toFixed(2)} `)).toBe(true);
    expect(paths(render('stacked')).every((d) => !d.includes('NaN'))).toBe(true);

    // Half an hour before 'n' is seen: two "no data" rows, the group counts 'a' and 'w'.
    const before = render('stacked', firstSeen - 1);
    const tooltip = before.slice(before.indexOf('role="status"'));
    expect(tooltip.match(/no data/g)).toHaveLength(2);
    expect(tooltip).toContain('Group left (2 of 4 accounts)');
    expect(tooltip).toContain('>90%</b></span></div>');
    // Once 'n' is seen only 'z' reads "no data".
    const after = render('stacked', split);
    expect(after.slice(after.indexOf('role="status"')).match(/no data/g)).toHaveLength(1);
    expect(after).toContain('Group left (3 of 4 accounts)');
  });

  test('a tooltip with no reading at all says no data for the group', () => {
    const empty = buildCapacityChart({
      accounts: [list[2]],
      samples: own,
      windows: new Map(),
      kind: '5h',
      from: NOW - HOUR_MS,
      to: NOW,
      points: 5,
    });
    const markup = renderToStaticMarkup(
      createElement(CapacityChart, {
        data: empty,
        mode: 'stacked',
        xTicks: [],
        formatTime: (time: number) => new Date(time).toISOString(),
        ariaLabel: 'chart',
        defaultActiveIndex: 4,
      })
    );
    expect(markup).not.toContain('<path');
    expect(markup).toContain('>Group left<');
    expect(markup.match(/no data/g)).toHaveLength(2);
  });

  test('a weekly-blocked account draws 0 until r7, is not drained, and rejoins with 0.8', () => {
    const w = valuesOf(data, 'w');
    const blockedFrom = data.times.indexOf(NOW - HOUR_MS);
    expect(w[blockedFrom - 1]).toBeCloseTo(0.9, 10);
    expect(w.slice(blockedFrom, split + 1)).toEqual([0, 0, 0]);
    const beforeR7 = data.times.findLastIndex((time) => time < r7);
    expect(w.slice(split, beforeR7 + 1).every((value) => value === 0)).toBe(true);
    expect(w[data.times.indexOf(r7)]).toBeCloseTo(0.8, 10);
    // Its reset tick is the weekly reset, where it rejoins.
    expect(data.resetTicks.find((tick) => tick.series === 3)?.position).toBeCloseTo(
      axisPosition(data.times, r7),
      10
    );
    expect(pools.team.values.get('w')?.[0]).toBe(0);
  });

  test('right-now rows: a dash with no reading, "blocked by weekly" in Empty in', () => {
    expect(pools.team.values.has('z')).toBe(false);
    const rows = buildNowRows({
      accounts: list,
      projections5,
      projections7: new Map(),
      windows5: new Map(),
      windows7: new Map(),
      pools,
      now: NOW,
    });
    const z = rows.find((row) => row.account.authId === 'z');
    expect(z).toMatchObject({ used5: null, reset5: null, emptyIn5: null, blocked5: false });
    const w = rows.find((row) => row.account.authId === 'w');
    expect(w?.blocked5).toBe(true);
    expect(w?.used5).toBeCloseTo(0.2, 10);

    const markup = renderToStaticMarkup(
      createElement(NowTable, {
        rows,
        now: NOW,
        formatDuration: (ms: number) => `${Math.round(ms / 60000)}min`,
        onPlanChange: () => undefined,
      })
    );
    const cells = (label: string) => {
      const start = markup.indexOf(label);
      const row = markup.slice(start, markup.indexOf('</tr>', start));
      return [...row.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1]);
    };
    expect(cells('z team').slice(0, 4)).toEqual(['—', '—', '—', '—']);
    expect(cells('w team').slice(0, 3)).toEqual(['20%', '240min', 'blocked by weekly']);
  });
});

describe('usage history translations', () => {
  const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'];
  const readMessages = (locale: string) =>
    (
      JSON.parse(
        readFileSync(new URL(`../src/i18n/locales/${locale}.json`, import.meta.url), 'utf8')
      ) as { usage_history: Record<string, string> }
    ).usage_history;
  const baseKey = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');
  const featureSource = ['', 'components/']
    .flatMap((dir) => {
      const url = new URL(`../src/features/usageHistory/${dir}`, import.meta.url);
      return readdirSync(url)
        .filter((name) => name.endsWith('.tsx'))
        .map((name) => readFileSync(new URL(name, url), 'utf8'));
    })
    .join('\n');

  test('every locale carries the same usage_history keys', () => {
    const keys = (locale: string) =>
      [...new Set(Object.keys(readMessages(locale)).map(baseKey))].sort();
    LOCALES.forEach((locale) => expect(keys(locale)).toEqual(keys('en')));
  });

  test('every tier has a label', () => {
    const known = new Set(Object.keys(readMessages('en')));
    expect(TIERS.filter((tier) => !known.has(`tier_${tier}`))).toEqual([]);
  });

  test('every literal usage_history key the feature uses exists', () => {
    const known = new Set(Object.keys(readMessages('en')).map(baseKey));
    const used = [...featureSource.matchAll(/'usage_history\.([a-z0-9_]+)'/g)].map((m) => m[1]);
    expect(used.length).toBeGreaterThan(0);
    expect(used.filter((key) => !known.has(key))).toEqual([]);
  });

  test('no waste or idle-share copy is left', () => {
    LOCALES.forEach((locale) => {
      const messages = readMessages(locale);
      expect(Object.keys(messages).filter((key) => /waste|idle5|active_/.test(key))).toEqual([]);
      expect(Object.values(messages).join(' ')).not.toMatch(/\bwaste/i);
    });
  });
});

describe('usage history accounts out of the pool', () => {
  test('a disabled account is tagged in the table', () => {
    const off: AccountInfo = {
      authId: 'off',
      label: 'Off max',
      tier: 'max_20x',
      defaultTier: 'max_20x',
      plan: 'max',
      slot: 0,
      status: 'disabled',
    };
    const table = renderToStaticMarkup(
      createElement(NowTable, {
        rows: [
          {
            account: off,
            used5: null,
            reset5: null,
            emptyIn5: null,
            blocked5: false,
            used7: null,
            reset7: null,
            lastLeftover: 0.3,
            nextLeftover: null,
          },
        ],
        now: NOW,
        formatDuration: () => '',
        onTierChange: () => {},
      })
    );
    expect(table).toContain('>Disabled</span>');
  });
});
