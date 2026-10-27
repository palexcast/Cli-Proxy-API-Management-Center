/**
 * Pre-fills Claude cards from the proxy's quota snapshot: once when the credential
 * list has loaded, and again whenever the page asks (after "Refresh all").
 * The snapshot read never reaches Anthropic; only the optional auto-refresh does,
 * through the existing per-account refresh.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { quotaSnapshotApi } from '@/services/api';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import type { QuotaFileEntry } from '../logic';
import { QUOTA_ADAPTERS, type QuotaAdapter } from '../providers';
import { mergeClaudeSnapshot, selectEntriesOlderThan } from '../providers/claude/snapshot';

export function useClaudeQuotaSnapshot(
  entries: QuotaFileEntry[],
  ready: boolean,
  sessionGeneration: number,
  autoRefreshMinutes: number,
  refreshQuota: (file: AuthFileItem, adapter: QuotaAdapter) => Promise<void>
) {
  const { t } = useTranslation();
  const entriesRef = useRef(entries);
  const autoRefreshRef = useRef({ autoRefreshMinutes, refreshQuota });
  const requestRef = useRef(0);
  const openedGenerationRef = useRef<number | null>(null);

  useEffect(() => {
    entriesRef.current = entries;
    autoRefreshRef.current = { autoRefreshMinutes, refreshQuota };
  }, [entries, autoRefreshMinutes, refreshQuota]);

  /** Resolves true when the snapshot was read and merged into the current session. */
  const loadSnapshot = useCallback(async (): Promise<boolean> => {
    const requestId = ++requestRef.current;
    const generation = captureQuotaCacheGeneration();
    try {
      const snapshot = await quotaSnapshotApi.get();
      if (requestId !== requestRef.current) return false;
      return commitIfQuotaCacheCurrent(generation, () => {
        useQuotaStore
          .getState()
          .setClaudeQuota((prev) =>
            mergeClaudeSnapshot(prev, entriesRef.current, snapshot, t, Date.now())
          );
      });
    } catch {
      // A proxy without the snapshot endpoint leaves the cards click-to-load.
      return false;
    }
  }, [t]);

  useEffect(() => {
    if (!ready || openedGenerationRef.current === sessionGeneration) return;
    openedGenerationRef.current = sessionGeneration;
    void loadSnapshot().then((loaded) => {
      const { autoRefreshMinutes: minutes, refreshQuota: refresh } = autoRefreshRef.current;
      if (!loaded || minutes <= 0) return;
      selectEntriesOlderThan(
        entriesRef.current,
        useQuotaStore.getState().claudeQuota,
        minutes * 60 * 1000,
        Date.now()
      ).forEach((entry) => void refresh(entry.file, QUOTA_ADAPTERS.claude));
    });
  }, [ready, sessionGeneration, loadSnapshot]);

  const reloadSnapshot = useCallback(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  return { reloadSnapshot };
}
