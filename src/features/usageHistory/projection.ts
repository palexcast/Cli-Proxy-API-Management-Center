/**
 * Runway projection.
 *
 * Burn rate per window kind: 5h is the least-squares slope of capacity left over the
 * last 30 minutes of the open window; 7d is the open window's average, utilization
 * over the hours since it opened, at least `MIN_WEEKLY_ELAPSED_MS` (samples only exist
 * during use, so a slope through them would overstate an account that burst and went
 * idle, and minutes into a window a few percent would read as a week's burn per day).
 *
 * Both tails come from `simulateRouting`, which moves load between accounts the way the
 * proxy routes it (round-robin with session affinity and credential priority). Rates are
 * shares of the account's own window, so the simulation converts them through each
 * account's capacity.
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
  return {
    authId,
    left,
    rate,
    reset,
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
/** The weekly simulation's step: a week in 5-minute steps. */
export const WEEKLY_STEP_MS = 5 * MINUTE_MS;

/** A span during which an account takes no requests, whatever its capacity. */
export interface BlockInterval {
  from: number;
  until: number;
}

/** One account as the routing simulation sees it. */
export interface RoutedAccount {
  authId: string;
  /** Credential priority: cold sessions and failover go to the highest that can take them. */
  priority: number;
  /** Its window in absolute units: Pro sessions for 5h, Pro weeks for 7d. */
  size: number;
  /**
   * Its projection for the simulated window, or null when it has no such window: on the
   * 5h run an account without a 5h limit, on the weekly run one whose responses never
   * carried weekly headers. Such an account takes its share of failover while it can take
   * requests and never runs dry; what it carries is not counted in the pool. Its own load
   * cannot be read in this window's units, so it is not counted either.
   */
  projection: AccountProjection | null;
  /** When it takes no requests whatever its capacity: weekly blocks, now or projected. */
  blocks: BlockInterval[];
}

export interface RoutingRun {
  /** Simulation start (now), epoch ms; values sit at `start + k * stepMs`. */
  start: number;
  stepMs: number;
  /**
   * Usable capacity left per pool member (an account with this window and a reading) per
   * step, refills applied; 0 while blocked.
   */
  values: Map<string, number[]>;
  /** Each member's measured load at the start, in absolute units per hour. */
  draw: Map<string, number>;
  size: Map<string, number>;
  /** Members blocked at the start: they cannot take requests now. */
  blockedNow: Set<string>;
  /** Each member's next refill: the end of the block it is in now, else its reset. */
  refill: Map<string, number | null>;
}

export interface PoolSimulation {
  /** Simulation start (now), epoch ms; values sit at `start + k * stepMs`. */
  start: number;
  stepMs: number;
  /** Usable capacity left per account in the pool per step; 0 while blocked. */
  values: Map<string, number[]>;
  total: number[];
  /** The pool accounts' measured load per hour, in absolute units (Pro sessions or weeks). */
  demand: number;
  /** The window size of the pool accounts that can take requests now, in absolute units. */
  capacity: number;
  /** First step at which the pool total is 0; null when it stays above 0 or is empty. */
  emptyAt: number | null;
  /** Earliest known refill among the pool accounts (a block's end for a blocked one). */
  nextRefill: number | null;
  /** Steps where any pool account's drain changes slope; a chart must draw a point there. */
  breakpoints: number[];
}

const blockedAt = (blocks: BlockInterval[], time: number): boolean =>
  blocks.some((block) => time >= block.from && time < block.until);

/**
 * Simulates `kind`'s window over `horizonMs` in `stepMs` steps, moving load the way the
 * proxy routes it: round-robin with session affinity, rebinding on a quota failure, and
 * credential priority.
 *
 * - Each account keeps carrying its measured load (rate times size, in absolute units):
 *   its bound sessions stay with it while it can take requests.
 * - An account that cannot take requests (its window is empty, or a block holds it) hands
 *   all it carries to the highest priority among the accounts that can, split evenly
 *   across that tier (round-robin), so a bigger window drains slower by the same amount.
 *   Moved load stays where it landed: a refilled account gets no sessions back and takes
 *   only its share of later failover.
 * - When no account can take requests the load waits and lands on the first ones that can.
 * - An account at 0 refills to 100% at its known reset; a window opened during the horizon
 *   resets one span after the last, so a 5h or weekly horizon holds one refill per account.
 *
 * New sessions also bind to the highest priority; how many arrive is not recorded, so
 * the simulation does not move load toward a refilled account on their account. An account
 * whose projection has no reading (`left` null) is left out: no capacity, no load, takes
 * no failover.
 */
