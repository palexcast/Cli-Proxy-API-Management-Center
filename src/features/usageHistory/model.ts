/**
 * Pure data model for the usage-history page: accounts, plans, rate-limit windows
 * and the capacity-left step function. No React, no I/O; unit-tested in tests/.
 */

import {
  compareSamples,
  type QuotaHistory,
  type QuotaHistoryAccount,
  type QuotaHistorySample,
} from '@/services/api/quotaHistory';

export const MINUTE_MS = 60 * 1000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export type WindowKind = '5h' | '7d';
/** Plan family: which window limits the account (5h for Team, weekly for Max). */
export type Plan = 'team' | 'max';
/** Subscription tier: the plan family and the size of the 5h window. */
export type Tier = 'team_standard' | 'team_premium' | 'max_5x' | 'max_20x';

export const TIERS: readonly Tier[] = ['team_premium', 'team_standard', 'max_20x', 'max_5x'];

export const TIER_PLAN: Record<Tier, Plan> = {
  team_standard: 'team',
  team_premium: 'team',
  max_5x: 'max',
  max_20x: 'max',
};

/**
 * Each tier's 5h allowance in Pro sessions (Pro = 1), as Anthropic publishes it: a
 * Team Standard seat 1.25x Pro, a Premium seat 6.25x, Max 5x and 20x. Utilization is a
 * share of the account's own window, so pooling accounts needs these to compare them.
 * Weekly limits are not published as multiples; the weekly figures stay per account.
 */
export const TIER_CAPACITY_5H: Record<Tier, number> = {
  team_standard: 1.25,
  team_premium: 6.25,
  max_5x: 5,
  max_20x: 20,
};

export const isTier = (value: unknown): value is Tier =>
  typeof value === 'string' && (TIERS as readonly string[]).includes(value);

export const WINDOW_SPAN_MS: Record<WindowKind, number> = {
  '5h': 5 * HOUR_MS,
  '7d': 7 * DAY_MS,
};

/** Reset headers that differ by less than this belong to the same window. */
const RESET_TOLERANCE_MS = MINUTE_MS;

export const SERIES_SLOT_COUNT = 6;

export interface AccountInfo {
  authId: string;
  /** Display text: explicit label, else file name, else the auth id. */
  label: string;
  tier: Tier;
  defaultTier: Tier;
  /** Derived from `tier`. */
  plan: Plan;
  /** Position in label order; picks the fixed series color. */
  slot: number;
}

export type TierOverrides = Record<string, Tier>;

export interface WindowReading {
  /** Utilization 0..1. */
  u: number;
  /** Reset instant, epoch ms. */
  r: number;
}

export function readWindow(sample: QuotaHistorySample, kind: WindowKind): WindowReading | null {
  const u = kind === '5h' ? sample.u5 : sample.u7;
  const r = kind === '5h' ? sample.r5 : sample.r7;
  return u === undefined || r === undefined ? null : { u, r };
}

/**
 * Accounts with at least one weekly reading among their samples. A weekly request
 * returns 5h-only samples too, so a sample's presence alone says nothing about 7d.
 */
export function accountsWithWeeklyReadings(
  accounts: AccountInfo[],
  samples: Map<string, QuotaHistorySample[]>
): AccountInfo[] {
  return accounts.filter((account) =>
    (samples.get(account.authId) ?? []).some((sample) => readWindow(sample, '7d') !== null)
  );
}

/** The tier a label suggests: a Team Premium seat when it says "team", else Max 20x. */
export const defaultTierForLabel = (label: string): Tier =>
  /team/i.test(label) ? 'team_premium' : 'max_20x';

/** The account's 5h window in Pro sessions. */
export const capacity5h = (account: Pick<AccountInfo, 'tier'>): number =>
  TIER_CAPACITY_5H[account.tier];

/**
 * Every account that is either loaded now or present in the samples, in label
 * order. Historical ids with no `accounts` entry fall back to their id.
 */
export function buildAccounts(
  history: Pick<QuotaHistory, 'accounts' | 'samples'>,
  overrides: TierOverrides = {}
): AccountInfo[] {
  const known = new Map<string, QuotaHistoryAccount>();
  history.accounts.forEach((account) => {
    if (!account.provider || account.provider === 'claude') known.set(account.authId, account);
  });
  const ids = new Set<string>(known.keys());
  history.samples.forEach((sample) => ids.add(sample.authId));

  const rows = Array.from(ids).map((authId) => {
    const account = known.get(authId);
    const explicit = account?.label ?? '';
    const label = explicit || account?.name || authId;
    const defaultTier = defaultTierForLabel(explicit);
    const tier = overrides[authId] ?? defaultTier;
    return { authId, label, tier, defaultTier, plan: TIER_PLAN[tier] };
  });

  rows.sort((a, b) => a.label.localeCompare(b.label) || a.authId.localeCompare(b.authId));
  return rows.map((row, slot) => ({ ...row, slot }));
}

