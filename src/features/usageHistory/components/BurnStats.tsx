import { useTranslation } from 'react-i18next';
import { BURN_DISPLAY_SCALE, type Burn } from '../burn';
import type { WindowKind } from '../model';
import styles from './BurnStats.module.scss';

interface BurnStatsProps {
  kind: WindowKind;
  burn: Burn;
  /** The chart's grid, for the peak's time. */
  times: number[];
  /** A value in display units with its unit; `signed` writes a leading + or -. */
  formatRate: (value: number, signed?: boolean) => string;
  formatTime: (time: number) => string;
  /**
   * When given, burning now, the change and the average also read per day (the value is
   * per hour; this writes 24 times it with its unit). Only for spans of a day or more,
   * where that is what was used rather than a short burst stretched over a day; the peak
   * never reads per day.
   */
  formatDaily?: (perHour: number, signed?: boolean) => string;
}

/** A change smaller than this (display units) reads as the same pace. */
const SAME_PACE = 0.05;

const KEYS = {
  '5h': {
    nowDetail: 'usage_history.burn_now_detail_5h',
    faster: 'usage_history.burn_change_faster_5h',
    slower: 'usage_history.burn_change_slower_5h',
    same: 'usage_history.burn_change_same_5h',
    averageDetail: 'usage_history.burn_average_detail_5h',
  },
  '7d': {
    nowDetail: 'usage_history.burn_now_detail_7d',
    faster: 'usage_history.burn_change_faster_7d',
    slower: 'usage_history.burn_change_slower_7d',
    same: 'usage_history.burn_change_same_7d',
    averageDetail: 'usage_history.burn_average_detail_7d',
  },
} as const;

/** How fast the chart's pool is used now, how that changed, its peak and its average. */
export function BurnStats({
  kind,
  burn,
  times,
  formatRate,
  formatTime,
  formatDaily,
}: BurnStatsProps) {
  const { t } = useTranslation();
  const keys = KEYS[kind];
  const scale = BURN_DISPLAY_SCALE;
  const delta = (burn.now - burn.before) * scale;
  const pace = Math.abs(delta) < SAME_PACE ? 'same' : delta > 0 ? 'faster' : 'slower';
  const peak = burn.peakIndex === null ? null : burn.values[burn.peakIndex];
  const peakTime = burn.peakIndex === null ? undefined : times[burn.peakIndex];

  const daily = (perHour: number, signed?: boolean) => formatDaily?.(perHour, signed);

  const cells: Array<{
    key: string;
    label: string;
    value: string;
    daily?: string;
    detail: string;
  }> = [
    {
      key: 'now',
      label: t('usage_history.burn_now'),
      value: formatRate(burn.now * scale),
      daily: daily(burn.now * scale),
      detail: t(keys.nowDetail),
    },
    {
      key: 'change',
      label: t('usage_history.burn_change'),
      value: formatRate(pace === 'same' ? 0 : delta, pace !== 'same'),
      daily: pace === 'same' ? undefined : daily(delta, true),
      detail: t(keys[pace]),
    },
    {
      key: 'peak',
      label: t('usage_history.burn_peak'),
      value: formatRate((peak ?? 0) * scale),
      detail:
        peak === null || peak === undefined || peakTime === undefined
          ? t('usage_history.burn_peak_none')
          : t('usage_history.burn_peak_detail', { time: formatTime(peakTime) }),
    },
    {
      key: 'average',
      label: t('usage_history.burn_average'),
      value: formatRate(burn.average * scale),
      daily: daily(burn.average * scale),
      detail: t(keys.averageDetail),
    },
  ];

  return (
    <dl className={styles.stats} aria-label={t('usage_history.burn_title')}>
      {cells.map((cell) => (
        <div key={cell.key} className={styles.stat}>
          <dt className={styles.label}>{cell.label}</dt>
          <dd className={styles.value}>{cell.value}</dd>
          {cell.daily && <dd className={styles.daily}>{cell.daily}</dd>}
          <dd className={styles.detail}>{cell.detail}</dd>
        </div>
      ))}
    </dl>
  );
}
