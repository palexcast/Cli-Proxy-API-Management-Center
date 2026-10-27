import { DAY_MS, HOUR_MS, MINUTE_MS, SERIES_SLOT_COUNT } from './model';

/** 0..1 as a whole percentage. */
export const formatShare = (value: number): string => `${Math.round(value * 100)}%`;

/** CSS color of an account's fixed series slot (tokens live on the page root). */
export const seriesColor = (slot: number): string => `var(--uh-series-${slot % SERIES_SLOT_COUNT})`;

export type DurationParts =
  { unit: 'dh'; days: number; hours: number } | { unit: 'hm'; hours: number; minutes: number };

/** Split a duration for the `duration_dh` / `duration_hm` messages. */
export function durationParts(ms: number): DurationParts {
  const safe = Math.max(0, ms);
  if (safe >= DAY_MS) {
    const totalHours = Math.round(safe / HOUR_MS);
    return { unit: 'dh', days: Math.floor(totalHours / 24), hours: totalHours % 24 };
  }
  const totalMinutes = Math.round(safe / MINUTE_MS);
  return { unit: 'hm', hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 };
}
