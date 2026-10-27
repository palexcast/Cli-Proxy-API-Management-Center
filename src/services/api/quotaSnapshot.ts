import { apiClient } from './client';
import { isRecord } from '@/utils/helpers';

const QUOTA_SNAPSHOT_TIMEOUT_MS = 15 * 1000;

/**
 * The proxy's latest known quota for one Claude auth. Times are epoch milliseconds;
 * utilization is a 0..1 fraction. Window fields come from the newest reading of that
 * window, which may be older than `observedAt` when the last sample carried only 5h.
 */
export interface QuotaSnapshotAccount {
  authId: string;
  name: string;
  label: string;
  provider: string;
  observedAt?: number;
  u5?: number;
  r5?: number;
  s5?: string;
  u7?: number;
  r7?: number;
  s7?: string;
  /** When the last usage-endpoint response below was received. */
  refreshedAt?: number;
  /** The raw usage-endpoint JSON object, for `claudeUsage.ts` to normalize. */
  usage?: Record<string, unknown>;
}

export interface QuotaSnapshot {
  generatedAt: number;
  accounts: QuotaSnapshotAccount[];
}

const readText = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

const readTime = (value: unknown): number | undefined => {
  if (typeof value !== 'string' || !value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const readFraction = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;

const readUnixSeconds = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value * 1000 : undefined;

const readStatus = (value: unknown): string | undefined => {
  const text = readText(value).toLowerCase();
  return text || undefined;
};

const normalizeAccount = (value: unknown): QuotaSnapshotAccount | null => {
  if (!isRecord(value)) return null;
  const authId = readText(value.auth_id);
  if (!authId) return null;
  const account: QuotaSnapshotAccount = {
    authId,
    name: readText(value.name),
    label: readText(value.label),
    provider: readText(value.provider).toLowerCase(),
  };
  const observedAt = readTime(value.observed_at);
  const u5 = readFraction(value.u5);
  const r5 = readUnixSeconds(value.r5);
  const s5 = readStatus(value.s5);
  const u7 = readFraction(value.u7);
  const r7 = readUnixSeconds(value.r7);
  const s7 = readStatus(value.s7);
  const refreshedAt = readTime(value.refreshed_at);
  if (observedAt !== undefined) account.observedAt = observedAt;
  if (u5 !== undefined) account.u5 = u5;
  if (r5 !== undefined) account.r5 = r5;
  if (s5) account.s5 = s5;
  if (u7 !== undefined) account.u7 = u7;
  if (r7 !== undefined) account.r7 = r7;
  if (s7) account.s7 = s7;
  // Usage without its receipt time cannot be ordered against the header fields.
  if (refreshedAt !== undefined && isRecord(value.usage)) {
    account.refreshedAt = refreshedAt;
    account.usage = value.usage;
  }
  return account;
};

/** Validate the untrusted payload; drop malformed entries instead of failing the page. */
export function normalizeQuotaSnapshot(raw: unknown): QuotaSnapshot {
  const record = isRecord(raw) ? raw : {};
  return {
    generatedAt: readTime(record.generated_at) ?? Date.now(),
    accounts: (Array.isArray(record.accounts) ? record.accounts : [])
      .map(normalizeAccount)
      .filter((account): account is QuotaSnapshotAccount => account !== null),
  };
}

export const quotaSnapshotApi = {
  get: async (): Promise<QuotaSnapshot> =>
    normalizeQuotaSnapshot(
      await apiClient.get<unknown>('/observability/quota-snapshot', {
        timeout: QUOTA_SNAPSHOT_TIMEOUT_MS,
      })
    ),
};
