/**
 * Quota page settings that persist across sessions (localStorage), unlike the
 * per-session tab and sort in uiState.ts.
 */

/** Minutes; 0 turns auto-refresh off. */
export const QUOTA_AUTO_REFRESH_OPTIONS = [0, 15, 30, 60] as const;
export type QuotaAutoRefreshMinutes = (typeof QUOTA_AUTO_REFRESH_OPTIONS)[number];

export type QuotaSettings = {
  /** Refresh Claude cards on open when their newest reading is older than this. */
  autoRefreshMinutes: QuotaAutoRefreshMinutes;
};

const QUOTA_SETTINGS_KEY = 'quotaPage.settings';
const DEFAULT_SETTINGS: QuotaSettings = { autoRefreshMinutes: 0 };

export const isQuotaAutoRefreshMinutes = (value: unknown): value is QuotaAutoRefreshMinutes =>
  QUOTA_AUTO_REFRESH_OPTIONS.includes(value as QuotaAutoRefreshMinutes);

export const parseQuotaSettings = (raw: string | null): QuotaSettings => {
  if (!raw) return DEFAULT_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Partial<QuotaSettings> | null;
    return {
      autoRefreshMinutes: isQuotaAutoRefreshMinutes(parsed?.autoRefreshMinutes)
        ? parsed.autoRefreshMinutes
        : DEFAULT_SETTINGS.autoRefreshMinutes,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const readQuotaSettings = (): QuotaSettings => {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    return parseQuotaSettings(window.localStorage.getItem(QUOTA_SETTINGS_KEY));
  } catch {
    return DEFAULT_SETTINGS;
  }
};

export const writeQuotaSettings = (settings: Partial<QuotaSettings>) => {
  if (typeof window === 'undefined') return;
  try {
    const next = { ...readQuotaSettings(), ...settings };
    window.localStorage.setItem(QUOTA_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
};