export function simulateRouting(
  allAccounts: RoutedAccount[],
  kind: WindowKind,
  now: number,
  horizonMs: number,
  stepMs: number = kind === '7d' ? WEEKLY_STEP_MS : POOL_STEP_MS
): RoutingRun {
  const accounts = allAccounts.filter(
    (account) => account.projection === null || account.projection.left !== null
  );
  const steps = Math.max(0, Math.ceil(horizonMs / stepMs));
  const span = WINDOW_SPAN_MS[kind];
  const hours = stepMs / HOUR_MS;
  const member = accounts.map((account) => account.projection !== null);
  const size = accounts.map((account) => account.size);
  /** Capacity left as a share of the account's own window; unbounded without a window. */
  const capacity = accounts.map(({ projection }) =>
    projection === null
      ? Number.POSITIVE_INFINITY
      : (projection.left ?? 0) > EMPTY_EPSILON
        ? (projection.left ?? 0)
        : 0
  );
  const nextReset = accounts.map(({ projection }) => projection?.reset ?? null);
  /** Load each account carries, absolute units per hour. */
  const carry = accounts.map(({ projection }, index) =>
    projection === null ? 0 : projection.rate * size[index]
  );
  const draw = carry.slice();
  let waiting = 0;

  const canTake = (index: number, time: number) =>
    capacity[index] > EMPTY_EPSILON && !blockedAt(accounts[index].blocks, time);
  /** The accounts round-robin would hand failover to at `time`. */
  const topTier = (time: number): number[] => {
    const open = accounts.flatMap((_, index) => (canTake(index, time) ? [index] : []));
    if (open.length === 0) return open;
    const best = Math.max(...open.map((index) => accounts[index].priority));
    return open.filter((index) => accounts[index].priority === best);
  };
  /** The account cannot hold more: what it carries fails over. */
  const runDry = (index: number) => {
    capacity[index] = 0;
    waiting += carry[index];
    carry[index] = 0;
  };
  /** Take `amount` (absolute units) out of the account; returns what it could not hold. */
  const take = (index: number, amount: number): number => {
    if (!member[index] || amount <= 0) return 0;
    const room = capacity[index] * size[index];
    if (amount >= room) {
      runDry(index);
      return amount - room;
    }
    capacity[index] -= amount / size[index];
    if (capacity[index] <= EMPTY_EPSILON) runDry(index);
    return 0;
  };
  const usable = (index: number, time: number) =>
    blockedAt(accounts[index].blocks, time) ? 0 : capacity[index];

  const memberIndexes = accounts.flatMap((_, index) => (member[index] ? [index] : []));
  const rows = memberIndexes.map((index) => [usable(index, now)]);

  for (let step = 1; step <= steps; step += 1) {
    const from = now + (step - 1) * stepMs;
    const to = now + step * stepMs;

    // Sessions on an account that cannot take requests fail over to the top tier.
    accounts.forEach((_, index) => {
      if (carry[index] > 0 && !canTake(index, from)) {
        waiting += carry[index];
        carry[index] = 0;
      }
    });
    if (waiting > 0) {
      const tier = topTier(from);
      if (tier.length > 0) {
        tier.forEach((index) => (carry[index] += waiting / tier.length));
        waiting = 0;
      }
    }

    // Serve the step. What an account cannot hold fails over within the step.
    let overflow = 0;
    accounts.forEach((_, index) => {
      if (canTake(index, from)) overflow += take(index, carry[index] * hours);
    });
    while (overflow > EMPTY_EPSILON) {
      const tier = topTier(from);
      if (tier.length === 0) break;
      const share = overflow / tier.length;
      overflow = 0;
      tier.forEach((index) => (overflow += take(index, share)));
    }

    nextReset.forEach((reset, index) => {
      if (reset === null || reset > to) return;
      capacity[index] = 1;
      let next = reset;
      while (next <= to) next += span;
      nextReset[index] = next;
    });
    memberIndexes.forEach((index, row) => rows[row].push(usable(index, to)));
  }

  const ids = memberIndexes.map((index) => accounts[index].authId);
  const blockEndNow = (index: number): number | null => {
    const ends = accounts[index].blocks
      .filter((block) => now >= block.from && now < block.until)
      .map((block) => block.until);
    return ends.length > 0 ? Math.max(...ends) : null;
  };
  return {
    start: now,
    stepMs,
    values: new Map(ids.map((id, row) => [id, rows[row]])),
    draw: new Map(memberIndexes.map((index) => [accounts[index].authId, draw[index]])),
    size: new Map(memberIndexes.map((index) => [accounts[index].authId, size[index]])),
    blockedNow: new Set(
      memberIndexes
        .filter((index) => blockedAt(accounts[index].blocks, now))
        .map((index) => accounts[index].authId)
    ),
    refill: new Map(
      memberIndexes.map((index) => [
        accounts[index].authId,
        blockEndNow(index) ?? accounts[index].projection?.reset ?? null,
      ])
    ),
  };
}

