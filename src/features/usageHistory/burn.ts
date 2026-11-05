/**
 * Burn rate: how fast a chart's pool is being used, as a share of the whole pool per hour.
 *
 * The pool and its weights are the chart's own (`seriesShares`), so burn is measured on the
 * chart's y-axis: 0.12 per hour moves the stacked top down 12% an hour. Observed burn comes
 * from the utilization readings, not from capacity left, because a reset, a weekly block or
 * an account entering the chart moves capacity without anyone using it. Projected burn is
 * what the routing simulation serves (`PoolSimulation.taken`), so it is the rate the runway
 * assumes, falls to 0 while the pool is dry and returns after refills.
 */

import type { QuotaHistorySample } from '@/services/api/quotaHistory';
import { seriesShares, type ChartData } from './chartData';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  RESET_TOLERANCE_MS,
  readWindow,
  type WindowKind,
} from './model';
import type { PoolSimulation } from './projection';

/** The line is a trailing average over at least this long, and over two grid steps. */
export const BURN_LINE_WINDOW_MS: Record<WindowKind, number> = {
  '5h': 30 * MINUTE_MS,
  '7d': 6 * HOUR_MS,
};
/** "Burning now" spans this long, and "change" compares it with the same span before. */
export const BURN_STAT_WINDOW_MS: Record<WindowKind, number> = {
  '5h': 30 * MINUTE_MS,
  '7d': DAY_MS,
};
/** The summary's average spans one window. */
export const BURN_AVERAGE_MS: Record<WindowKind, number> = {
  '5h': 5 * HOUR_MS,
  '7d': 7 * DAY_MS,
};
/** Display units: a share of the pool per hour as % of the pool per hour, on both charts. */
export const BURN_DISPLAY_SCALE = 100;

/** The trailing window of a chart's line: the base, widened to two grid steps. */
export function burnLineWindow(kind: WindowKind, spanMs: number, points: number): number {
  const step = points > 1 ? spanMs / (points - 1) : spanMs;
  return Math.max(BURN_LINE_WINDOW_MS[kind], 2 * step);
}

export interface Usage {
  /** When the reading that shows it was taken, epoch ms. */
  t: number;
  /** Share of the account's own window used since its previous reading. */
  amount: number;
}

/**
 * What an account used, from its samples in ascending `t` order: each rise above the
 * highest utilization read so far in the window, and a new window's whole utilization
 * once the previous window has ended. Readings jitter by a point (a rejected response says
 * 100% where the allowed one just after says 99%, a 5h reading flips between 1% and 2%),
 * so a rise back to a level already read is not new use; over a window the events add up
 * to its highest reading minus its first. A reset that moved while its window was still
 * open keeps the window's high mark. The first reading has nothing to compare with, and a
 * reading taken at or after its own reset describes a window that is over; neither adds
 * anything.
 */
export function usageEvents(samples: QuotaHistorySample[], kind: WindowKind): Usage[] {
  const events: Usage[] = [];
  /** The open window's reset and the highest utilization read in it. */
  let open: { r: number; high: number } | null = null;
  for (const sample of samples) {
    const reading = readWindow(sample, kind);
    if (!reading || sample.t >= reading.r) continue;
    if (open === null) {
      open = { r: reading.r, high: reading.u };
      continue;
    }
    const sameWindow: boolean = Math.abs(reading.r - open.r) <= RESET_TOLERANCE_MS;
    const high: number = sameWindow || sample.t < open.r ? open.high : 0;
    if (reading.u > high) events.push({ t: sample.t, amount: reading.u - high });
    open = { r: reading.r, high: Math.max(high, reading.u) };
  }
  return events;
}

/** Pooled use over time: `totals[i]` is everything used at or before `times[i]`. */
interface Cumulative {
  times: number[];
  totals: number[];
}

/** Every chart account's use, weighted by its share of the pool, in time order. */
function pooledUsage(
  data: ChartData,
  samples: Map<string, QuotaHistorySample[]>,
  kind: WindowKind
): Cumulative {
  const shares = seriesShares(data.series);
  const events: Usage[] = [];
  data.series.forEach((entry, index) => {
    const share = shares[index];
    if (share <= 0) return;
    usageEvents(samples.get(entry.account.authId) ?? [], kind).forEach((event) =>
      events.push({ t: event.t, amount: event.amount * share })
    );
  });
  events.sort((a, b) => a.t - b.t);
  let running = 0;
  return {
    times: events.map((event) => event.t),
    totals: events.map((event) => (running += event.amount)),
  };
}

