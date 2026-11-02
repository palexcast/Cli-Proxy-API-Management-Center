/**
 * Claude card pre-fill from the proxy's quota snapshot.
 * React-free so the merge rules can be tested directly.
 */

import type { TFunction } from 'i18next';
import type { ClaudeQuotaState, ClaudeQuotaWindow } from '@/types';
import type { QuotaSnapshot, QuotaSnapshotAccount } from '@/services/api/quotaSnapshot';
import { normalizeClaudeUsageSnapshot } from '@/services/api/claudeUsage';
import {
  CLAUDE_USAGE_WINDOW_KEYS,
  claudePeriodHours,
  formatInstantShort,
  formatQuotaResetTime,
  parseClaudeUsagePayload,
} from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import type { QuotaFileEntry } from '../../logic';
import { buildClaudeQuotaWindows } from './data';

/** Pre-filled data older than this is marked stale. */
export const SNAPSHOT_STALE_MS = 30 * 60 * 1000;

const overlayHeaderWindow = (
  windows: ClaudeQuotaWindow[],
  key: 'five_hour' | 'seven_day',
  used: number | undefined,
  resetMs: number | undefined,
  t: TFunction,
  now: number,
  /** The stored usage response reports this window as null: the account has none. */
  usageSaysNone: boolean
): ClaudeQuotaWindow[] => {
  if (used === undefined && resetMs === undefined) return windows;
  const meta = CLAUDE_USAGE_WINDOW_KEYS.find((window) => window.key === key)!;
  const existing = windows.find((window) => window.id === meta.id);
  // An account without a 5h limit (a verified Ultra plan) has a usage response with
  // five_hour null; its last 5h reading, long reset, would add a 0% 5h row.
  if (!existing && usageSaysNone && resetMs !== undefined && resetMs <= now) return windows;
  const next: ClaudeQuotaWindow = {
    id: meta.id,
    label: t(meta.labelKey),
    labelKey: meta.labelKey,
    // Headers carry a 0..1 fraction; the usage payload a percentage with one decimal.
    usedPercent:
      used !== undefined ? Math.round(used * 1000) / 10 : (existing?.usedPercent ?? null),
    resetLabel:
      resetMs !== undefined
        ? formatQuotaResetTime(new Date(resetMs).toISOString())
        : (existing?.resetLabel ?? '-'),
    resetAtMs: resetMs ?? existing?.resetAtMs ?? null,
    periodHours: claudePeriodHours(key),
  };
  if (existing) return windows.map((window) => (window === existing ? next : window));
  // The 5h window leads and the weekly one follows it, as in the usage payload.
  const index = key === 'five_hour' ? 0 : windows.findIndex((w) => w.id === 'five-hour') + 1;
  return [...windows.slice(0, index), next, ...windows.slice(index)];
};

/**
 * Card state for one snapshot account, or null when the snapshot knows nothing usable.
 * Windows come from the stored usage response; the header-observed 5h and 7d readings
 * replace those two windows when they are newer than the usage refresh. A window whose
 * reset has passed by `now` has refilled, so it shows no usage and no reset.
 */
export function buildClaudeSnapshotState(
  account: QuotaSnapshotAccount,
  t: TFunction,
  now: number
): ClaudeQuotaState | null {
  const payload = account.usage ? parseClaudeUsagePayload(account.usage) : null;
  const usage = payload ? normalizeClaudeUsageSnapshot(payload) : null;
  let windows: ClaudeQuotaWindow[] = [];
  if (payload && usage) {
    // Same filter as the live fetch: a full dollar balance is not a second plan meter.
    windows = buildClaudeQuotaWindows(payload, t).filter(
      (window) =>
        window.id !== 'cloud-session-credits' ||
        !usage.dollarWindows.some((balance) => balance.key === 'iguana_necktie')
    );
  }
  const usageAt = usage ? account.refreshedAt : undefined;
  const headersAt = account.observedAt;
  const headersNewer = headersAt !== undefined && (usageAt === undefined || headersAt > usageAt);
  if (headersNewer) {
    const none = (key: 'five_hour' | 'seven_day') =>
      payload !== null && (payload as Record<string, unknown>)[key] === null;
    windows = overlayHeaderWindow(
      windows,
      'five_hour',
      account.u5,
      account.r5,
      t,
      now,
      none('five_hour')
    );
    windows = overlayHeaderWindow(
      windows,
      'seven_day',
      account.u7,
      account.r7,
      t,
      now,
      none('seven_day')
    );
  }
  windows = windows.map((window) =>
    typeof window.resetAtMs === 'number' && window.resetAtMs <= now
      ? { ...window, usedPercent: 0, resetAtMs: null, resetLabel: '-' }
      : window
  );
  const newest = headersNewer ? headersAt : usageAt;
  if (newest === undefined) return null;
  const extraUsage = usage?.extraUsage ?? null;
  const dollarWindows = usage?.dollarWindows ?? [];
  if (windows.length === 0 && !extraUsage && dollarWindows.length === 0) return null;
  return {
    status: 'success',
    windows,
    extraUsage,
    dollarWindows,
    planType: null,
    observedAt: new Date(newest).toISOString(),
    stale: now - newest > SNAPSHOT_STALE_MS,
    snapshotSource: headersNewer ? 'headers' : 'usage',
  };
}