/**
 * The pool of `authIds` within a run: their capacity summed per step, when it first runs
 * dry, their measured demand and the capacity that can take requests now. Ids that are
 * not run members (no reading, or no such window) are left out.
 */
export function poolOf(run: RoutingRun, authIds: Iterable<string>): PoolSimulation {
  const ids = [...new Set(authIds)].filter((id) => run.values.has(id));
  const rows = ids.map((id) => run.values.get(id) ?? []);
  const length = rows.length > 0 ? rows[0].length : 1;
  const total = Array.from({ length }, (_, step) => rows.reduce((sum, row) => sum + row[step], 0));
  const timeOf = (step: number) => run.start + step * run.stepMs;
  const firstEmpty = total.findIndex((value) => value <= EMPTY_EPSILON);
  const breakpoints: number[] = [];
  for (let step = 1; step < length - 1; step += 1) {
    const bends = rows.some(
      (row) => Math.abs(row[step + 1] - row[step] - (row[step] - row[step - 1])) > EMPTY_EPSILON
    );
    if (bends) breakpoints.push(timeOf(step));
  }
  const refills = ids.flatMap((id) => {
    const refill = run.refill.get(id) ?? null;
    return refill === null ? [] : [refill];
  });
  return {
    start: run.start,
    stepMs: run.stepMs,
    values: new Map(ids.map((id, index) => [id, rows[index]])),
    total,
    demand: ids.reduce((sum, id) => sum + (run.draw.get(id) ?? 0), 0),
    capacity: ids.reduce(
      (sum, id) => (run.blockedNow.has(id) ? sum : sum + (run.size.get(id) ?? 0)),
      0
    ),
    emptyAt: ids.length > 0 && firstEmpty >= 0 ? timeOf(firstEmpty) : null,
    nextRefill: refills.length > 0 ? Math.min(...refills) : null,
    breakpoints,
  };
}

/**
 * The spans during which an account's simulated capacity in `run` is 0, from the step it
 * first reads 0 to the step it refills (or past the horizon). The 5h run takes these from
 * the weekly run as blocks: an account whose weekly window runs dry takes no requests.
 */
export function emptySpans(run: RoutingRun, authId: string): BlockInterval[] {
  const row = run.values.get(authId);
  if (!row) return [];
  const spans: BlockInterval[] = [];
  let from: number | null = null;
  row.forEach((value, step) => {
    const time = run.start + step * run.stepMs;
    if (value <= EMPTY_EPSILON) {
      if (from === null) from = time;
    } else if (from !== null) {
      spans.push({ from, until: time });
      from = null;
    }
  });
  if (from !== null) spans.push({ from, until: run.start + row.length * run.stepMs });
  return spans;
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
