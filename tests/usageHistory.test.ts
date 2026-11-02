import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { normalizeQuotaHistory } from '../src/services/api/quotaHistory';
import {
  HOUR_MS,
  accountsWithWeeklyReadings,
  buildAccounts,
  buildTimeGrid,
  capacity5h,
  capacity7d,
  hasFiveHourLimit,
  inPool,
  tierForPlan,
  TIER_CAPACITY_5H,
  buildWindows,
  capacityLeftAt,
  capacityLeftSeries,
  DAY_MS,
  groupSamplesByAccount,
  mergeSamples,
  thinSamples,
  withLead,
  type AccountInfo,
} from '../src/features/usageHistory/model';
import { buildPools } from '../src/features/usageHistory/pools';
import { buildCapacityChart } from '../src/features/usageHistory/chartData';
import {
  burnRate,
  MIN_WEEKLY_ELAPSED_MS,
  projectAccount,
  projectedLeftAt,
  simulatePool,
  type AccountProjection,
} from '../src/features/usageHistory/projection';
import {
  INITIAL_HISTORY_STATE,
  applyResponse,
  planFetch,
  quotaHistoryReducer,
} from '../src/features/usageHistory/historyCache';
import type { QuotaHistory, QuotaHistorySample } from '../src/services/api/quotaHistory';
import { NOW, SINCE, quotaHistoryResponse } from './fixtures/quotaHistory';
import { accountEmptyAt } from './helpers/usageHistoryPool';

const history = normalizeQuotaHistory(quotaHistoryResponse);
const byAccount = groupSamplesByAccount(history.samples);
const samplesOf = (authId: string) => byAccount.get(authId) ?? [];

const at = (value: string) => Date.parse(value);

describe('normalizeQuotaHistory', () => {
  test('keeps the fixture intact and converts times to epoch ms', () => {
    expect(history.accounts).toHaveLength(6);
    expect(history.samples.length).toBe(quotaHistoryResponse.samples.length);
    expect(history.since).toBe(SINCE);
    expect(history.until).toBe(NOW);
    const first = history.samples[0];
    expect(first.t).toBe(SINCE);
    expect(first.r5).toBe(at('2026-10-13T14:00:00Z'));
    // No `step` in the payload: raw samples.
    expect(history.step).toBe(0);
  });

  test('reads the effective step and orders same-second samples by reset', () => {
    const parsed = normalizeQuotaHistory({
      step: 900,
      samples: [
        { t: '2026-10-27T11:00:00Z', auth_id: 'a', u5: 0, r5: 1761580800 + 18000 },
        { t: '2026-10-27T11:00:00Z', auth_id: 'a', u5: 1, r5: 1761580800 },
      ],
    });
    expect(parsed.step).toBe(900);
    expect(parsed.samples.map((sample) => sample.u5)).toEqual([1, 0]);
    expect(normalizeQuotaHistory({ step: 'x' }).step).toBe(0);
    expect(normalizeQuotaHistory({ step: 1.5 }).step).toBe(0);
  });

  test('drops malformed entries and out-of-range fields from untrusted input', () => {
    const parsed = normalizeQuotaHistory({
      accounts: [
        { auth_id: '' },
        'x',
        { auth_id: 'a', label: '<b>x</b>', provider: 'Claude', disabled: 'true' },
        { auth_id: 'b', provider: 'claude', disabled: true },
      ],
      samples: [
        { t: 'not a time', auth_id: 'a', u5: 0.1 },
        { t: '2026-10-27T11:00:00Z', auth_id: '' },
        { t: '2026-10-27T11:00:00Z', auth_id: 'a', u5: 1.5, r5: 'soon', u7: 0.2, r7: 1 },
        { t: '2026-10-27T10:00:00Z', auth_id: 'a', u5: 0.3, r5: 1761580800, s5: ' Allowed ' },
      ],
      truncated: 'yes',
    });
    expect(parsed.accounts).toEqual([
      { authId: 'a', name: '', label: '<b>x</b>', provider: 'claude', disabled: false },
      { authId: 'b', name: '', label: '', provider: 'claude', disabled: true },
    ]);
    expect(parsed.samples).toEqual([
      { t: at('2026-10-27T10:00:00Z'), authId: 'a', u5: 0.3, r5: 1761580800000, s5: 'allowed' },
      { t: at('2026-10-27T11:00:00Z'), authId: 'a', u7: 0.2, r7: 1000 },
    ]);
    expect(parsed.truncated).toBe(false);
  });

  test('survives a non-object payload', () => {
    const parsed = normalizeQuotaHistory(null);
    expect(parsed.accounts).toEqual([]);
    expect(parsed.samples).toEqual([]);
  });
});

