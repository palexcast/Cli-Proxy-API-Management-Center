import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import '../src/i18n/index';
import {
  buildBurn,
  burnLineWindow,
  usageEvents,
  type Burn,
} from '../src/features/usageHistory/burn';
import {
  axisPosition,
  buildCapacityChart,
  seriesShares,
  type ChartData,
} from '../src/features/usageHistory/chartData';
import { BurnStats } from '../src/features/usageHistory/components/BurnStats';
import { CapacityChart } from '../src/features/usageHistory/components/CapacityChart';
import { formatAxisNumber, niceCeiling } from '../src/features/usageHistory/format';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  buildTimeGrid,
  type AccountInfo,
} from '../src/features/usageHistory/model';
import {
  poolOf,
  simulateRouting,
  type AccountProjection,
  type PoolSimulation,
} from '../src/features/usageHistory/projection';
import type { QuotaHistorySample } from '../src/services/api/quotaHistory';
import { NOW } from './fixtures/quotaHistory';
import { simulate } from './helpers/usageHistoryPool';

const account = (authId: string, slot: number): AccountInfo => ({
  authId,
  label: authId,
  tier: 'team_premium',
  plan: 'team',
  slot,
  status: 'active',
  fiveHourLimit: true,
  priority: 0,
});

const reading = (t: number, u5: number, r5: number): QuotaHistorySample => ({
  t,
  authId: 'a',
  u5,
  r5,
});

const projection = (authId: string, left: number, rate: number): AccountProjection => ({
  authId,
  left,
  rate,
  reset: null,
  blockedUntil: null,
});

/** A 5h chart over hand-made accounts with no history, its tail drawn from `pool`. */
function tailChart(list: AccountProjection[], pool: PoolSimulation): ChartData {
  return buildCapacityChart({
    accounts: list.map((entry, slot) => account(entry.authId, slot)),
    samples: new Map(),
    windows: new Map(),
    kind: '5h',
    from: NOW - 6 * HOUR_MS,
    to: NOW,
    points: 360,
    tail: {
      horizonMs: 5 * HOUR_MS,
      projections: new Map(list.map((entry) => [entry.authId, entry])),
      pool,
    },
  });
}

/** The projected values of a burn line with the times they sit at. */
const tailOf = (data: ChartData, burn: Burn) =>
  burn.values
    .map((value, index) => ({ time: data.times[index], value }))
    .filter((_, index) => index > (data.splitIndex ?? data.times.length));

describe('usage events', () => {
  const r1 = NOW + HOUR_MS;

  test('counts rises within a window and a new window from zero, nothing else', () => {
    const events = usageEvents(
      [
        reading(NOW - 30 * MINUTE_MS, 0.1, r1), // first reading: no baseline
        reading(NOW - 20 * MINUTE_MS, 0.15, r1),
        reading(NOW - 10 * MINUTE_MS, 0.14, r1), // a dip is not negative use...
        reading(NOW, 0.2, r1), // ...and only the rise above 0.15 is new
        reading(r1 + MINUTE_MS, 0.5, r1), // taken after its own reset: over
        reading(r1 + 2 * MINUTE_MS, 0.03, r1 + 5 * HOUR_MS),
      ],
      '5h'
    );
    expect(events.map((event) => event.t)).toEqual([NOW - 20 * MINUTE_MS, NOW, r1 + 2 * MINUTE_MS]);
    expect(events.map((event) => Number(event.amount.toFixed(6)))).toEqual([0.05, 0.05, 0.03]);
  });

  test('jitter between two levels is not use: a window adds up to its high minus its first', () => {
    // Live pattern: rejected responses say 100% while the allowed ones between say 99%.
    const levels = [0.97, 0.99, 1, 0.99, 1, 0.99, 0.99, 1, 0.99];
    const events = usageEvents(
      levels.map((u, index) => reading(NOW - (levels.length - index) * MINUTE_MS, u, r1)),
      '5h'
    );
    const total = events.reduce((sum, event) => sum + event.amount, 0);
    expect(total).toBeCloseTo(0.03, 9);
    expect(events).toHaveLength(2);
  });

  test('a reset that moves while its window is open counts only the rise', () => {
    const events = usageEvents(
      [reading(NOW - 10 * MINUTE_MS, 0.4, r1), reading(NOW, 0.42, r1 + 10 * MINUTE_MS)],
      '5h'
    );
    expect(events).toHaveLength(1);
    expect(events[0].amount).toBeCloseTo(0.02, 9);
  });

  test('reads only the requested window', () => {
    const weekly: QuotaHistorySample[] = [
      { t: NOW - HOUR_MS, authId: 'a', u5: 0.1, r5: r1, u7: 0.3, r7: NOW + DAY_MS },
      { t: NOW, authId: 'a', u5: 0.1, r5: r1, u7: 0.35, r7: NOW + DAY_MS },
    ];
    expect(usageEvents(weekly, '5h')).toEqual([]);
    expect(usageEvents(weekly, '7d')[0].amount).toBeCloseTo(0.05, 9);
  });
});