/** Pooled use at or before `time`. */
function usedBy({ times, totals }: Cumulative, time: number): number {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found < 0 ? 0 : totals[found];
}

/** Share of the pool used per hour over `(from, to]`; 0 for an empty span. */
const rateOver = (used: Cumulative, from: number, to: number): number =>
  to > from ? ((usedBy(used, to) - usedBy(used, from)) / (to - from)) * HOUR_MS : 0;

/**
 * The simulated use of the chart's accounts from the start of `pool` up to a time, weighted
 * like the chart and spread evenly within each simulation step, and where the simulation
 * ends.
 */
function simulatedUsage(
  pool: PoolSimulation,
  data: ChartData
): { usedBy: (time: number) => number; end: number } {
  const shares = seriesShares(data.series);
  const rows = data.series.flatMap((entry, index) => {
    const row = pool.taken.get(entry.account.authId);
    return row && shares[index] > 0 ? [{ row, share: shares[index] }] : [];
  });
  const length = Math.max(1, ...rows.map(({ row }) => row.length));
  const totals = [0];
  for (let step = 1; step < length; step += 1) {
    const served = rows.reduce((sum, { row, share }) => sum + (row[step] ?? 0) * share, 0);
    totals.push(totals[step - 1] + served);
  }
  const usedBy = (time: number) => {
    const position = Math.max(0, (time - pool.start) / pool.stepMs);
    const lower = Math.min(length - 1, Math.floor(position));
    const upper = Math.min(length - 1, lower + 1);
    return totals[lower] + (totals[upper] - totals[lower]) * Math.min(1, position - lower);
  };
  return { usedBy, end: pool.start + (length - 1) * pool.stepMs };
}

export interface Burn {
  /**
   * Share of the pool used per hour at each grid point of the chart; null where no account
   * has data. Up to the chart's split (now) it is the trailing average over the line
   * window; after it, the simulated average over each grid interval.
   */
  values: Array<number | null>;
  /** Grid index of the highest observed value; null when nothing was used in range. */
  peakIndex: number | null;
  /** Share of the pool per hour over the last stat window. */
  now: number;
  /** The same over the stat window before it. */
  before: number;
  /** Share of the pool per hour over the last average span. */
  average: number;
}

interface BurnInput {
  data: ChartData;
  samples: Map<string, QuotaHistorySample[]>;
  kind: WindowKind;
  /** The line's trailing window (`burnLineWindow`). */
  lineWindowMs: number;
  /** The routed simulation the chart's tail draws; without one there is no projected burn. */
  pool?: PoolSimulation;
}

/** The burn line on a capacity chart's grid, and the summary figures at its now. */
export function buildBurn({ data, samples, kind, lineWindowMs, pool }: BurnInput): Burn {
  const { times, series } = data;
  const split = data.splitIndex ?? times.length - 1;
  const now = times[split] ?? 0;
  const used = pooledUsage(data, samples, kind);
  const simulated = pool ? simulatedUsage(pool, data) : null;

  const values = times.map((time, index) => {
    if (!series.some((entry) => entry.values[index] != null)) return null;
    if (index <= split) return rateOver(used, time - lineWindowMs, time);
    // Each grid interval's average; past the simulated horizon there is nothing to read.
    const previous = times[index - 1];
    const until = simulated ? Math.min(time, simulated.end) : previous;
    if (!simulated || until <= previous) return null;
    return ((simulated.usedBy(until) - simulated.usedBy(previous)) / (until - previous)) * HOUR_MS;
  });

  let peakIndex: number | null = null;
  for (let index = 0; index <= split && index < values.length; index += 1) {
    const value = values[index];
    if (value !== null && value > 0 && (peakIndex === null || value > (values[peakIndex] ?? 0))) {
      peakIndex = index;
    }
  }

  const stat = BURN_STAT_WINDOW_MS[kind];
  return {
    values,
    peakIndex,
    now: rateOver(used, now - stat, now),
    before: rateOver(used, now - 2 * stat, now - stat),
    average: rateOver(used, now - BURN_AVERAGE_MS[kind], now),
  };
}
