import { useTranslation } from 'react-i18next';
import { formatShare } from '../format';
import type { WindowKind } from '../model';
import type { PoolSimulation } from '../projection';
import styles from './RunwayTile.module.scss';

interface RunwayTileProps {
  /** 5h: the Team accounts' 5h pool. 7d: every account with weekly readings. */
  kind: WindowKind;
  pool: PoolSimulation;
  now: number;
  formatDuration: (ms: number) => string;
  formatClock: (time: number) => string;
}

/** Hours per demand unit shown: the 5h tile says per hour, the weekly tile per day. */
const RATE_HOURS: Record<WindowKind, number> = { '5h': 1, '7d': 24 };

const KEYS = {
  '5h': {
    label: 'usage_history.tile_runway',
    detail: 'usage_history.tile_runway_detail',
    beyond: 'usage_history.tile_runway_beyond',
    beyondNoRefill: 'usage_history.tile_runway_beyond_no_refill',
  },
  '7d': {
    label: 'usage_history.tile_runway_7d',
    detail: 'usage_history.tile_runway_7d_detail',
    beyond: 'usage_history.tile_runway_7d_beyond',
    beyondNoRefill: 'usage_history.tile_runway_7d_beyond_no_refill',
  },
} as const;

/** Runway: when the simulated pool, refills and failover included, first runs dry. */
export function RunwayTile({ kind, pool, now, formatDuration, formatClock }: RunwayTileProps) {
  const { t } = useTranslation();
  const { emptyAt, nextRefill } = pool;
  const keys = KEYS[kind];
  const rate = pool.capacity > 0 ? (pool.demand / pool.capacity) * RATE_HOURS[kind] : 0;
  const detail =
    kind === '7d' && pool.values.size === 0
      ? t('usage_history.tile_runway_7d_none')
      : emptyAt !== null
        ? t(keys.detail, { time: formatClock(emptyAt), rate: formatShare(rate) })
        : nextRefill !== null
          ? t(keys.beyond, { time: formatClock(nextRefill) })
          : t(keys.beyondNoRefill);
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{t(keys.label)}</span>
      <span className={styles.tileValue}>
        {emptyAt === null ? '—' : formatDuration(emptyAt - now)}
      </span>
      <span className={styles.tileDetail}>{detail}</span>
    </div>
  );
}