describe('observed burn', () => {
  // 'idle' (weight 1) uses nothing; 'busy' (weight 3) uses 40% of its window evenly over
  // the last hour, read every minute. Shares are 1/4 and 3/4, so the pool burns
  // 0.4 * 3/4 = 30% an hour during that hour and nothing before it.
  const grid = buildTimeGrid(NOW - 2 * HOUR_MS, NOW, 121);
  const reset = NOW + 2 * HOUR_MS;
  const busy: QuotaHistorySample[] = Array.from({ length: 61 }, (_, minute) => ({
    t: NOW - HOUR_MS + minute * MINUTE_MS,
    authId: 'busy',
    u5: (0.4 * minute) / 60,
    r5: reset,
  }));
  const data: ChartData = {
    times: grid,
    positions: grid.map((time) => axisPosition(grid, time)),
    series: [
      { account: account('idle', 0), values: grid.map(() => 0.5), weight: 1, pooled: true },
      { account: account('busy', 1), values: grid.map(() => 0.5), weight: 3, pooled: true },
    ],
    dots: [],
    resetTicks: [],
  };
  const burn = buildBurn({
    data,
    samples: new Map([['busy', busy]]),
    kind: '5h',
    lineWindowMs: 30 * MINUTE_MS,
  });

  test('is measured in shares of the chart, weighted like its stack', () => {
    expect(seriesShares(data.series)).toEqual([0.25, 0.75]);
    expect(burn.values[burn.values.length - 1]).toBeCloseTo(0.3, 9);
    // 90 minutes before now the trailing half hour holds no use.
    expect(burn.values[30]).toBe(0);
  });

  test('summarizes now, the half hour before it and the 5h average', () => {
    expect(burn.now).toBeCloseTo(0.3, 9);
    expect(burn.before).toBeCloseTo(0.3, 9);
    expect(burn.average).toBeCloseTo(0.06, 9);
  });

  test('marks the observed peak', () => {
    expect(burn.peakIndex).not.toBeNull();
    expect(burn.values[burn.peakIndex ?? 0]).toBeCloseTo(0.3, 9);
    expect(grid[burn.peakIndex ?? 0]).toBeGreaterThanOrEqual(NOW - 30 * MINUTE_MS);
  });

  test('has no value where no account has data, and no peak when nothing was used', () => {
    const quiet = buildBurn({
      data: {
        ...data,
        series: data.series.map((entry) => ({ ...entry, values: grid.map(() => null) })),
      },
      samples: new Map(),
      kind: '5h',
      lineWindowMs: 30 * MINUTE_MS,
    });
    expect(quiet.values.every((value) => value === null)).toBe(true);
    expect(quiet.peakIndex).toBeNull();
    expect(quiet.now).toBe(0);
  });
});

