import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

const QUOTA_HISTORY_TIMEOUT_MS = 30 * 1000;

/** A Claude auth the backend currently knows, used to map ids to labels. */
export interface QuotaHistoryAccount {
  authId: string;
  name: string;
  label: string;
  provider: string;
  /** Switched off by the operator: still loaded, takes no requests. */
  disabled: boolean;
}

/**
 * One observation of the `anthropic-ratelimit-unified-*` headers.
 * Times are epoch milliseconds; utilization is a 0..1 fraction.
 */
export interface QuotaHistorySample {
  t: number;
  authId: string;
  u5?: number;
  r5?: number;
  u7?: number;
  r7?: number;
  s5?: string;
  s7?: string;
}

export interface QuotaHistory {
  since: number;
  until: number;
  accounts: QuotaHistoryAccount[];
  samples: QuotaHistorySample[];
  truncated: boolean;
  /** Effective thinning step in seconds; 0 means raw samples. */
  step: number;
}

export interface QuotaHistoryQuery {
  since?: number;
  until?: number;
  authIds?: string[];
  /**
   * Thinning step in seconds; 0 or absent means raw. Per auth the backend keeps its
   * first sample in the range, the last sample of each step bucket and both
   * neighbours of every r5 or r7 change.
   */
  step?: number;
}

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readTime = (value: unknown): number | null => {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readFraction = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;

const readUnixSeconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;

const readStep = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;

const readStatus = (value: unknown): string | undefined => {
  const text = readText(value).toLowerCase();
  return text || undefined;
};

const normalizeAccount = (value: unknown): QuotaHistoryAccount | null => {
  if (!isRecord(value)) return null;
  const authId = readText(value.auth_id);
  if (!authId) return null;
  return {
    authId,
    name: readText(value.name),
    label: readText(value.label),
    provider: readText(value.provider).toLowerCase(),
    disabled: value.disabled === true,
  };
};

const normalizeSample = (value: unknown): QuotaHistorySample | null => {
  if (!isRecord(value)) return null;
  const t = readTime(value.t);
  const authId = readText(value.auth_id);
  if (t === null || !authId) return null;
  const sample: QuotaHistorySample = { t, authId };
  const u5 = readFraction(value.u5);
  const r5 = readUnixSeconds(value.r5);
  const u7 = readFraction(value.u7);
  const r7 = readUnixSeconds(value.r7);
  const s5 = readStatus(value.s5);
  const s7 = readStatus(value.s7);
  if (u5 !== undefined) sample.u5 = u5;
  if (r5 !== undefined) sample.r5 = r5;
  if (u7 !== undefined) sample.u7 = u7;
  if (r7 !== undefined) sample.r7 = r7;
  if (s5) sample.s5 = s5;
  if (s7) sample.s7 = s7;
  return sample;
};

/**
 * Time, then auth id, then reset: the recorder can write two samples in the same
 * second when a window resets, and the one with the later reset is the newer.
 */
export const compareSamples = (a: QuotaHistorySample, b: QuotaHistorySample): number =>
  a.t - b.t ||
  (a.authId < b.authId ? -1 : a.authId > b.authId ? 1 : 0) ||
  (a.r5 ?? 0) - (b.r5 ?? 0) ||
  (a.r7 ?? 0) - (b.r7 ?? 0);

/** Validate the untrusted payload; drop malformed entries instead of failing the page. */
export function normalizeQuotaHistory(raw: unknown): QuotaHistory {
  const record = isRecord(raw) ? raw : {};
  const accounts = (Array.isArray(record.accounts) ? record.accounts : [])
    .map(normalizeAccount)
    .filter((account): account is QuotaHistoryAccount => account !== null);
  const samples = (Array.isArray(record.samples) ? record.samples : [])
    .map(normalizeSample)
    .filter((sample): sample is QuotaHistorySample => sample !== null)
    .sort(compareSamples);
  const now = Date.now();
  return {
    since: readTime(record.since) ?? samples[0]?.t ?? now,
    until: readTime(record.until) ?? now,
    accounts,
    samples,
    truncated: record.truncated === true,
    step: readStep(record.step),
  };
}

const buildQuery = ({ since, until, authIds, step }: QuotaHistoryQuery): string => {
  const params = new URLSearchParams();
  if (since !== undefined) params.set('since', new Date(since).toISOString());
  if (until !== undefined) params.set('until', new Date(until).toISOString());
  if (step !== undefined && step > 0) params.set('step', String(Math.round(step)));
  // Repeatable parameter: axios would serialize an array as auth_id[]=…
  authIds?.forEach((id) => params.append('auth_id', id));
  const query = params.toString();
  return query ? `?${query}` : '';
};

export const quotaHistoryApi = {
  get: async (query: QuotaHistoryQuery = {}): Promise<QuotaHistory> =>
    normalizeQuotaHistory(
      await apiClient.get<unknown>(`/observability/quota-history${buildQuery(query)}`, {
        timeout: QUOTA_HISTORY_TIMEOUT_MS,
      })
    ),
};