describe('buildAccounts', () => {
  test('orders by label, assigns slots and detects plans from the label', () => {
    const accounts = buildAccounts(history);
    expect(accounts.map((account) => account.label)).toEqual([
      'Alex Gmail',
      'Alex Max',
      'Alex NT team',
      'James team',
      'Kay team',
      'Pete team',
    ]);
    expect(accounts.map((account) => account.slot)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(accounts.map((account) => account.plan)).toEqual([
      'max',
      'max',
      'team',
      'team',
      'team',
      'team',
    ]);
  });

  test('keeps historical ids from samples', () => {
    const accounts = buildAccounts({
      accounts: [{ authId: 'x', name: 'x.json', label: '', provider: 'claude' }],
      samples: [{ t: 1, authId: 'gone' }],
    });
    expect(accounts).toEqual([
      {
        authId: 'gone',
        label: 'gone',
        tier: 'max_20x',
        plan: 'max',
        slot: 0,
        status: 'removed',
        fiveHourLimit: true,
      },
      {
        authId: 'x',
        label: 'x.json',
        tier: 'max_20x',
        plan: 'max',
        slot: 1,
        status: 'active',
        fiveHourLimit: true,
      },
    ]);
  });

  test('defaults a team label to a Team Premium seat and anything else to Max 20x', () => {
    const accounts = buildAccounts(history);
    expect(accounts.map((account) => account.tier)).toEqual([
      'max_20x',
      'max_20x',
      'team_premium',
      'team_premium',
      'team_premium',
      'team_premium',
    ]);
    // Pro = 1: a Max 20x window holds 3.2 Team Premium seats.
    expect(accounts.map(capacity5h)).toEqual([20, 20, 6.25, 6.25, 6.25, 6.25]);
    expect(TIER_CAPACITY_5H).toEqual({
      team_standard: 1.25,
      team_premium: 6.25,
      max_5x: 5,
      max_20x: 20,
    });
  });

  test('includes the idle account although it has no samples', () => {
    expect(samplesOf('claude-d4')).toHaveLength(0);
    expect(buildAccounts(history).some((account) => account.authId === 'claude-d4')).toBe(true);
  });
});

describe('windows', () => {
  test('groups 5h samples by reset with the final utilization before reset', () => {
    const windows = buildWindows('claude-b2', samplesOf('claude-b2'), '5h');
    // 13 Oct: the 09:00 window is caught mid-way, then two a day, plus the open one.
    expect(windows).toHaveLength(2 * 14 + 1);
    const morning = windows.find((w) => w.reset === at('2026-10-20T14:00:00Z'));
    const afternoon = windows.find((w) => w.reset === at('2026-10-20T20:00:00Z'));
    expect(morning?.start).toBe(at('2026-10-20T09:00:00Z'));
    expect(morning?.finalUtilization).toBe(0.8);
    expect(afternoon?.finalUtilization).toBe(0.4);
    expect(afternoon?.lastSampleAt).toBe(at('2026-10-20T19:50:00Z'));
  });

  test('7d windows carry the weekly final', () => {
    const windows = buildWindows('claude-e5', samplesOf('claude-e5'), '7d');
    expect(windows.map((w) => [new Date(w.reset).toISOString(), w.finalUtilization])).toEqual([
      ['2026-10-13T18:00:00.000Z', 0.92],
      ['2026-10-20T18:00:00.000Z', 0.85],
      ['2026-10-27T18:00:00.000Z', 0.6],
    ]);
  });

  test('ignores samples taken at or after their own reset', () => {
    const windows = buildWindows(
      'a',
      [
        { t: 10, authId: 'a', u5: 0.2, r5: 20 },
        { t: 20, authId: 'a', u5: 0.9, r5: 20 },
      ],
      '5h'
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].finalUtilization).toBe(0.2);
  });
});

describe('capacity left', () => {
  const alex = samplesOf('claude-a1');

  test('is unknown before the first sample and full with no window open', () => {
    expect(capacityLeftAt(alex, '5h', SINCE - 1)).toBeNull();
    expect(capacityLeftAt(alex, '5h', at('2026-10-20T08:00:00Z'))).toBe(1);
    expect(capacityLeftAt(samplesOf('claude-d4'), '5h', NOW)).toBeNull();
  });

  test('carries the last value forward and refills at the reset', () => {
    expect(capacityLeftAt(alex, '5h', at('2026-10-20T13:55:00Z'))).toBe(0);
    expect(capacityLeftAt(alex, '5h', at('2026-10-20T14:00:00Z'))).toBe(1);
    expect(capacityLeftAt(alex, '5h', at('2026-10-20T19:59:00Z'))).toBeCloseTo(0.4, 10);
    expect(capacityLeftAt(alex, '5h', NOW)).toBeCloseTo(0.55, 10);
  });

  test('the series walk agrees with point lookups', () => {
    const grid = buildTimeGrid(SINCE, NOW, 997);
    expect(grid[0]).toBe(SINCE);
    expect(grid[grid.length - 1]).toBe(NOW);
    const series = capacityLeftSeries(alex, '5h', grid);
    grid.forEach((time, index) => {
      expect(series[index]).toBe(capacityLeftAt(alex, '5h', time));
    });
    const weekly = capacityLeftSeries(alex, '7d', grid);
    grid.forEach((time, index) => {
      expect(weekly[index]).toBe(capacityLeftAt(alex, '7d', time));
    });
  });
});

