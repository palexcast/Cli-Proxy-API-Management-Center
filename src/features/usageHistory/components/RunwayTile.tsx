import { useTranslation } from 'react-i18next';
import { formatShare } from '../format';
import type { PoolSimulation } from '../projection';
import styles from './RunwayTile.module.scss';

interface RunwayTileProps {
  /** The Team accounts' pooled 5h simulation. */
  pool: PoolSimulation;
  now: number;
  formatDuration: (ms: number) => string;
  formatClock: (time: number) => string;
}

/** Team 5h runway: when the simulated pool, refills included, first runs dry. */
export function RunwayTile({ pool, now, formatDuration, formatClock }: RunwayTileProps) {
  const { t } = useTranslation();
  const { emptyAt, nextRefill } = pool;
  return (
    <div className={styles.tile}>
      <span className={styles.tileLabel}>{t('usage_history.tile_runway')}</span>
      <span className={styles.tileValue}>
        {emptyAt === null ? '—' : formatDuration(emptyAt - now)}
      </span>
      <span className={styles.tileDetail}>
        {emptyAt !== null
          ? t('usage_history.tile_runway_detail', {
              time: formatClock(emptyAt),
              rate: formatShare(pool.capacity > 0 ? pool.demand / pool.capacity : 0),
            })
          : nextRefill !== null
            ? t('usage_history.tile_runway_beyond', { time: formatClock(nextRefill) })
            : t('usage_history.tile_runway_beyond_no_refill')}
      </span>
    </div>
  );
}
