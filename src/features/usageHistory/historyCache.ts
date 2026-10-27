/**
 * Cached history for one stepped request, how a refetch updates it, and the state the
 * hook exposes. Pure; the hook owns the timers and the connection guard.
 */

import type { QuotaHistory } from '@/services/api/quotaHistory';
import { MINUTE_MS, mergeSamples, thinSamples } from './model';

/** Refetch a little before the newest cached sample: the recorder writes asynchronously. */
export const REFETCH_OVERLAP_MS = 5 * MINUTE_MS;

export interface HistoryCache {
  /** Requested start, epoch ms. */
  since: number;
  /** Requested step, seconds. */
  step: number;
  history: QuotaHistory;
  /** Whether the last full fetch was capped; a tail refetch never clears or keeps it. */
  fullTruncated: boolean;
}

/**
 * Where the next request starts. A cache for the same step that already covers
 * `since` is extended with a tail refetch; anything else is a full fetch.
 */
export function planFetch(
  cache: HistoryCache | null,
  since: number,
  step: number
): { cached: HistoryCache | null; fetchSince: number } {
  const cached = cache && cache.since <= since && cache.step === step ? cache : null;
  if (!cached) return { cached: null, fetchSince: since };
  const samples = cached.history.samples;
  const newest = samples.length > 0 ? samples[samples.length - 1].t : cached.history.until;
  return { cached, fetchSince: Math.max(since, newest - REFETCH_OVERLAP_MS) };
}

/** The cache after `response` arrives for a request planned by `planFetch`. */
export function applyResponse(
  cached: HistoryCache | null,
  response: QuotaHistory,
  since: number,
  step: number,
  fetchSince: number
): HistoryCache {
  if (!cached) return { since, step, history: response, fullTruncated: response.truncated };
  const merged = mergeSamples(cached.history.samples, response.samples, since);
  return {
    since,
    step,
    fullTruncated: cached.fullTruncated,
    history: {
      ...response,
      since,
      // The overlap holds the previous fetch's last sample of a bucket that was still
      // filling; thin with the step the backend actually applied.
      samples: thinSamples(merged, response.step * 1000, fetchSince),
      truncated: cached.fullTruncated || response.truncated,
    },
  };
}

export interface QuotaHistoryState {
  history: QuotaHistory | null;
  /**
   * Displayed span `history` covers, ms. It changes only when a fetch for a new span
   * lands, so a wider range is not drawn over data that does not reach back that far.
   */
  spanMs: number;
  /** Client time of the last successful fetch; the charts' "now". */
  fetchedAt: number;
  loading: boolean;
  error: string;
}

export type QuotaHistoryAction =
  | { type: 'reset'; loading: boolean }
  | { type: 'start' }
  | { type: 'success'; history: QuotaHistory; spanMs: number; fetchedAt: number }
  | { type: 'failure'; error: string };

export const INITIAL_HISTORY_STATE: QuotaHistoryState = {
  history: null,
  spanMs: 0,
  fetchedAt: 0,
  loading: true,
  error: '',
};

/** The previous history and its span stay in place while a fetch runs or fails. */
export function quotaHistoryReducer(
  state: QuotaHistoryState,
  action: QuotaHistoryAction
): QuotaHistoryState {
  switch (action.type) {
    case 'reset':
      return { ...INITIAL_HISTORY_STATE, loading: action.loading };
    case 'start':
      return state.loading ? state : { ...state, loading: true };
    case 'success':
      return {
        history: action.history,
        spanMs: action.spanMs,
        fetchedAt: action.fetchedAt,
        loading: false,
        error: '',
      };
    case 'failure':
      return { ...state, loading: false, error: action.error };
  }
}