describe('projection', () => {
  test('burn rate is the slope over the last 30 minutes of the open window', () => {
    expect(burnRate(samplesOf('claude-a1'), '5h', NOW)).toBeCloseTo(0.15, 3);
    expect(burnRate(samplesOf('claude-b2'), '5h', NOW)).toBeCloseTo(0.25, 3);
    expect(burnRate(samplesOf('claude-d4'), '5h', NOW)).toBe(0);
    // Right after a reset there are fewer than two samples in the new window.
    expect(burnRate(samplesOf('claude-a1'), '5h', at('2026-10-26T09:12:00Z'))).toBe(0);
  });

  test('per-account projection against the next reset', () => {
    const alex = projectAccount('claude-a1', samplesOf('claude-a1'), '5h', NOW);
    expect(alex.left).toBeCloseTo(0.55, 10);
    expect(alex.reset).toBe(NOW + 2 * HOUR_MS);
    expect(alex.rate).toBeCloseTo(0.15, 3);
    // Just before the reset, draining alone: 0.55 - 0.15 * 2.
    expect(projectedLeftAt(alex, '5h', NOW, NOW + 2 * HOUR_MS - 1)).toBeCloseTo(0.25, 3);

    const james = projectAccount('claude-b2', samplesOf('claude-b2'), '5h', NOW);
    expect(james.rate).toBeCloseTo(0.25, 3);
    expect(projectedLeftAt(james, '5h', NOW, (james.reset ?? NOW) - 1)).toBe(0);

    const pete = projectAccount('claude-d4', samplesOf('claude-d4'), '5h', NOW);
    expect(pete).toMatchObject({ left: null, rate: 0, reset: null });
  });

  test('weekly rate is the open window average, not a slope through a burst', () => {
    // Window opened 96 hours ago; 40% used in one 8-hour session three days ago, idle since.
    const reset = NOW + 3 * 24 * HOUR_MS;
    const opened = reset - 7 * 24 * HOUR_MS;
    const burstStart = NOW - 72 * HOUR_MS;
    const burst = Array.from({ length: 17 }, (_, k) => ({
      t: burstStart + k * 30 * 60 * 1000,
      authId: 'x',
      u7: (0.4 * k) / 16,
      r7: reset,
    }));
    expect(opened).toBe(NOW - 96 * HOUR_MS);
    const projection = projectAccount('x', burst, '7d', NOW);
    expect(projection.left).toBeCloseTo(0.6, 10);
    expect(projection.rate).toBeCloseTo(0.4 / 96, 10);
    // The slope through the burst would be 0.05/h: empty in 12 hours, not 144.
    expect(projectedLeftAt(projection, '7d', NOW, NOW + 12 * HOUR_MS)).toBeCloseTo(0.55, 6);
    expect(projectAccount('x', burst, '7d', reset + 1).rate).toBe(0);
  });

  test('weekly rate right after a reset spreads the usage over at least a day', () => {
    expect(MIN_WEEKLY_ELAPSED_MS).toBe(24 * HOUR_MS);
    const opened = NOW - 60 * 1000;
    const reset = opened + 7 * 24 * HOUR_MS;
    const fresh = projectAccount('x', [{ t: NOW, authId: 'x', u7: 0.02, r7: reset }], '7d', NOW);
    // Unfloored this would be 1.2/h: drawn empty within the hour, 0% at the next reset.
    expect(fresh.rate).toBeCloseTo(0.02 / 24, 12);
    // About 0.98 - 0.02 / 24 * 168 = 0.84 left just before the reset: a week at a day's average.
    const beforeReset = projectedLeftAt(fresh, '7d', NOW, reset - 1) ?? 0;
    expect(beforeReset).toBeCloseTo(0.98 - ((0.02 / 24) * (reset - NOW)) / HOUR_MS, 6);
    expect(beforeReset).toBeGreaterThan(0.8);

    const later = NOW - 72 * HOUR_MS + 7 * 24 * HOUR_MS;
    const steady = projectAccount('y', [{ t: NOW, authId: 'y', u7: 0.4, r7: later }], '7d', NOW);
    expect(steady.rate).toBeCloseTo(0.4 / 72, 12);
    // No open window still means no burn.
    expect(projectAccount('z', [], '7d', NOW).rate).toBe(0);
  });

  test('projected series drains, refills at the reset and keeps draining', () => {
    const kay = projectAccount('claude-c3', samplesOf('claude-c3'), '5h', NOW);
    expect(projectedLeftAt(kay, '5h', NOW, NOW + HOUR_MS)).toBeCloseTo(0.6, 3);
    expect(projectedLeftAt(kay, '5h', NOW, NOW + 2 * HOUR_MS)).toBe(1);
    expect(projectedLeftAt(kay, '5h', NOW, NOW + 3 * HOUR_MS)).toBeCloseTo(0.9, 3);
    const james = projectAccount('claude-b2', samplesOf('claude-b2'), '5h', NOW);
    expect(projectedLeftAt(james, '5h', NOW, NOW + 1.5 * HOUR_MS)).toBe(0);
  });
});

const projection = (
  authId: string,
  left: number,
  rate: number,
  reset: number | null
): AccountProjection => ({
  authId,
  left,
  rate,
  reset,
  blockedUntil: null,
});

describe('no data and weekly blocks', () => {
  const r5 = NOW + 4 * HOUR_MS;
  const r7 = NOW + 2 * HOUR_MS;
  // Every 30 minutes over the last four hours.
  const grid = buildTimeGrid(NOW - 4 * HOUR_MS, NOW, 9);

  test('an account first seen mid-range is null before its first sample and read after', () => {
    const late: QuotaHistorySample[] = [
      { t: NOW - 2 * HOUR_MS, authId: 'n', u5: 0.3, r5, u7: 0.1, r7: NOW + 3 * DAY_MS },
      { t: NOW - HOUR_MS, authId: 'n', u5: 0.4, r5, u7: 0.12, r7: NOW + 3 * DAY_MS },
    ];
    expect(capacityLeftSeries(late, '5h', grid)).toEqual([
      null,
      null,
      null,
      null,
      0.7,
      0.7,
      0.6,
      0.6,
      0.6,
    ]);
    expect(capacityLeftSeries(late, '7d', grid).slice(0, 4)).toEqual([null, null, null, null]);
    expect(capacityLeftSeries(late, '7d', grid)[4]).toBeCloseTo(0.9, 10);
    grid.forEach((time, index) =>
      expect(capacityLeftSeries(late, '5h', grid)[index]).toBe(capacityLeftAt(late, '5h', time))
    );
  });

  test('the weekly samples lead an account idle through the 5h range in, not as unseen', () => {
    // Last used yesterday; nothing in the 5h request.
    const weekly: QuotaHistorySample[] = [
      { t: NOW - DAY_MS, authId: 'p', u5: 0.6, r5: NOW - DAY_MS + HOUR_MS, u7: 0.3, r7 },
    ];
    expect(capacityLeftSeries([], '5h', grid).every((value) => value === null)).toBe(true);
    const led = withLead([], weekly);
    expect(capacityLeftSeries(led, '5h', grid).every((value) => value === 1)).toBe(true);
    expect(projectAccount('p', led, '5h', NOW)).toMatchObject({ left: 1, reset: null });
    // Only the lead before the first fine sample is used.
    const fine: QuotaHistorySample[] = [{ t: NOW - HOUR_MS, authId: 'p', u5: 0.1, r5 }];
    const overlap = { ...weekly[0], t: NOW - 30 * 60 * 1000 };
    expect(withLead(fine, [...weekly, overlap])).toEqual([weekly[0], fine[0]]);
    expect(withLead(fine, [])).toBe(fine);
  });

  test('an account with no samples is null throughout and has no projection', () => {
    expect(capacityLeftSeries([], '5h', grid).every((value) => value === null)).toBe(true);
    expect(capacityLeftSeries([], '7d', grid).every((value) => value === null)).toBe(true);
    const none = projectAccount('z', [], '5h', NOW);
    expect(none).toMatchObject({ left: null, rate: 0, reset: null, blockedUntil: null });
    expect(projectedLeftAt(none, '5h', NOW, NOW + HOUR_MS)).toBeNull();
  });

  test('a weekly-exhausted account has no 5h capacity until r7, then its 5h reading again', () => {
    const blocked: QuotaHistorySample[] = [
      { t: NOW - 3 * HOUR_MS, authId: 'w', u5: 0.1, r5, u7: 0.9, r7 },
      { t: NOW - HOUR_MS, authId: 'w', u5: 0.2, r5, u7: 1, r7, s7: 'rejected' },
    ];
    expect(capacityLeftAt(blocked, '5h', NOW - 2 * HOUR_MS)).toBeCloseTo(0.9, 10);
    expect(capacityLeftAt(blocked, '5h', NOW)).toBe(0);
    expect(capacityLeftAt(blocked, '5h', r7 - 1)).toBe(0);
    expect(capacityLeftAt(blocked, '5h', r7)).toBeCloseTo(0.8, 10);
    // Past the 5h reset as well: full again.
    expect(capacityLeftAt(blocked, '5h', r5)).toBe(1);
    expect(capacityLeftAt(blocked, '7d', NOW)).toBe(0);
    const series = capacityLeftSeries(blocked, '5h', grid);
    grid.forEach((time, index) => expect(series[index]).toBe(capacityLeftAt(blocked, '5h', time)));
    expect(series.slice(6)).toEqual([0, 0, 0]);

    const p5 = projectAccount('w', blocked, '5h', NOW);
    expect(p5.left).toBeCloseTo(0.8, 10);
    expect(p5.blockedUntil).toBe(r7);
    expect(projectedLeftAt(p5, '5h', NOW, NOW)).toBe(0);
    expect(projectedLeftAt(p5, '5h', NOW, NOW + HOUR_MS)).toBe(0);
    expect(projectedLeftAt(p5, '5h', NOW, r7)).toBeCloseTo(0.8, 10);
    expect(projectAccount('w', blocked, '7d', NOW).blockedUntil).toBeNull();
    // Once r7 passes the block is over.
    expect(projectAccount('w', blocked, '5h', r7).blockedUntil).toBeNull();
  });

  test('a rejected weekly status blocks below 100%, an allowed one at 99% does not', () => {
    const rejected: QuotaHistorySample[] = [
      { t: NOW - HOUR_MS, authId: 'w', u5: 0.2, r5, u7: 0.99, r7, s7: 'rejected' },
    ];
    expect(capacityLeftAt(rejected, '5h', NOW)).toBe(0);
    const allowed: QuotaHistorySample[] = [
      { t: NOW - HOUR_MS, authId: 'w', u5: 0.2, r5, u7: 0.99, r7, s7: 'allowed_warning' },
    ];
    expect(capacityLeftAt(allowed, '5h', NOW)).toBeCloseTo(0.8, 10);
    // A later weekly reading that is no longer exhausted lifts the block.
    const lifted: QuotaHistorySample[] = [
      { t: NOW - 2 * HOUR_MS, authId: 'w', u5: 0.2, r5, u7: 1, r7: NOW - HOUR_MS },
      { t: NOW - 30 * 60 * 1000, authId: 'w', u5: 0.2, r5, u7: 0.01, r7: NOW + 7 * DAY_MS },
    ];
    expect(capacityLeftAt(lifted, '5h', NOW - 90 * 60 * 1000)).toBe(0);
    expect(capacityLeftAt(lifted, '5h', NOW)).toBeCloseTo(0.8, 10);
  });
});