/** Samples per account, keeping the ascending `t` order of the input. */
export function groupSamplesByAccount(
  samples: QuotaHistorySample[]
): Map<string, QuotaHistorySample[]> {
  const byAccount = new Map<string, QuotaHistorySample[]>();
  samples.forEach((sample) => {
    const list = byAccount.get(sample.authId);
    if (list) list.push(sample);
    else byAccount.set(sample.authId, [sample]);
  });
  return byAccount;
}

/**
 * An account's samples with the `lead` samples (from a longer, coarser request) that come
 * before its first one, so an account seen earlier carries its last reading into the
 * shorter range instead of reading as never seen.
 */
export function withLead(
  samples: QuotaHistorySample[],
  lead: QuotaHistorySample[]
): QuotaHistorySample[] {
  const first = samples[0]?.t ?? Number.POSITIVE_INFINITY;
  const before = lead.filter((sample) => sample.t < first);
  return before.length === 0 ? samples : [...before, ...samples];
}

export interface QuotaWindow {
  authId: string;
  kind: WindowKind;
  /** `reset - span`, epoch ms. */
  start: number;
  reset: number;
  /** Utilization of the last sample before the reset. */
  finalUtilization: number;
  /** When that last sample was taken. */
  lastSampleAt: number;
}

/**
 * One window per distinct reset instant. The final utilization is what was used
 * when the window closed, so `1 - finalUtilization` is the leftover at reset.
 */
export function buildWindows(
  authId: string,
  samples: QuotaHistorySample[],
  kind: WindowKind
): QuotaWindow[] {
  const windows: QuotaWindow[] = [];
  samples.forEach((sample) => {
    const reading = readWindow(sample, kind);
    if (!reading || sample.t >= reading.r) return;
    const existing = windows.find(
      (window) => Math.abs(window.reset - reading.r) <= RESET_TOLERANCE_MS
    );
    if (!existing) {
      windows.push({
        authId,
        kind,
        start: reading.r - WINDOW_SPAN_MS[kind],
        reset: reading.r,
        finalUtilization: reading.u,
        lastSampleAt: sample.t,
      });
    } else if (sample.t >= existing.lastSampleAt) {
      existing.finalUtilization = reading.u;
      existing.lastSampleAt = sample.t;
    }
  });
  return windows.sort((a, b) => a.reset - b.reset);
}

/** Leftover (1 - final utilization) of the last window that reset at or before `now`. */
export function lastLeftover(windows: QuotaWindow[], now: number): number | null {
  const ended = windows.filter((window) => window.reset <= now);
  const last = ended[ended.length - 1];
  return last ? 1 - last.finalUtilization : null;
}

/** Index of the last sample with `t <= time`, or -1. Samples are sorted by `t`. */
function lastIndexAtOrBefore(samples: QuotaHistorySample[], time: number): number {
  let lo = 0;
  let hi = samples.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].t <= time) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** The latest reading for `kind` at or before `time`, with when it was taken. */
export function latestReading(
  samples: QuotaHistorySample[],
  kind: WindowKind,
  time: number
): (WindowReading & { t: number }) | null {
  for (let index = lastIndexAtOrBefore(samples, time); index >= 0; index -= 1) {
    const reading = readWindow(samples[index], kind);
    if (reading) return { ...reading, t: samples[index].t };
  }
  return null;
}

/**
 * The instant a weekly block ends, when `sample` carries an exhausted weekly reading
 * (u7 at 100% or s7 rejected): Anthropic rejects every request until r7, whatever the
 * 5h window has left. Null when the sample has no weekly reading or it is not exhausted.
 */
export function weeklyBlockEnd(sample: QuotaHistorySample): number | null {
  const weekly = readWindow(sample, '7d');
  if (!weekly) return null;
  return weekly.u >= 1 || sample.s7 === 'rejected' ? weekly.r : null;
}

/** When the latest weekly reading at or before `time` blocks the account, its r7; else null. */
export function weeklyBlockAt(samples: QuotaHistorySample[], time: number): number | null {
  for (let index = lastIndexAtOrBefore(samples, time); index >= 0; index -= 1) {
    if (readWindow(samples[index], '7d') === null) continue;
    const end = weeklyBlockEnd(samples[index]);
    return end !== null && time < end ? end : null;
  }
  return null;
}

