/**
 * Runway projection.
 *
 * Burn rate per window kind: 5h is the least-squares slope of capacity left over the
 * last 30 minutes of the open window; 7d is the open window's average, utilization
 * over the hours since it opened, at least `MIN_WEEKLY_ELAPSED_MS` (samples only exist
 * during use, so a slope through them would overstate an account that burst and went
 * idle, and minutes into a window a few percent would read as a week's burn per day).
 *
 * The weekly tail drains each account on its own and refills at each known reset.
 * The 5h tail models the pool the way the proxy routes: `simulatePool`. Rates are shares
 * of the account's own window, so the pool converts them through each account's capacity.
 *
 * An account with no reading yet has no projection value (`left` is null): it is not
 * drawn and not pooled. A weekly-exhausted account has no 5h capacity until its r7.
 */

import type { QuotaHistorySample } from '@/services/api/quotaHistory';
import {
  HOUR_MS,
  MINUTE_MS,
  WINDOW_SPAN_MS,
  latestReading,
  readWindow,
  weeklyBlockAt,
  type WindowKind,
} from './model';

export const BURN_LOOKBACK_MS = 30 * MINUTE_MS;
/** The weekly average spreads what is used over at least this long. */
export const MIN_WEEKLY_ELAPSED_MS = 24 * HOUR_MS;

/** Slope of capacity left over the lookback, per hour (0..1 per hour); 0 when unknown. */
export function burnRate(
  samples: QuotaHistorySample[],
  kind: WindowKind,
  now: number,
  lookbackMs: number = BURN_LOOKBACK_MS
): number {
  const current = latestReading(samples, kind, now);
  if (!current || now >= current.r) return 0;

  const points: Array<{ x: number; y: number }> = [];
  samples.forEach((sample) => {
    if (sample.t > now || sample.t < now - lookbackMs) return;
    const reading = readWindow(sample, kind);
    // Only the current window: a reset inside the lookback would read as a refill.
    if (!reading || Math.abs(reading.r - current.r) > MINUTE_MS) return;
    points.push({ x: sample.t / HOUR_MS, y: 1 - reading.u });
  });
  if (points.length < 2) return 0;

  const meanX = points.reduce((total, point) => total + point.x, 0) / points.length;
  const meanY = points.reduce((total, point) => total + point.y, 0) / points.length;
  let numerator = 0;
  let denominator = 0;
  points.forEach((point) => {
    numerator += (point.x - meanX) * (point.y - meanY);
    denominator += (point.x - meanX) ** 2;
  });
  if (denominator === 0) return 0;
  return Math.max(0, -numerator / denominator);
}

/**
 * Utilization of the open window over the hours since it opened, at least
 * `minElapsedMs`; 0 with no open window.
 */
export function windowAverageRate(
  samples: QuotaHistorySample[],
  kind: WindowKind,
  now: number,
  minElapsedMs: number = MIN_WEEKLY_ELAPSED_MS
): number {
  const current = latestReading(samples, kind, now);
  if (!current || now >= current.r) return 0;
  const elapsed = Math.max(now - (current.r - WINDOW_SPAN_MS[kind]), minElapsedMs);
  return elapsed > 0 ? current.u / (elapsed / HOUR_MS) : 0;
}

export interface AccountProjection {
  authId: string;
  /** Capacity left now, 0..1; null when the account has no reading yet. */
  left: number | null;
  /** Capacity consumed per hour. */
  rate: number;
  /** Reset of the open window, epoch ms; null when no window is open. */
  reset: number | null;
  hoursToReset: number | null;
  /** Hours until empty at the current rate, on its own; Infinity when not draining. */
  emptyInHours: number;
  /** `max(0, left - rate * hoursToReset)`; null when no window is open. */
  projectedLeftover: number | null;
  /**
   * 5h only: the weekly reset (r7) while the latest weekly reading is exhausted. Until
   * then the account takes no requests, whatever `left` says; null when not blocked.
   */
  blockedUntil: number | null;
}