describe('pooled 5h simulation', () => {
  const FIVE_H = 5 * HOUR_MS;

  test('spreads the combined burn over accounts with capacity, then onto idle ones', () => {
    const pool = simulatePool(
      [projection('a', 0.5, 1, NOW + 4 * HOUR_MS), projection('b', 0.9, 0, NOW + 4 * HOUR_MS)],
      NOW,
      FIVE_H
    );
    expect(pool.demand).toBe(1);
    expect(pool.total).toHaveLength(301);
    // 'a' carries the whole 1.0/h until it runs dry at 30 minutes; 'b' then takes it.
    expect(accountEmptyAt(pool, 'a')).toBe(NOW + 30 * 60 * 1000);
    expect(accountEmptyAt(pool, 'b')).toBe(NOW + 1.4 * HOUR_MS);
    expect(pool.emptyAt).toBe(NOW + 1.4 * HOUR_MS);
    expect(pool.total[83]).toBeGreaterThan(0);
    expect(pool.total[84]).toBe(0);
    // Both refill at 4h and drain again at the same combined rate.
    expect(pool.total[240]).toBe(2);
    expect(pool.values.get('a')?.[300]).toBeCloseTo(0, 10);
    expect(pool.values.get('b')?.[300]).toBeCloseTo(1, 10);
    expect(pool.breakpoints).toContain(NOW + 30 * 60 * 1000);
    expect(pool.breakpoints).toContain(NOW + 1.4 * HOUR_MS);
  });

  test('splits equally when every account left measures no burn', () => {
    const pool = simulatePool(
      [projection('a', 0.2, 0.3, null), projection('b', 1, 0, null), projection('c', 1, 0, null)],
      NOW,
      FIVE_H
    );
    // 'a' is dry at 40 minutes; 'b' and 'c' then take 0.15/h each.
    expect(accountEmptyAt(pool, 'a')).toBe(NOW + 40 * 60 * 1000);
    expect(pool.values.get('b')?.[39]).toBe(1);
    expect(pool.values.get('b')?.[100]).toBeCloseTo(1 - 0.15, 10);
    expect(pool.values.get('c')?.[100]).toBeCloseTo(1 - 0.15, 10);
    // 2.2 at 0.3/h lasts past the horizon.
    expect(pool.emptyAt).toBeNull();
    expect(pool.nextRefill).toBeNull();
  });

  test('counts demand in absolute capacity: a bigger window drains slower per unit', () => {
    // 'a' holds 1 unit, 'm' 3. 'a' burns 1.0/h of its window (1 unit/h), 'm' 0.5/h (1.5).
    const size = new Map([
      ['a', 1],
      ['m', 3],
    ]);
    const pool = simulatePool(
      [projection('a', 0.5, 1, null), projection('m', 1, 0.5, null)],
      NOW,
      FIVE_H,
      (authId) => size.get(authId) ?? 1
    );
    expect(pool.demand).toBe(2.5);
    expect(pool.capacity).toBe(4);
    // Each takes its own measured share until 'a' is dry at 30 minutes.
    expect(accountEmptyAt(pool, 'a')).toBe(NOW + 30 * 60 * 1000);
    expect(pool.values.get('m')?.[30]).toBeCloseTo(0.75, 10);
    // Then 'm' carries all 2.5 units/h: 2.25 units last 54 minutes, 0.833 of its window
    // per hour. Counted as shares of its own window it would take 1.5/h and empty at 60.
    expect(pool.values.get('m')?.[57]).toBeCloseTo(0.375, 10);
    expect(pool.emptyAt).toBe(NOW + 84 * 60 * 1000);
  });

  test('splits equally in absolute capacity when every account left measures no burn', () => {
    const size = new Map([['c', 4]]);
    const pool = simulatePool(
      [projection('a', 0.2, 0.3, null), projection('b', 1, 0, null), projection('c', 1, 0, null)],
      NOW,
      FIVE_H,
      (authId) => size.get(authId) ?? 1
    );
    // 'a' is dry at 40 minutes; 'b' and 'c' then take 0.15 units/h each, which is
    // 0.15/h of 'b' but only 0.0375/h of 'c', four times the size.
    expect(accountEmptyAt(pool, 'a')).toBe(NOW + 40 * 60 * 1000);
    expect(pool.values.get('b')?.[100]).toBeCloseTo(1 - 0.15, 10);
    expect(pool.values.get('c')?.[100]).toBeCloseTo(1 - 0.0375, 10);
  });

  test('a refill inside the horizon keeps the pool alive', () => {
    const trio = ['claude-a1', 'claude-b2', 'claude-c3'].map((id) =>
      projectAccount(id, samplesOf(id), '5h', NOW)
    );
    // 1.5 left at 0.5/h would be dry at 3h, but all three refill at 2h.
    const pool = simulatePool(trio, NOW, FIVE_H);
    expect(pool.emptyAt).toBeNull();
    expect(pool.nextRefill).toBe(NOW + 2 * HOUR_MS);
    // James: 0.25 left at the fitted ~0.25/h, dry after about an hour.
    expect(
      Math.abs((accountEmptyAt(pool, 'claude-b2') ?? 0) - (NOW + HOUR_MS))
    ).toBeLessThanOrEqual(60 * 1000);
    expect(accountEmptyAt(pool, 'claude-a1')).toBeNull();
    expect(Math.min(...pool.total)).toBeGreaterThan(0);
  });

  test('an account with no reading is not pooled: no capacity, no demand', () => {
    const unseen = { ...projection('n', 1, 0.5, null), left: null };
    const pool = simulatePool([projection('a', 0.5, 1, NOW + 4 * HOUR_MS), unseen], NOW, FIVE_H);
    expect(pool.values.has('n')).toBe(false);
    expect(accountEmptyAt(pool, 'n')).toBeUndefined();
    expect(pool.demand).toBe(1);
    expect(pool.total[0]).toBe(0.5);
    expect(pool.emptyAt).toBe(NOW + 30 * 60 * 1000);
    expect(simulatePool([unseen], NOW, FIVE_H).emptyAt).toBeNull();
  });

  test('a weekly-blocked account takes nothing and rejoins at r7 with its 5h capacity', () => {
    const r7 = NOW + 2 * HOUR_MS;
    const near = (time: number | null | undefined, expected: number) =>
      expect(Math.abs((time ?? 0) - expected)).toBeLessThanOrEqual(60 * 1000);
    // 'w' holds 0.8 of its 5h window (u7 = 1); 'a' carries 0.6/h with 1.0 left.
    const blocked = { ...projection('w', 0.8, 0, NOW + 4 * HOUR_MS), blockedUntil: r7 };
    const pool = simulatePool([projection('a', 1, 0.6, null), blocked], NOW, FIVE_H);
    const w = pool.values.get('w') ?? [];
    expect(w[0]).toBe(0);
    expect(pool.total[0]).toBe(1);
    // Only 'a' can take requests now, so only it counts toward the capacity.
    expect(pool.capacity).toBe(1);
    expect(pool.demand).toBeCloseTo(0.6, 10);
    // Not drained while 'a' runs dry at 100 minutes and the pool sits empty.
    near(accountEmptyAt(pool, 'a'), NOW + 100 * 60 * 1000);
    near(pool.emptyAt, NOW + 100 * 60 * 1000);
    expect(w[119]).toBe(0);
    // Rejoins at r7 with its untouched 0.8, then carries the 0.6/h alone.
    expect(w[120]).toBeCloseTo(0.8, 10);
    expect(pool.total[120]).toBeCloseTo(0.8, 10);
    expect(w[150]).toBeCloseTo(0.8 - 0.3, 6);
    expect(pool.breakpoints).toContain(r7);
    expect(pool.nextRefill).toBe(r7);

    // Its 5h window resets during the block: it rejoins full.
    const refilled = simulatePool(
      [{ ...projection('w', 0.8, 0, NOW + HOUR_MS), blockedUntil: r7 }],
      NOW,
      FIVE_H
    );
    const row = refilled.values.get('w') ?? [];
    expect(row[60]).toBe(0);
    expect(row[119]).toBe(0);
    expect(row[120]).toBe(1);
  });

  test('an empty scope never runs dry and an exhausted one is dry now', () => {
    expect(simulatePool([], NOW, FIVE_H).emptyAt).toBeNull();
    const dry = simulatePool([projection('a', 0, 0.2, NOW + HOUR_MS)], NOW, FIVE_H);
    expect(dry.emptyAt).toBe(NOW);
  });
});

