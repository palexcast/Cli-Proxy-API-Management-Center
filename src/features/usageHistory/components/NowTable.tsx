import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/Select';
import { formatShare } from '../format';
import {
  HOUR_MS,
  TIERS,
  isActive,
  isTier,
  type AccountInfo,
  type Tier,
  type WindowKind,
} from '../model';
import { AccountName } from './Controls';
import styles from './NowTable.module.scss';

export interface NowRow {
  account: AccountInfo;
  /** Null when the account has no reading yet, as for every column below. */
  used5: number | null;
  reset5: number | null;
  /**
   * Hours until the account first runs dry in its plan's pooled 5h projection, or in its
   * weekly projection when `emptyInWeekly`; null when it lasts.
   */
  emptyIn5: number | null;
  /** The account has no 5h limit, so "Empty in" is weekly and the 5h columns stay empty. */
  emptyInWeekly: boolean;
  /** The weekly window is exhausted: no 5h requests until the weekly reset. */
  blocked5: boolean;
  used7: number | null;
  reset7: number | null;
  /** Plan window's leftover at its last reset. */
  lastLeftover: number | null;
  /** Plan window's projected leftover at its next reset (pooled projection for 5h). */
  nextLeftover: number | null;
}

interface NowTableProps {
  rows: NowRow[];
  now: number;
  formatDuration: (ms: number) => string;
  onTierChange: (account: AccountInfo, tier: Tier) => void;
}

export function NowTable({ rows, now, formatDuration, onTierChange }: NowTableProps) {
  const { t } = useTranslation();
  const tierOptions = TIERS.map((tier) => ({
    value: tier,
    label: t(`usage_history.tier_${tier}`),
  }));
  const resetsIn = (reset: number | null) => (reset === null ? '—' : formatDuration(reset - now));
  const used = (value: number | null) => (value === null ? '—' : formatShare(value));
  const windowValue = (kind: WindowKind, value: number | null) =>
    value === null
      ? '—'
      : t('usage_history.window_value', {
          window: t(`usage_history.window_${kind}`),
          value: formatShare(value),
        });

  return (
    <div className={styles.scroll}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">{t('usage_history.col_account')}</th>
            <th scope="col">{t('usage_history.col_plan')}</th>
            <th scope="col" className={styles.num}>
              {t('usage_history.col_used_5h')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage_history.col_resets_in')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage_history.col_empty_in')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage_history.col_used_7d')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage_history.col_resets_in')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage_history.col_leftover_last')}
            </th>
            <th scope="col" className={styles.num}>
              {t('usage_history.col_leftover_next')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const team = row.account.plan === 'team';
            const planKind: WindowKind = team ? '5h' : '7d';
            const cell5 = `${styles.num} ${team ? '' : styles.dim}`;
            // A weekly block makes the 5h figures moot; only "Empty in" says why.
            const cell5Blocked = `${styles.num} ${team && !row.blocked5 ? '' : styles.dim}`;
            const cell7 = `${styles.num} ${team ? styles.dim : ''}`;
            return (
              <tr
                key={row.account.authId}
                className={isActive(row.account) ? undefined : styles.rowInactive}
              >
                <th scope="row">
                  <AccountName account={row.account} />
                </th>
                <td>
                  <Select
                    size="sm"
                    value={row.account.tier}
                    options={tierOptions}
                    ariaLabel={t('usage_history.plan_label', { account: row.account.label })}
                    onChange={(value) => {
                      if (isTier(value)) onTierChange(row.account, value);
                    }}
                  />
                </td>
                <td className={cell5Blocked}>{used(row.used5)}</td>
                <td className={cell5Blocked}>{resetsIn(row.reset5)}</td>
                <td className={row.emptyInWeekly ? styles.num : cell5}>
                  {row.blocked5
                    ? t('usage_history.blocked_by_weekly')
                    : row.emptyIn5 === null
                      ? '—'
                      : row.emptyInWeekly
                        ? t('usage_history.window_value', {
                            window: t('usage_history.window_7d'),
                            value: formatDuration(row.emptyIn5 * HOUR_MS),
                          })
                        : formatDuration(row.emptyIn5 * HOUR_MS)}
                </td>
                <td className={cell7}>{used(row.used7)}</td>
                <td className={cell7}>{resetsIn(row.reset7)}</td>
                <td className={styles.num}>{windowValue(planKind, row.lastLeftover)}</td>
                <td className={styles.num}>{windowValue(planKind, row.nextLeftover)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