/**
 * Effective capacity left from the latest reading and weekly block: null with no reading
 * yet, 0 while weekly-blocked (5h only), full once the reading's window has reset.
 */
function effectiveLeft(
  reading: WindowReading | null,
  kind: WindowKind,
  blockEnd: number | null,
  time: number
): number | null {
  if (kind === '5h' && blockEnd !== null && time < blockEnd) return 0;
  if (!reading) return null;
  return time >= reading.r ? 1 : 1 - reading.u;
}

/**
 * Capacity left (0..1) at an instant. The last reading carries forward until its
 * reset passes, then the account has its full capacity. Null before the account's
 * first reading: no data is not 100%. A weekly-exhausted account has no 5h capacity
 * until its weekly reset.
 */
export function capacityLeftAt(
  samples: QuotaHistorySample[],
  kind: WindowKind,
  time: number
): number | null {
  const blockEnd = kind === '5h' ? weeklyBlockAt(samples, time) : null;
  return effectiveLeft(latestReading(samples, kind, time), kind, blockEnd, time);
}

/** Capacity left on an ascending time grid, in one pass over the samples. */
export function capacityLeftSeries(
  samples: QuotaHistorySample[],
  kind: WindowKind,
  times: number[]
): Array<number | null> {
  let index = 0;
  let current: WindowReading | null = null;
  let blockEnd: number | null = null;
  return times.map((time) => {
    while (index < samples.length && samples[index].t <= time) {
      const sample = samples[index];
      current = readWindow(sample, kind) ?? current;
      if (readWindow(sample, '7d')) blockEnd = weeklyBlockEnd(sample);
      index += 1;
    }
    return effectiveLeft(current, kind, blockEnd, time);
  });
}

/** `count` evenly spaced instants from `start` to `end` inclusive. */
export function buildTimeGrid(start: number, end: number, count: number): number[] {
  if (count < 2 || end <= start) return [start];
  const step = (end - start) / (count - 1);
  return Array.from({ length: count }, (_, index) =>
    index === count - 1 ? end : start + index * step
  );
}

/** The earliest sample overall: before it there was no recording, not no usage. */
export const recordingStart = (samples: QuotaHistorySample[]): number | null =>
  samples.length > 0 ? samples[0].t : null;

const mergeKey = (sample: QuotaHistorySample) =>
  `${sample.t}\0${sample.authId}\0${sample.r5 ?? ''}\0${sample.r7 ?? ''}`;

/**
 * Merge a refetched tail into cached samples, dropping entries before `keepFrom`.
 * Samples are the same when time, auth id and both resets match; the incoming one
 * wins. Two samples in the same second with different resets are both kept.
 */
export function mergeSamples(
  cached: QuotaHistorySample[],
  incoming: QuotaHistorySample[],
  keepFrom: number
): QuotaHistorySample[] {
  const byKey = new Map<string, QuotaHistorySample>();
  [...cached, ...incoming].forEach((sample) => {
    if (sample.t >= keepFrom) byKey.set(mergeKey(sample), sample);
  });
  return Array.from(byKey.values()).sort(compareSamples);
}

const sameWindows = (a: QuotaHistorySample, b: QuotaHistorySample) =>
  a.r5 === b.r5 && a.r7 === b.r7;

/**
 * The backend's step thinning, applied to samples at or after `from`: per auth, keep
 * its first sample, the last sample of each `stepMs` bucket and both neighbours of
 * every r5 or r7 change. Idempotent on thinned data, so it only removes what a tail merge adds: the
 * cached last sample of a bucket that was still filling at the previous fetch.
 */
export function thinSamples(
  samples: QuotaHistorySample[],
  stepMs: number,
  from: number
): QuotaHistorySample[] {
  if (stepMs <= 0) return samples;
  const kept = new Set<QuotaHistorySample>();
  groupSamplesByAccount(samples).forEach((own) => {
    own.forEach((sample, index) => {
      const previous = own[index - 1];
      const next = own[index + 1];
      if (
        sample.t < from ||
        !next ||
        Math.floor(next.t / stepMs) !== Math.floor(sample.t / stepMs) ||
        !previous ||
        !sameWindows(previous, sample) ||
        !sameWindows(sample, next)
      ) {
        kept.add(sample);
      }
    });
  });
  return kept.size === samples.length ? samples : samples.filter((sample) => kept.has(sample));
}