describe('accountsWithWeeklyReadings', () => {
  test('keeps an account at 0% weekly and drops one with 5h-only samples', () => {
    const account = (authId: string): AccountInfo => ({
      authId,
      label: authId,
      tier: 'max_20x',
      plan: 'max',
      slot: 0,
      status: 'active',
      fiveHourLimit: true,
    });
    const samples = new Map<string, QuotaHistorySample[]>([
      ['max', [{ t: NOW, authId: 'max', u5: 0.2, r5: NOW + HOUR_MS, u7: 0, r7: NOW + DAY_MS }]],
      ['team', [{ t: NOW, authId: 'team', u5: 0.5, r5: NOW + HOUR_MS }]],
      ['none', []],
    ]);
    const kept = accountsWithWeeklyReadings(
      [account('max'), account('team'), account('none')],
      samples
    );
    expect(kept.map((item) => item.authId)).toEqual(['max']);
  });
});

describe('thinSamples', () => {
  const MIN = 60 * 1000;
  const sample = (t: number, u5: number, r5 = 100 * MIN): QuotaHistorySample => ({
    t,
    authId: 'a',
    u5,
    r5,
  });

  test('keeps the first sample, the last per bucket and both neighbours of a reset change', () => {
    const samples = [
      sample(0, 0.1),
      sample(5 * MIN, 0.2),
      sample(14 * MIN, 0.3),
      sample(16 * MIN, 0.4),
      sample(17 * MIN, 0, 300 * MIN),
      sample(20 * MIN, 0.1, 300 * MIN),
      sample(29 * MIN, 0.2, 300 * MIN),
    ];
    expect(thinSamples(samples, 15 * MIN, 0).map((s) => s.t / MIN)).toEqual([0, 14, 16, 17, 29]);
    expect(thinSamples(samples, 15 * MIN, 15 * MIN).map((s) => s.t / MIN)).toEqual([
      0, 5, 14, 16, 17, 29,
    ]);
    expect(thinSamples(samples, 0, 0)).toBe(samples);
    const thinned = thinSamples(samples, 15 * MIN, 0);
    expect(thinSamples(thinned, 15 * MIN, 0)).toEqual(thinned);
  });

  test("keeps a new account's first sample when it arrives in a refetched tail", () => {
    const samples = [
      sample(10 * MIN, 0.1),
      sample(20 * MIN, 0.2),
      { ...sample(31 * MIN, 0.05), authId: 'b' },
      { ...sample(40 * MIN, 0.1), authId: 'b' },
      sample(44 * MIN, 0.3),
    ];
    expect(thinSamples(samples, 15 * MIN, 30 * MIN).map((s) => [s.authId, s.t / MIN])).toEqual([
      ['a', 10],
      ['a', 20],
      ['b', 31],
      ['b', 40],
      ['a', 44],
    ]);
  });
});