export function projectAccount(
  authId: string,
  samples: QuotaHistorySample[],
  kind: WindowKind,
  now: number
): AccountProjection {
  const current = latestReading(samples, kind, now);
  const open = current !== null && now < current.r;
  const left = current === null ? null : open ? 1 - current.u : 1;
  const rate = !open
    ? 0
    : kind === '7d'
      ? windowAverageRate(samples, kind, now)
      : burnRate(samples, kind, now);
  const reset = open ? current.r : null;
  const hoursToReset = reset === null ? null : (reset - now) / HOUR_MS;
  return {
    authId,
    left,
    rate,
    reset,
    hoursToReset,
    emptyInHours: left !== null && rate > 0 ? left / rate : Number.POSITIVE_INFINITY,
    projectedLeftover:
      left === null || hoursToReset === null ? null : Math.max(0, left - rate * hoursToReset),
    blockedUntil: kind === '5h' ? weeklyBlockAt(samples, now) : null,
  };
}

/**
 * Projected capacity left at a future instant, draining alone and refilling at each
 * reset; 0 while weekly-blocked, null with no reading.
 */
export function projectedLeftAt(
  projection: AccountProjection,
  kind: WindowKind,
  now: number,
  time: number
): number | null {
  const { left, reset, rate, blockedUntil } = projection;
  if (left === null) return null;
  if (blockedUntil !== null && time < blockedUntil) return 0;
  if (time <= now) return left;
  if (reset === null || time < reset) {
    return Math.max(0, left - (rate * (time - now)) / HOUR_MS);
  }
  const span = WINDOW_SPAN_MS[kind];
  const lastReset = reset + Math.floor((time - reset) / span) * span;
  return Math.max(0, 1 - (rate * (time - lastReset)) / HOUR_MS);
}

/** Capacity below this is treated as empty, so float residue does not keep an account alive. */
const EMPTY_EPSILON = 1e-9;
export const POOL_STEP_MS = MINUTE_MS;

export interface PoolSimulation {
  /** Simulation start (now), epoch ms; values sit at `start + k * stepMs`. */
  start: number;
  stepMs: number;
  /**
   * Usable capacity left per pooled account per step, refills applied; 0 while the
   * account is weekly-blocked. Accounts with no reading are not pooled.
   */
  values: Map<string, number[]>;
  total: number[];
  /**
   * Combined demand per hour in Pro 5h sessions: each account's measured burn times its
   * capacity.
   */
  demand: number;
  /**
   * The 5h capacity of the pooled accounts that can take requests now (not weekly-blocked)
   * together, in Pro 5h sessions.
   */
  capacity: number;
  /** First step at which the pool total is 0; null when it stays above 0 or is empty. */
  emptyAt: number | null;
  /** First step at which each account is at 0; null when it never empties. */
  accountEmptyAt: Map<string, number | null>;
  /** Earliest known refill among the accounts (r7 for a blocked one); null when none. */
  nextRefill: number | null;
  /** Steps where any account's drain changes slope; a chart must draw a point there. */
  breakpoints: number[];
}

/**
 * The 5h pool as the proxy routes it, in `stepMs` steps over `horizonMs`. Accounts
 * differ in size, so demand is counted in Pro 5h sessions: each account's measured burn
 * times its `capacityOf`. Each step the demand is spread over the accounts that still
 * have capacity in proportion to their measured demand, or equally when all of them
 * measure 0, the way round-robin hands out requests; an account that cannot take its
 * share passes the rest on, and drains by its share over its own capacity. An account at
 * 0 takes nothing until its known reset refills it to 100%. A window opened during the
 * horizon resets after it ends, so each account refills at most once inside a 5-hour
 * horizon. A weekly-blocked account takes nothing and counts 0 until its r7, then
 * rejoins with its 5h capacity (refilled if its 5h reset passed meanwhile). An account
 * with no reading is left out: no capacity, no demand.
 */
