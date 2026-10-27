import { useCallback, useEffect, useReducer, useRef } from 'react';
import { apiClient, quotaHistoryApi } from '@/services/api';
import { useAuthStore } from '@/stores';
import { getErrorMessage } from '@/utils/helpers';
import {
  INITIAL_HISTORY_STATE,
  applyResponse,
  planFetch,
  quotaHistoryReducer,
  type HistoryCache,
} from '../historyCache';

export const REFRESH_INTERVAL_MS = 60 * 1000;

interface CacheEntry extends HistoryCache {
  revision: number;
}

export interface QuotaHistoryRequest {
  /** Displayed span, ending now. */
  spanMs: number;
  /** Extra history before the span, so a window open at its start carries its value in. */
  leadMs: number;
  /** Backend thinning step in seconds; 0 means raw. */
  step: number;
}

/**
 * Loads `leadMs + spanMs` of history at `step`, then refetches only the tail at the
 * same step every minute while the page is visible. Each call keeps its own cache.
 * The previous data, and the span it covers (`spanMs` in the result), stay on screen
 * while a refetch runs; draw with that span, not the requested one.
 */
export function useQuotaHistory({ spanMs, leadMs, step }: QuotaHistoryRequest) {
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [state, dispatch] = useReducer(quotaHistoryReducer, INITIAL_HISTORY_STATE);
  const cacheRef = useRef<CacheEntry | null>(null);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current;
    if (!connected) {
      cacheRef.current = null;
      dispatch({ type: 'reset', loading: false });
      return;
    }
    const revision = apiClient.getConnectionRevision();
    const isCurrent = () =>
      requestId === requestRef.current && revision === apiClient.getConnectionRevision();

    if (cacheRef.current && cacheRef.current.revision !== revision) {
      // Another connection's data must never show under this one.
      cacheRef.current = null;
      dispatch({ type: 'reset', loading: true });
    } else {
      dispatch({ type: 'start' });
    }

    const now = Date.now();
    const since = now - spanMs - leadMs;
    const { cached, fetchSince } = planFetch(cacheRef.current, since, step);

    try {
      // No `until`: the proxy then ends at its own clock, so a client clock running
      // behind it cannot cut off the newest samples.
      const response = await quotaHistoryApi.get({ since: fetchSince, step });
      if (!isCurrent()) return;
      const entry = applyResponse(cached, response, since, step, fetchSince);
      cacheRef.current = { ...entry, revision };
      dispatch({ type: 'success', history: entry.history, spanMs, fetchedAt: now });
    } catch (err: unknown) {
      if (!isCurrent()) return;
      dispatch({ type: 'failure', error: getErrorMessage(err) });
    }
  }, [connected, spanMs, leadMs, step]);

  useEffect(() => {
    void refresh();
    return () => {
      requestRef.current += 1;
    };
  }, [refresh]);

  const fetchedAtRef = useRef(0);
  useEffect(() => {
    fetchedAtRef.current = state.fetchedAt;
  }, [state.fetchedAt]);

  useEffect(() => {
    if (!connected) return;
    const tick = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    const onVisibility = () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - fetchedAtRef.current >= REFRESH_INTERVAL_MS
      ) {
        void refresh();
      }
    };
    const id = window.setInterval(tick, REFRESH_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [connected, refresh]);

  return { ...state, refresh };
}