describe('history cache', () => {
  const MIN = 60 * 1000;
  const response = (
    samples: QuotaHistorySample[],
    truncated = false,
    step = 900
  ): QuotaHistory => ({
    since: 0,
    until: samples.at(-1)?.t ?? 0,
    accounts: [],
    samples,
    truncated,
    step,
  });

  test('a tail refetch at the same step replaces the still-filling bucket without duplicates', () => {
    const first = applyResponse(
      null,
      response([
        { t: 10 * MIN, authId: 'a', u7: 0.1, r7: 1e9 },
        { t: 20 * MIN, authId: 'a', u7: 0.2, r7: 1e9 },
      ]),
      0,
      900,
      0
    );
    const plan = planFetch(first, 1 * MIN, 900);
    expect(plan.cached).toBe(first);
    expect(plan.fetchSince).toBe(15 * MIN);
    // The 15-30 minute bucket kept filling: its last sample is now at 29 minutes.
    const next = applyResponse(
      plan.cached,
      response([
        { t: 20 * MIN, authId: 'a', u7: 0.2, r7: 1e9 },
        { t: 29 * MIN, authId: 'a', u7: 0.3, r7: 1e9 },
        { t: 31 * MIN, authId: 'a', u7: 0.35, r7: 1e9 },
      ]),
      1 * MIN,
      900,
      plan.fetchSince
    );
    expect(next.history.samples.map((s) => s.t / MIN)).toEqual([10, 29, 31]);
    // A different step is a full fetch.
    expect(planFetch(next, 1 * MIN, 60)).toEqual({ cached: null, fetchSince: 1 * MIN });
    // So is a range that starts before the cache.
    expect(planFetch(next, 0, 900).cached).toBeNull();
  });

  test('the truncated flag follows the last full fetch, not every past tail', () => {
    const full = applyResponse(null, response([{ t: 0, authId: 'a' }], false), 0, 900, 0);
    const cappedTail = applyResponse(full, response([{ t: MIN, authId: 'a' }], true), 0, 900, 0);
    expect(cappedTail.history.truncated).toBe(true);
    const cleanTail = applyResponse(
      cappedTail,
      response([{ t: 2 * MIN, authId: 'a' }], false),
      0,
      900,
      0
    );
    expect(cleanTail.history.truncated).toBe(false);

    const cappedFull = applyResponse(null, response([{ t: 0, authId: 'a' }], true), 0, 900, 0);
    const afterCapped = applyResponse(
      cappedFull,
      response([{ t: MIN, authId: 'a' }], false),
      0,
      900,
      0
    );
    expect(afterCapped.history.truncated).toBe(true);
    expect(applyResponse(null, response([], false), 0, 900, 0).history.truncated).toBe(false);
  });

  test('a wider span keeps drawing the loaded span until its data arrives', () => {
    const DAY = 24 * HOUR_MS;
    const loaded = response([{ t: 0, authId: 'a', u5: 0.1, r5: 1e9 }]);
    const narrow = quotaHistoryReducer(INITIAL_HISTORY_STATE, {
      type: 'success',
      history: loaded,
      spanMs: 2 * DAY,
      fetchedAt: 1000,
    });
    expect(narrow).toMatchObject({ history: loaded, spanMs: 2 * DAY, loading: false });

    // The range grows to 7 days; the full fetch is pending.
    const pending = quotaHistoryReducer(narrow, { type: 'start' });
    expect(pending).toMatchObject({ history: loaded, spanMs: 2 * DAY, loading: true });
    // The chart's `from` is `now - spanMs`: still the old 48 hours.
    expect(pending.fetchedAt - pending.spanMs).toBe(1000 - 2 * DAY);
    // A failed fetch keeps the old data and its span.
    expect(quotaHistoryReducer(pending, { type: 'failure', error: 'x' })).toMatchObject({
      history: loaded,
      spanMs: 2 * DAY,
      loading: false,
      error: 'x',
    });

    const wide = response([{ t: 0, authId: 'a', u5: 0.2, r5: 1e9 }]);
    const arrived = quotaHistoryReducer(pending, {
      type: 'success',
      history: wide,
      spanMs: 7 * DAY,
      fetchedAt: 2000,
    });
    expect(arrived).toMatchObject({ history: wide, spanMs: 7 * DAY, loading: false });
    expect(quotaHistoryReducer(arrived, { type: 'reset', loading: true })).toEqual({
      ...INITIAL_HISTORY_STATE,
      loading: true,
    });
  });
});