describe('projected burn', () => {
  test('is the rate the simulation serves, and 0 once the pool is dry', () => {
    const list = [projection('a', 0.5, 0.2)];
    const pool = simulate(list, { now: NOW, horizonMs: 5 * HOUR_MS });
    const data = tailChart(list, pool);
    const tail = tailOf(
      data,
      buildBurn({ data, samples: new Map(), kind: '5h', lineWindowMs: 30 * MINUTE_MS, pool })
    );
    expect(pool.emptyAt).toBe(NOW + 2.5 * HOUR_MS);
    const before = tail.filter(({ time }) => time <= NOW + 2.4 * HOUR_MS);
    const after = tail.filter(({ time }) => time >= NOW + 2.6 * HOUR_MS);
    expect(before.length).toBeGreaterThan(0);
    before.forEach(({ value }) => expect(value ?? NaN).toBeCloseTo(0.2, 6));
    after.forEach(({ value }) => expect(value).toBe(0));
  });

  test('load moving to another account keeps the pool burning at the same pace', () => {
    // 'a' runs dry after 30 minutes and its load moves to 'b', which then burns twice as
    // fast; the pool, half each, keeps burning 20% an hour until 'b' runs dry too.
    const list = [projection('a', 0.1, 0.2), projection('b', 1, 0.2)];
    const pool = simulate(list, { now: NOW, horizonMs: 5 * HOUR_MS });
    const data = tailChart(list, pool);
    const tail = tailOf(
      data,
      buildBurn({ data, samples: new Map(), kind: '5h', lineWindowMs: 30 * MINUTE_MS, pool })
    );
    expect(pool.emptyAt).toBe(NOW + 2.75 * HOUR_MS);
    tail
      .filter(({ time }) => time <= NOW + 2.7 * HOUR_MS)
      .forEach(({ value }) => expect(value ?? NaN).toBeCloseTo(0.2, 6));
  });

  test('a projected block moves capacity without counting as use', () => {
    // 'a' is blocked from +1h to +2h (its weekly window projected dry): its 5h capacity
    // reads 0 there, but the pool still serves the same load, all on 'b'.
    const run = simulateRouting(
      [
        {
          authId: 'a',
          priority: 0,
          size: 1,
          projection: projection('a', 0.8, 0.1),
          blocks: [{ from: NOW + HOUR_MS, until: NOW + 2 * HOUR_MS }],
        },
        { authId: 'b', priority: 0, size: 1, projection: projection('b', 0.8, 0.1), blocks: [] },
      ],
      '5h',
      NOW,
      5 * HOUR_MS
    );
    const pool = poolOf(run, ['a', 'b']);
    const data = tailChart([projection('a', 0.8, 0.1), projection('b', 0.8, 0.1)], pool);
    const tail = tailOf(
      data,
      buildBurn({ data, samples: new Map(), kind: '5h', lineWindowMs: 30 * MINUTE_MS, pool })
    );
    const values = tail.map(({ value }) => value ?? 0);
    expect(Math.max(...values)).toBeCloseTo(0.1, 6);
    expect(Math.min(...values)).toBeCloseTo(0.1, 6);
  });

  test('the simulation records what each account served, never a refill', () => {
    const list = [{ ...projection('a', 0.05, 0.6), reset: NOW + 30 * MINUTE_MS }];
    const pool = simulate(list, { now: NOW, horizonMs: HOUR_MS });
    const taken = pool.taken.get('a') ?? [];
    expect(taken).toHaveLength(61);
    expect(taken[0]).toBe(0);
    // 5% at 60% an hour lasts 5 minutes, the load waits until the reset, then 30 more minutes.
    const total = taken.reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(0.05 + 0.6 * 0.5, 6);
    // Waiting load is a rate, not a backlog: no step serves more than a minute's worth.
    expect(Math.max(...taken)).toBeCloseTo(0.6 / 60, 9);
  });
});

describe('burn helpers', () => {
  test('the line window is the base or two grid steps, whichever is longer', () => {
    expect(burnLineWindow('5h', 6 * HOUR_MS, 360)).toBe(30 * MINUTE_MS);
    expect(burnLineWindow('5h', 7 * DAY_MS, 360)).toBeCloseTo((2 * 7 * DAY_MS) / 359, 6);
    expect(burnLineWindow('7d', 14 * DAY_MS, 360)).toBe(6 * HOUR_MS);
    expect(burnLineWindow('7d', 56 * DAY_MS, 360)).toBeCloseTo((2 * 56 * DAY_MS) / 359, 6);
  });

  test('the strip top is round and so is its half', () => {
    const cases: Array<[number, number]> = [
      [0, 1],
      [-3, 1],
      [0.9, 1],
      [1, 1],
      [1.1, 2],
      [3, 4],
      [4.5, 5],
      [5.5, 6],
      [7, 8],
      [9, 10],
      [11, 20],
      [33, 40],
      [0.033, 0.04],
    ];
    cases.forEach(([value, top]) => expect(niceCeiling(value)).toBeCloseTo(top, 9));
    expect(['0', '2.5', '40', '0.25', '0.33']).toEqual(
      [0, 2.5, 40, 0.25, 1 / 3].map(formatAxisNumber)
    );
  });
});