/** Claude credentials match by file name, then by auth id. */
export function findSnapshotAccount(
  snapshot: QuotaSnapshot,
  entry: QuotaFileEntry
): QuotaSnapshotAccount | undefined {
  const accounts = snapshot.accounts.filter((account) => account.provider === 'claude');
  const id = typeof entry.file.id === 'string' ? entry.file.id : '';
  return (
    accounts.find((account) => account.name && account.name === entry.file.name) ??
    (id ? accounts.find((account) => account.authId === id) : undefined)
  );
}

/**
 * Pre-fill only what this session has not read yet, or replace an older pre-fill.
 * A card this session read stays for the session, even when proxied traffic makes the
 * snapshot newer. Loading and error states belong to a fetch in flight or a failure to show.
 */
const shouldPrefill = (current: ClaudeQuotaState | undefined, next: ClaudeQuotaState): boolean => {
  if (!current || current.status === 'idle') return true;
  if (current.status !== 'success' || !current.snapshotSource) return false;
  if (!current.observedAt) return true;
  return Date.parse(current.observedAt) < Date.parse(next.observedAt ?? '');
};

/** Returns `prev` itself when nothing changes, so the store can skip a render. */
export function mergeClaudeSnapshot(
  prev: Record<string, ClaudeQuotaState>,
  entries: QuotaFileEntry[],
  snapshot: QuotaSnapshot,
  t: TFunction,
  now: number
): Record<string, ClaudeQuotaState> {
  let next = prev;
  entries.forEach((entry) => {
    if (entry.type !== 'claude') return;
    const account = findSnapshotAccount(snapshot, entry);
    if (!account) return;
    const state = buildClaudeSnapshotState(account, t, now);
    const key = getQuotaCacheKey(entry.file);
    const current = prev[key];
    if (!state || !shouldPrefill(current, state)) return;
    if (next === prev) next = { ...prev };
    // The snapshot has no profile; keep a plan this session already resolved.
    next[key] = current?.planType ? { ...state, planType: current.planType } : state;
  });
  return next;
}

/** Claude entries whose newest known reading is missing or older than `maxAgeMs`. */
export function selectEntriesOlderThan(
  entries: QuotaFileEntry[],
  quota: Record<string, ClaudeQuotaState>,
  maxAgeMs: number,
  now: number
): QuotaFileEntry[] {
  return entries.filter((entry) => {
    if (entry.type !== 'claude' || entry.file.disabled) return false;
    const state = quota[getQuotaCacheKey(entry.file)];
    if (state?.status === 'loading') return false;
    const observed = state?.observedAt ? Date.parse(state.observedAt) : Number.NaN;
    return !Number.isFinite(observed) || now - observed > maxAgeMs;
  });
}

/** One-line "as of" text for a Claude card, or null when there is nothing to date. */
export function describeClaudeObservation(
  quota: ClaudeQuotaState,
  now: number,
  t: TFunction
): { text: string; title: string; stale: boolean } | null {
  if (!quota.observedAt) return null;
  // A failed session refresh already shows its own stale notice with the time.
  if (quota.stale && !quota.snapshotSource) return null;
  const ms = Date.parse(quota.observedAt);
  if (!Number.isFinite(ms)) return null;
  const sameDay = new Date(ms).toDateString() === new Date(now).toDateString();
  const time = sameDay
    ? new Date(ms).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : formatInstantShort(ms);
  return {
    text: t(
      quota.snapshotSource === 'headers'
        ? 'claude_quota.observed_headers'
        : 'claude_quota.observed_refreshed',
      { time }
    ),
    title: new Date(ms).toLocaleString(undefined, { hourCycle: 'h23' }),
    stale: Boolean(quota.stale),
  };
}