describe('mergeSamples', () => {
  test('dedupes the refetched overlap and drops samples older than the range', () => {
    const cached = [
      { t: 1, authId: 'a', u5: 0.1 },
      { t: 5, authId: 'a', u5: 0.2 },
    ];
    const incoming = [
      { t: 5, authId: 'a', u5: 0.2 },
      { t: 5, authId: 'b', u5: 0.4 },
      { t: 9, authId: 'a', u5: 0.3 },
    ];
    expect(mergeSamples(cached, incoming, 2)).toEqual([
      { t: 5, authId: 'a', u5: 0.2 },
      { t: 5, authId: 'b', u5: 0.4 },
      { t: 9, authId: 'a', u5: 0.3 },
    ]);
  });

  test('keeps two same-second samples with different resets, the newest of identical ones', () => {
    const cached = [
      { t: 5000, authId: 'a', u5: 1, r5: 5000, u7: 0.4, r7: 9000 },
      { t: 6000, authId: 'a', u5: 0.1, r5: 23000, u7: 0.41, r7: 9000 },
    ];
    const incoming = [
      // Recorded in the same second as the cached sample, after the 5h window reset.
      { t: 5000, authId: 'a', u5: 0, r5: 23000, u7: 0.4, r7: 9000 },
      { t: 6000, authId: 'a', u5: 0.12, r5: 23000, u7: 0.41, r7: 9000 },
    ];
    expect(mergeSamples(cached, incoming, 0)).toEqual([
      { t: 5000, authId: 'a', u5: 1, r5: 5000, u7: 0.4, r7: 9000 },
      { t: 5000, authId: 'a', u5: 0, r5: 23000, u7: 0.4, r7: 9000 },
      { t: 6000, authId: 'a', u5: 0.12, r5: 23000, u7: 0.41, r7: 9000 },
    ]);
  });
});

describe('history request contract', () => {
  test('the hook leaves `until` to the proxy clock', () => {
    const hook = readFileSync(
      new URL('../src/features/usageHistory/hooks/useQuotaHistory.ts', import.meta.url),
      'utf8'
    );
    expect(hook).toContain('quotaHistoryApi.get({ since: fetchSince, step })');
    expect(hook).not.toContain('until:');
  });
});

describe('accounts out of the pool', () => {
  const FIVE_H = 5 * HOUR_MS;
  const account = (authId: string, status: AccountInfo['status']): AccountInfo => ({
    authId,
    label: authId,
    tier: 'max_20x',
    plan: 'max',
    slot: 0,
    status,
    fiveHourLimit: true,
  });

  test('buildAccounts reads disabled from the payload and removed from samples only', () => {
    const accounts = buildAccounts({
      accounts: [
        { authId: 'on', name: 'on.json', label: 'On', provider: 'claude', disabled: false },
        { authId: 'off', name: 'off.json', label: 'Off', provider: 'claude', disabled: true },
      ],
      samples: [{ t: 1, authId: 'gone' }],
    });
    expect(accounts.map((entry) => [entry.authId, entry.status])).toEqual([
      ['gone', 'removed'],
      ['off', 'disabled'],
      ['on', 'active'],
    ]);
  });

  test('pools leave a disabled account out', () => {
    const accounts = [account('on', 'active'), account('off', 'disabled')];
    const projections5 = new Map<string, AccountProjection>([
      ['on', projection('on', 1, 0.5, null)],
      ['off', projection('off', 1, 0, null)],
    ]);
    const pools = buildPools(accounts, projections5, 'all', NOW, FIVE_H);
    expect(pools.chart.values.has('on')).toBe(true);
    expect(pools.chart.values.has('off')).toBe(false);
    // 'on' alone drains at 0.5/h: dry in 2h, which 'off' would otherwise have stretched.
    expect(pools.chart.emptyAt).toBeCloseTo(NOW + 2 * HOUR_MS, -3);
  });

  test('the chart keeps history until the last reading resets, then no band and no tail', () => {
    const samples: QuotaHistorySample[] = [
      { t: NOW - 2 * HOUR_MS, authId: 'x', u5: 0.4, r5: NOW - HOUR_MS },
    ];
    const accounts = [account('on', 'active'), account('off', 'disabled')];
    const data = buildCapacityChart({
      accounts,
      samples: new Map([
        ['on', samples.map((sample) => ({ ...sample, authId: 'on' }))],
        ['off', samples.map((sample) => ({ ...sample, authId: 'off' }))],
      ]),
      windows: new Map(),
      kind: '5h',
      from: NOW - 3 * HOUR_MS,
      to: NOW,
      points: 7,
      tail: {
        horizonMs: FIVE_H,
        projections: new Map([
          ['on', projection('on', 1, 0, null)],
          ['off', projection('off', 1, 0, null)],
        ]),
      },
    });
    const [on, off] = data.series.map((entry) => entry.values);
    const split = data.splitIndex ?? 0;
    // Grid every 30 minutes from NOW-3h: the reading counts from NOW-2h until its NOW-1h reset.
    expect(on.slice(0, split + 1)).toEqual([null, null, 0.6, 0.6, 1, 1, 1]);
    expect(off.slice(0, split + 1)).toEqual([null, null, 0.6, 0.6, null, null, null]);
    expect(off.slice(split + 1).every((value) => value === null)).toBe(true);
    expect(on.slice(split + 1).every((value) => value !== null)).toBe(true);
    expect(data.resetTicks.some((tick) => tick.series === 1)).toBe(false);
  });
});