describe('burn rendering', () => {
  const list = [projection('a', 0.5, 0.2)];
  const pool = simulate(list, { now: NOW, horizonMs: 5 * HOUR_MS });
  const data = tailChart(list, pool);
  const values = data.times.map((_, index) => (index > (data.splitIndex ?? 0) ? 20 : 12.5));
  const strip = {
    values,
    peakIndex: 10,
    label: 'Burn rate, % of pool per hour',
    name: 'Burn rate',
    format: (value: number) => `${value}%/h`,
  };
  const render = (mode: 'stacked' | 'multiples', activeIndex: number | null = null) =>
    renderToStaticMarkup(
      createElement(CapacityChart, {
        data,
        mode,
        xTicks: [],
        markers: [{ position: 0.6, tone: 'now' }],
        formatTime: (time: number) => new Date(time).toISOString(),
        ariaLabel: 'chart',
        defaultActiveIndex: activeIndex,
        burn: strip,
      })
    );

  test('the stacked chart draws the strip with its caption, scale and peak', () => {
    const markup = render('stacked');
    expect(markup).toContain('data-canvas="burn"');
    expect(markup).toContain('Burn rate, % of pool per hour');
    // Highest value 20, headroom 10%: the top is 40 and the middle 20.
    expect(markup).toContain('>40<');
    expect(markup).toContain('>20<');
    expect(markup).toContain('12.5%/h');
  });

  test('the tooltip reads the burn at the held point', () => {
    const markup = render('stacked', data.times.length - 1);
    const tooltip = markup.slice(markup.indexOf('role="status"'));
    expect(tooltip).toContain('Burn rate');
    expect(tooltip).toContain('20%/h');
  });

  test('the multiples layout has no strip', () => {
    const markup = render('multiples', 0);
    expect(markup).not.toContain('data-canvas="burn"');
    expect(markup).not.toContain('Burn rate');
  });

  test('the summary names the pace and the peak time', () => {
    const summary = (now: number, before: number, peakIndex: number | null) =>
      renderToStaticMarkup(
        createElement(BurnStats, {
          kind: '5h',
          burn: { values: [0, 0.3], peakIndex, now, before, average: 0.06 },
          times: [NOW - MINUTE_MS, NOW],
          formatRate: (value: number, signed?: boolean) =>
            `${signed && value > 0 ? '+' : ''}${Number(value.toFixed(1))}%/h`,
          formatTime: () => '11:59',
        })
      );
    const faster = summary(0.3, 0.2, 1);
    expect(faster).toContain('Burning now');
    expect(faster).toContain('30%/h');
    expect(faster).toContain('+10%/h');
    expect(faster).toContain('faster than the 30 min before');
    expect(faster).toContain('at 11:59');
    expect(faster).toContain('6%/h');
    expect(summary(0.2, 0.3, 1)).toContain('slower than the 30 min before');
    expect(summary(0.3, 0.3, 1)).toContain('same pace as the 30 min before');
    expect(summary(0, 0, null)).toContain('nothing used in this range');
  });

  test('the weekly summary reads per hour too', () => {
    const rates: number[] = [];
    const markup = renderToStaticMarkup(
      createElement(BurnStats, {
        kind: '7d',
        // 36% of the pool a day is 1.5% an hour.
        burn: { values: [0, 0.015], peakIndex: 1, now: 0.015, before: 0.01, average: 0.005 },
        times: [NOW - HOUR_MS, NOW],
        formatRate: (value: number) => {
          rates.push(value);
          return `${Number(value.toFixed(2))}%/h`;
        },
        formatTime: () => 'Thu 12:00',
      })
    );
    expect(rates.map((value) => Number(value.toFixed(6)))).toEqual([1.5, 0.5, 1.5, 0.5]);
    expect(markup).toContain('average of the last 24 hours');
    expect(markup).toContain('faster than the day before');
  });

  test('the weekly summary adds per day to now, change and average, never to the peak', () => {
    const render = (formatDaily?: (perHour: number, signed?: boolean) => string) =>
      renderToStaticMarkup(
        createElement(BurnStats, {
          kind: '7d',
          burn: { values: [0, 0.03], peakIndex: 1, now: 0.015, before: 0.01, average: 0.005 },
          times: [NOW - HOUR_MS, NOW],
          formatRate: (value: number, signed?: boolean) =>
            `${signed && value > 0 ? '+' : ''}${Number(value.toFixed(2))}%/h`,
          formatTime: () => 'Thu 12:00',
          formatDaily,
        })
      );
    const daily = render(
      (perHour: number, signed?: boolean) =>
        `${signed && perHour > 0 ? '+' : ''}${Number((perHour * 24).toFixed(1))}%/day`
    );
    // 1.5%/h is 36%/day, +0.5%/h is +12%/day, 0.5%/h is 12%/day; the 3%/h peak stays per hour.
    expect(daily.match(/%\/day/g)).toHaveLength(3);
    expect(daily).toContain('>36%/day<');
    expect(daily).toContain('>+12%/day<');
    expect(daily).toContain('>12%/day<');
    expect(daily).not.toContain('72%/day');
    expect(render()).not.toContain('/day');
  });
});
