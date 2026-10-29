/**
 * Chart-ready series on a shared time grid. Pure; the chart component only draws.
 */

import type { QuotaHistorySample } from '@/services/api/quotaHistory';
import {
  buildTimeGrid,
  capacityLeftSeries,
  isActive,
  knownUntil,
  type AccountInfo,
  type QuotaWindow,
  type WindowKind,
} from './model';
import {
  poolValueAt,
  projectedLeftAt,
  type AccountProjection,
  type PoolSimulation,
} from './projection';

export interface ChartSeries {
  account: AccountInfo;
  /** Capacity left per grid point; null where there is no data yet, drawn as a gap. */
  values: Array<number | null>;
  /** The account's window size relative to the others; a stacked band's height. */
  weight: number;
}

export interface ChartDot {
  /** Index into `series`. */
  series: number;
  /** Grid index the dot sits on. */
  index: number;
  /** Leftover the dot stands for (0..1), shown as a label when `labelled`. */
  value: number;
  labelled: boolean;
}

export interface ResetTick {
  series: number;
  /**
   * 0..1 along the time axis: where the account's drawn capacity refills, its reset or
   * its r7 while weekly-blocked.
   */
  position: number;
}

export interface ChartData {
  times: number[];
  /** Each grid point's place along the time axis, 0..1; the grid is not always even. */
  positions: number[];
  series: ChartSeries[];
  dots: ChartDot[];
  /** Known resets inside the projected tail. */
  resetTicks: ResetTick[];
  /** Grid index of "now", the last observed point; absent when there is no tail. */
  splitIndex?: number;
}

/** Last grid index strictly before `time`, or -1. */
function indexBefore(times: number[], time: number): number {
  let found = -1;
  for (let index = 0; index < times.length && times[index] < time; index += 1) found = index;
  return found;
}

/** 0..1 along the time axis of `times`. */
export function axisPosition(times: number[], time: number): number {
  const first = times[0] ?? 0;
  const span = (times[times.length - 1] ?? first) - first;
  return span > 0 ? (time - first) / span : 0;
}

export interface ProjectedTail {
  /** How far past `to` (now) the projection runs. */
  horizonMs: number;
  /** Per account: rate (30-minute slope for 5h, window average for 7d) and next reset. */
  projections: Map<string, AccountProjection>;
  /**
   * 5h: the pooled simulation the tail draws. Its breakpoints join the grid so the
   * drawn lines bend, empty and refill where the simulation does.
   */
  pool?: PoolSimulation;
}

interface CapacityChartInput {
  accounts: AccountInfo[];
  samples: Map<string, QuotaHistorySample[]>;
  windows: Map<string, QuotaWindow[]>;
  kind: WindowKind;
  from: number;
  /** Now: the last observed instant. */
  to: number;
  /** Grid points over the observed range; the tail continues at the same spacing. */
  points: number;
  /** Which accounts get a leftover label on their reset dots. */
  labelDots?: (account: AccountInfo) => boolean;
  /** Each account's window size, for stacking; 1 each when absent. */
  weightOf?: (account: AccountInfo) => number;
  tail?: ProjectedTail;
}

/** Merge extra instants inside `(start, end)` into an ascending grid. */
function withInstants(grid: number[], instants: number[], start: number, end: number): number[] {
  const extra = instants.filter((time) => time > start && time < end);
  if (extra.length === 0) return grid;
  return Array.from(new Set([...grid, ...extra])).sort((a, b) => a - b);
}

/**
 * Observed capacity left per account with a dot at the last value before each reset,
 * optionally followed by a projected tail. With a pool the tail is the pooled
 * simulation; without one each account drains at its own rate, refills to 100% at
 * its known reset and keeps draining at the same rate. Before an account's first
 * reading its values are null, and an account with no reading has no tail. An account
 * that left the pool (disabled or removed) keeps its history up to `knownUntil`, then
 * reads null: it has no tail and never refills.
 */
export function buildCapacityChart(input: CapacityChartInput): ChartData {
  const { accounts, samples, windows, kind, from, to, points, tail } = input;
  const past = buildTimeGrid(from, to, points);
  const step = past.length > 1 ? (to - from) / (past.length - 1) : 0;
  const tailSteps = tail && step > 0 ? Math.ceil(tail.horizonMs / step) : 0;
  const evenTail = Array.from({ length: tailSteps }, (_, index) => to + (index + 1) * step);
  const pool = tail?.pool;
  const tailTimes = pool
    ? withInstants(
        evenTail,
        pool.emptyAt === null ? pool.breakpoints : [...pool.breakpoints, pool.emptyAt],
        to,
        evenTail[evenTail.length - 1] ?? to
      )
    : evenTail;
  const times = [...past, ...tailTimes];
  const end = times[times.length - 1];
  const splitIndex = past.length - 1;

  const resetTicks: ResetTick[] = [];
  const series = accounts.map((account, seriesIndex) => {
    const own = samples.get(account.authId) ?? [];
    const values = capacityLeftSeries(own, kind, past);
    if (!isActive(account)) {
      const until = knownUntil(own, kind);
      const known = values.map((value, index) =>
        until !== null && past[index] < until ? value : null
      );
      known.push(...tailTimes.map(() => null));
      return { account, values: known, weight: input.weightOf?.(account) ?? 1 };
    }
    const projection = tail?.projections.get(account.authId);
    for (let index = past.length; index < times.length; index += 1) {
      const time = times[index];
      const pooled = pool ? poolValueAt(pool, account.authId, time) : null;
      values.push(
        pooled ?? (projection ? projectedLeftAt(projection, kind, to, time) : values[splitIndex])
      );
    }
    const refill =
      projection && projection.left !== null ? (projection.blockedUntil ?? projection.reset) : null;
    if (tailSteps > 0 && refill !== null && refill <= end) {
      resetTicks.push({ series: seriesIndex, position: axisPosition(times, refill) });
    }
    return { account, values, weight: input.weightOf?.(account) ?? 1 };
  });

  const dots: ChartDot[] = [];
  accounts.forEach((account, seriesIndex) => {
    (windows.get(account.authId) ?? []).forEach((window) => {
      if (window.reset <= from || window.reset > to) return;
      const index = indexBefore(times, window.reset);
      if (index < 0) return;
      dots.push({
        series: seriesIndex,
        index,
        value: 1 - window.finalUtilization,
        labelled: input.labelDots?.(account) ?? false,
      });
    });
  });

  const positions = times.map((time) => axisPosition(times, time));
  return tailSteps > 0
    ? { times, positions, series, dots, resetTicks, splitIndex }
    : { times, positions, series, dots, resetTicks };
}