describe('plans renamed on 2026-10-30: Max and Ultra', () => {
  test('a plan picks the tier; a label only when there is none', () => {
    expect(
      tierForPlan({ organizationType: 'claude_max', rateLimitTier: 'default_claude_max_20x' })
    ).toBe('max_20x');
    expect(
      tierForPlan({ organizationType: 'claude_max', rateLimitTier: 'default_claude_max_5x' })
    ).toBe('max_5x');
    // Live Team Premium seats report the Max tier under their Team organization.
    expect(
      tierForPlan({ organizationType: 'claude_team', rateLimitTier: 'default_claude_max_5x' })
    ).toBe('team_premium');
    expect(
      tierForPlan({ organizationType: 'claude_team', rateLimitTier: 'default_claude_ai' })
    ).toBe('team_standard');
    expect(tierForPlan({ organizationType: 'claude_team', rateLimitTier: '' })).toBeNull();
    expect(
      tierForPlan({ organizationType: 'claude_pro', rateLimitTier: 'default_claude_ai' })
    ).toBeNull();
    expect(tierForPlan(undefined)).toBeNull();

    const accounts = buildAccounts({
      accounts: [
        {
          authId: 'personal',
          name: 'p.json',
          label: 'Alex team-ish',
          provider: 'claude',
          disabled: false,
          plan: { organizationType: 'claude_max', rateLimitTier: 'default_claude_max_5x' },
        },
        {
          authId: 'unknown',
          name: 'u.json',
          label: 'NT team',
          provider: 'claude',
          disabled: false,
        },
      ],
      samples: [],
    });
    const [personal, unknown] = accounts;
    expect([personal.tier, unknown.tier]).toEqual(['max_5x', 'team_premium']);
    expect(accounts.every((account) => account.fiveHourLimit)).toBe(true);
  });

  test('the history API carries the plan', () => {
    const history = normalizeQuotaHistory({
      accounts: [
        {
          auth_id: 'a',
          plan: { organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
        },
        { auth_id: 'b', plan: { organization_type: ' ', rate_limit_tier: '' } },
        { auth_id: 'c' },
      ],
      samples: [],
    });
    expect(history.accounts.map((account) => account.plan)).toEqual([
      { organizationType: 'claude_max', rateLimitTier: 'default_claude_max_20x' },
      undefined,
      undefined,
    ]);
  });

  test('weekly weights follow the published multiples of Pro', () => {
    expect(capacity7d({ tier: 'max_5x' })).toBe(5);
    expect(capacity7d({ tier: 'max_20x' })).toBe(10);
    expect(capacity5h({ tier: 'max_5x' })).toBe(5);
  });
});

describe('accounts without a 5h limit', () => {
  // The personal account's own pattern: the 5h window hit 100% on Oct 31, reset at 21:50,
  // and every response since Nov 1 carried the weekly window only.
  const reset5 = Date.parse('2026-10-31T21:50:00Z');
  const reset7 = Date.parse('2026-11-07T14:00:00Z');
  const ultra: QuotaHistorySample[] = [
    {
      t: Date.parse('2026-10-31T20:58:20Z'),
      authId: 'u',
      u5: 1,
      r5: reset5,
      u7: 0.17,
      r7: reset7,
      s5: 'rejected',
    },
    {
      t: Date.parse('2026-10-31T21:08:25Z'),
      authId: 'u',
      u5: 1,
      r5: reset5,
      u7: 0.17,
      r7: reset7,
      s5: 'rejected',
    },
    { t: Date.parse('2026-11-01T17:11:22Z'), authId: 'u', u7: 0.17, r7: reset7, s7: 'allowed' },
    { t: Date.parse('2026-11-02T11:04:56Z'), authId: 'u', u7: 0.28, r7: reset7 },
  ];

  test('a weekly-only response after the last 5h reset means no 5h window', () => {
    expect(hasFiveHourLimit(ultra)).toBe(false);
    // Weekly-only while the 5h window is still open: Anthropic left the 5h headers out.
    expect(hasFiveHourLimit(ultra.slice(0, 2).concat([{ ...ultra[3], t: reset5 - 60_000 }]))).toBe(
      true
    );
    // An exhausted weekly window says nothing about the 5h one.
    expect(hasFiveHourLimit(ultra.slice(0, 2).concat([{ ...ultra[3], u7: 1 }]))).toBe(true);
    expect(hasFiveHourLimit(ultra.slice(0, 2).concat([{ ...ultra[3], s7: 'rejected' }]))).toBe(
      true
    );
    // Weekly readings only, ever: no 5h window.
    expect(hasFiveHourLimit(ultra.slice(2))).toBe(false);
    // A later 5h reading brings the window back.
    const back = Date.parse('2026-11-02T12:00:00Z');
    expect(
      hasFiveHourLimit([...ultra, { t: back, authId: 'u', u5: 0.1, r5: back + 4 * HOUR_MS }])
    ).toBe(true);
    // Team accounts report 5h only; no samples at all says nothing.
    expect(hasFiveHourLimit([{ t: NOW, authId: 't', u5: 0.3, r5: NOW + HOUR_MS }])).toBe(true);
    expect(hasFiveHourLimit([])).toBe(true);
  });

  test('it leaves the 5h pools and ends its 5h line', () => {
    const at = Date.parse('2026-11-02T12:00:00Z');
    const account = (
      authId: string,
      tier: AccountInfo['tier'],
      fiveHourLimit: boolean
    ): AccountInfo => ({
      authId,
      label: authId,
      tier,
      plan: tier.startsWith('team') ? 'team' : 'max',
      slot: 0,
      status: 'active',
      fiveHourLimit,
    });
    const accounts = [account('u', 'max_20x', false), account('t', 'team_premium', true)];
    expect(accounts.map((entry) => [inPool(entry, '5h'), inPool(entry, '7d')])).toEqual([
      [false, true],
      [true, true],
    ]);
    const atProjection = (
      authId: string,
      left: number,
      rate: number,
      reset: number
    ): AccountProjection => ({
      authId,
      left,
      rate,
      reset,
      blockedUntil: null,
    });
    // Its 5h reading reset on Oct 31, so the 5h projection reads it as full.
    const projections5 = new Map<string, AccountProjection>([
      ['u', { ...atProjection('u', 1, 0, at + HOUR_MS), reset: null }],
      ['t', atProjection('t', 0.5, 0.1, at + 3 * HOUR_MS)],
    ]);
    const pools = buildPools(accounts, projections5, 'all', at, 5 * HOUR_MS);
    for (const pool of [pools.team, pools.chart]) expect(pool.values.has('u')).toBe(false);
    expect(pools.chart.capacity).toBe(TIER_CAPACITY_5H.team_premium);

    const data = buildCapacityChart({
      accounts: [accounts[0]],
      samples: new Map([['u', ultra]]),
      windows: new Map(),
      kind: '5h',
      from: Date.parse('2026-10-31T20:00:00Z'),
      to: at,
      points: 41,
      tail: { horizonMs: 5 * HOUR_MS, projections: projections5, pool: pools.chart },
    });
    const [line] = data.series;
    expect(line.pooled).toBe(false);
    const after = data.times.findIndex((time) => time >= reset5);
    expect(line.values.slice(after).every((value) => value === null)).toBe(true);
    expect(line.values.slice(0, after).some((value) => value !== null)).toBe(true);
  });
});
