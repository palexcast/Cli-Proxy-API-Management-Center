import { useTranslation } from 'react-i18next';
import type { AccountInfo } from '../model';
import { seriesColor } from '../format';
import styles from './Controls.module.scss';

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}

/** Pill segmented control; same vocabulary as the config page's ModeSwitch. */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: SegmentedProps<T>) {
  return (
    <div className={styles.segmented} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`${styles.segment} ${option.value === value ? styles.segmentActive : ''}`}
          aria-pressed={option.value === value}
          disabled={disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function PlanTag({ account }: { account: AccountInfo }) {
  const { t } = useTranslation();
  return <span className={styles.tag}>{t(`usage_history.tier_${account.tier}`)}</span>;
}

export function AccountName({ account }: { account: AccountInfo }) {
  return (
    <span className={styles.accountName}>
      <span
        className={styles.swatch}
        style={{ background: seriesColor(account.slot) }}
        aria-hidden="true"
      />
      <span className={styles.accountLabel}>{account.label}</span>
      <PlanTag account={account} />
    </span>
  );
}

interface LegendProps {
  accounts: AccountInfo[];
  activeIds: ReadonlySet<string>;
  showProjected?: boolean;
}

/** Always-on legend: every account with its plan; out-of-scope accounts are dimmed. */
export function ChartLegend({ accounts, activeIds, showProjected = false }: LegendProps) {
  const { t } = useTranslation();
  return (
    <ul className={styles.legend}>
      {accounts.map((account) => (
        <li
          key={account.authId}
          className={activeIds.has(account.authId) ? undefined : styles.legendOff}
        >
          <AccountName account={account} />
        </li>
      ))}
      {showProjected && (
        <li>
          <span className={styles.projectedKey} aria-hidden="true" />
          {t('usage_history.legend_projected')}
        </li>
      )}
    </ul>
  );
}