export function simulatePool(
  allProjections: AccountProjection[],
  now: number,
  horizonMs: number,
  capacityOf: (authId: string) => number = () => 1,
  stepMs: number = POOL_STEP_MS
): PoolSimulation {
  const projections = allProjections.filter(
    (projection): projection is AccountProjection & { left: number } => projection.left !== null
  );
  const steps = Math.max(0, Math.ceil(horizonMs / stepMs));
  const span = WINDOW_SPAN_MS['5h'];
  const size = projections.map((projection) => capacityOf(projection.authId));
  /** Measured demand per account, in Pro sessions per hour. */
  const draw = projections.map((projection, index) => projection.rate * size[index]);
  const demand = draw.reduce((total, value) => total + value, 0);
  const perStep = (demand * stepMs) / HOUR_MS;
  /** The 5h capacity the account holds, usable or not, as a share of its own window. */
  const capacity = projections.map((projection) =>
    projection.left > EMPTY_EPSILON ? projection.left : 0
  );
  const nextReset = projections.map((projection) => projection.reset);
  const blockedUntil = projections.map((projection) =>
    projection.blockedUntil !== null && projection.blockedUntil > now
      ? projection.blockedUntil
      : null
  );
  const openCapacity = size.reduce(
    (sum, value, index) => (blockedUntil[index] === null ? sum + value : sum),
    0
  );
  const usable = () => capacity.map((value, index) => (blockedUntil[index] === null ? value : 0));
  const rows = usable().map((value) => [value]);
  const total = [rows.reduce((sum, row) => sum + row[0], 0)];

  for (let step = 1; step <= steps; step += 1) {
    let need = perStep;
    while (need > EMPTY_EPSILON) {
      const active = capacity.flatMap((value, index) =>
        value > 0 && blockedUntil[index] === null ? [index] : []
      );
      if (active.length === 0) break;
      const drawSum = active.reduce((sum, index) => sum + draw[index], 0);
      const weight = (index: number) => (drawSum > 0 ? draw[index] / drawSum : 1 / active.length);
      let taken = 0;
      let capped = false;
      active.forEach((index) => {
        const share = need * weight(index);
        const room = capacity[index] * size[index];
        if (share >= room) {
          taken += room;
          capacity[index] = 0;
          capped = true;
        } else {
          taken += share;
          capacity[index] -= share / size[index];
          if (capacity[index] <= EMPTY_EPSILON) {
            capacity[index] = 0;
            capped = true;
          }
        }
      });
      need -= taken;
      // Nobody ran dry, so every share was taken in full.
      if (!capped) break;
    }

    const time = now + step * stepMs;
    nextReset.forEach((reset, index) => {
      if (reset === null || reset > time) return;
      capacity[index] = 1;
      let next = reset;
      while (next <= time) next += span;
      nextReset[index] = next;
    });
    blockedUntil.forEach((until, index) => {
      if (until !== null && until <= time) blockedUntil[index] = null;
    });
    const values = usable();
    values.forEach((value, index) => rows[index].push(value));
    total.push(values.reduce((sum, value) => sum + value, 0));
  }

  const timeOf = (step: number) => now + step * stepMs;
  const firstEmpty = (series: number[]) => {
    const step = series.findIndex((value) => value <= EMPTY_EPSILON);
    return step < 0 ? null : timeOf(step);
  };
  const breakpoints: number[] = [];
  for (let step = 1; step < steps; step += 1) {
    const bends = rows.some(
      (row) => Math.abs(row[step + 1] - row[step] - (row[step] - row[step - 1])) > EMPTY_EPSILON
    );
    if (bends) breakpoints.push(timeOf(step));
  }
  // A blocked account refills, as far as the pool can tell, when its weekly block ends.
  const resets = projections.flatMap((projection) => {
    const refill =
      projection.blockedUntil !== null && projection.blockedUntil > now
        ? projection.blockedUntil
        : projection.reset;
    return refill === null ? [] : [refill];
  });

  return {
    start: now,
    stepMs,
    values: new Map(projections.map((projection, index) => [projection.authId, rows[index]])),
    total,
    demand,
    capacity: openCapacity,
    emptyAt: projections.length > 0 ? firstEmpty(total) : null,
    accountEmptyAt: new Map(
      projections.map((projection, index) => [projection.authId, firstEmpty(rows[index])])
    ),
    nextRefill: resets.length > 0 ? Math.min(...resets) : null,
    breakpoints,
  };
}

/** An account's simulated capacity at `time`, linear between steps; null when not pooled. */
export function poolValueAt(pool: PoolSimulation, authId: string, time: number): number | null {
  const row = pool.values.get(authId);
  if (!row) return null;
  const position = Math.max(0, (time - pool.start) / pool.stepMs);
  const lower = Math.min(row.length - 1, Math.floor(position));
  const upper = Math.min(row.length - 1, lower + 1);
  const fraction = Math.min(1, position - lower);
  return row[lower] + (row[upper] - row[lower]) * fraction;
}

/** Simulated capacity just before `time` (the last step strictly before it). */
export function poolValueBefore(pool: PoolSimulation, authId: string, time: number): number | null {
  const row = pool.values.get(authId);
  if (!row) return null;
  const step = Math.ceil((time - pool.start) / pool.stepMs) - 1;
  return row[Math.max(0, Math.min(row.length - 1, step))];
}
