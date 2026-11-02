/**
 * Usage history: how much of each Claude account's 5h and 7d rate-limit windows was
 * left over time, what was left at each reset, and when the open capacity runs out.
 *
 * Data: GET /v8/management/observability/quota-history (recorded from the
 * anthropic-ratelimit-unified-* response headers), fetched twice with backend
 * thinning: the 5h range at a fine step, the weekly range at a coarse one. The weekly
 * samples lead the 5h ones in, so an account is "no data" only until the proxy has seen
 * it in either. All figures come from the pure modules model.ts, projection.ts and
 * chartData.ts.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconRefreshCw } from '@/components/ui/icons';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useRevealGroup } from '@/hooks/motion';
import type { QuotaHistorySample } from '@/services/api/quotaHistory';
import { useAuthStore } from '@/stores';
import { axisPosition, buildCapacityChart, type ChartData } from './chartData';
import { CapacityChart, type AxisTick, type ChartMarker } from './components/CapacityChart';
import { ChartLegend, Segmented } from './components/Controls';
import { RunwayTile } from './components/RunwayTile';
import { durationParts } from './format';
import { useQuotaHistory } from './hooks/useQuotaHistory';
import {
  DAY_MS,
  HOUR_MS,
  WINDOW_SPAN_MS,
  buildAccounts,
  buildWindows,
  accountsWithWeeklyReadings,
  groupSamplesByAccount,
  recordingStart,
  withLead,
  capacity5h,
  capacity7d,
  hasFiveHourLimit,
  isActive,
  type AccountInfo,
  type QuotaWindow,
} from './model';
import { buildPools, type TeamScope } from './pools';
import { projectAccount, type AccountProjection } from './projection';
import styles from './UsageHistoryPage.module.scss';

type Range5 = '6h' | '12h' | '24h' | '48h' | '7d';
type Range7 = '2w' | '4w' | '8w';

const RANGE_5_MS: Record<Range5, number> = {
  '6h': 6 * HOUR_MS,
  '12h': 12 * HOUR_MS,
  '24h': DAY_MS,
  '48h': 2 * DAY_MS,
  '7d': 7 * DAY_MS,
};
const RANGE_7_MS: Record<Range7, number> = {
  '2w': 14 * DAY_MS,
  '4w': 28 * DAY_MS,
  '8w': 56 * DAY_MS,
};
/**
 * Backend thinning per range, in seconds: a point per minute for the short 5h ranges,
 * coarser where the chart has fewer pixels per hour. Reset boundaries stay exact.
 */
const STEP_5: Record<Range5, number> = { '6h': 60, '12h': 60, '24h': 60, '48h': 60, '7d': 300 };
const STEP_7 = 900;
const CHART_POINTS = 360;
/** Projected tails: the next 5 hours, and a week so every weekly reset shows. */
const TAIL_5H_MS = 5 * HOUR_MS;
const TAIL_7D_MS = WINDOW_SPAN_MS['7d'];
/** Ticks over the observed range, as fractions of it; "now" and the tail end follow. */
const PAST_TICKS = [0, 0.25, 0.5, 0.75];
/** The tail-end tick is dropped when it would crowd the "now" tick. */
const MIN_END_TICK_GAP = 0.1;

interface Model {
  accounts: AccountInfo[];
  /**
   * Samples from the 5h request, led by the weekly request's earlier ones so an account
   * idle through the 5h range still carries its last reading; the weekly samples.
   */
  samples5: Map<string, QuotaHistorySample[]>;
  samples7: ReturnType<typeof groupSamplesByAccount>;
  windows5: Map<string, QuotaWindow[]>;
  windows7: Map<string, QuotaWindow[]>;
  projections5: Map<string, AccountProjection>;
  projections7: Map<string, AccountProjection>;
  start: number | null;
}

export function UsageHistoryPage() {
  const { t, i18n } = useTranslation();
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const revealRef = useRevealGroup<HTMLDivElement>();

  const [range5, setRange5] = useState<Range5>('6h');
  const [range7, setRange7] = useState<Range7>('4w');
  const [scope5, setScope5] = useState<TeamScope>('all');

  // Two requests with their own caches; each starts one window before its range so a
  // window already open at the range start carries its value in.
  const history5 = useQuotaHistory({
    spanMs: RANGE_5_MS[range5],
    leadMs: WINDOW_SPAN_MS['5h'],
    step: STEP_5[range5],
  });
  const history7 = useQuotaHistory({
    spanMs: RANGE_7_MS[range7],
    leadMs: WINDOW_SPAN_MS['7d'],
    step: STEP_7,
  });
  const h5 = history5.history;
  const h7 = history7.history;
  // The spans the loaded data covers: a wider range waits for its data before it draws.
  const span5 = history5.spanMs;
  const span7 = history7.spanMs;
  const history = h5 && h7 ? { h5, h7 } : null;
  const now = Math.max(history5.fetchedAt, history7.fetchedAt);
  const loading = history5.loading || history7.loading;
  const error = history5.error || history7.error;
  const truncated = (h5?.truncated ?? false) || (h7?.truncated ?? false);
  const refresh5 = history5.refresh;
  const refresh7 = history7.refresh;
  const refresh = useCallback(async () => {
    await Promise.all([refresh5(), refresh7()]);
  }, [refresh5, refresh7]);
  useHeaderRefresh(refresh);

  /* ---------- formatting ---------- */

  const language = i18n.language;
  const formatters = useMemo(() => {
    // Clock times read as 24h in every locale, like the Quota page.
    const clock = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } as const;
    return {
      clock: new Intl.DateTimeFormat(language, clock),
      dayClock: new Intl.DateTimeFormat(language, { weekday: 'short', ...clock }),
      day: new Intl.DateTimeFormat(language, { month: 'short', day: 'numeric' }),
      full: new Intl.DateTimeFormat(language, {
        month: 'short',
        day: 'numeric',
        weekday: 'short',
        ...clock,
      }),
    };
  }, [language]);
  const formatClock = useCallback((time: number) => formatters.clock.format(time), [formatters]);
  const formatTime = useCallback((time: number) => formatters.full.format(time), [formatters]);
  const formatDuration = useCallback(
    (ms: number) => {
      const parts = durationParts(ms);
      return parts.unit === 'dh'
        ? t('usage_history.duration_dh', { days: parts.days, hours: parts.hours })
        : t('usage_history.duration_hm', {
            hours: parts.hours,
            minutes: String(parts.minutes).padStart(2, '0'),
          });
    },
    [t]
  );

  /* ---------- model ---------- */

  const model = useMemo<Model | null>(() => {
    if (!h5 || !h7) return null;
    const listed = buildAccounts({
      accounts: [...h5.accounts, ...h7.accounts],
      samples: [...h5.samples, ...h7.samples],
    });
    const fine5 = groupSamplesByAccount(h5.samples);
    const samples7 = groupSamplesByAccount(h7.samples);
    const samples5 = new Map(
      listed.map(({ authId }) => [
        authId,
        withLead(fine5.get(authId) ?? [], samples7.get(authId) ?? []),
      ])
    );
    // The 5h samples carry the weekly lead, so they reach the last 5h reading even when
    // the 5h range holds only weekly ones. A disabled account is left off the page; it
    // is filtered after buildAccounts so every other account keeps its color slot.
    const accounts = listed
      .filter((account) => account.status !== 'disabled')
      .map((account) => ({
        ...account,
        fiveHourLimit: hasFiveHourLimit(samples5.get(account.authId) ?? []),
      }));
    const windows5 = new Map<string, QuotaWindow[]>();
    const windows7 = new Map<string, QuotaWindow[]>();
    const projections5 = new Map<string, AccountProjection>();
    const projections7 = new Map<string, AccountProjection>();
    accounts.forEach(({ authId }) => {
      const own5 = samples5.get(authId) ?? [];
      const own7 = samples7.get(authId) ?? [];
      windows5.set(authId, buildWindows(authId, own5, '5h'));
      windows7.set(authId, buildWindows(authId, own7, '7d'));
      projections5.set(authId, projectAccount(authId, own5, '5h', now));
      projections7.set(authId, projectAccount(authId, own7, '7d', now));
    });
    const starts = [recordingStart(h5.samples), recordingStart(h7.samples)].filter(
      (start): start is number => start !== null
    );
    return {
      accounts,
      samples5,
      samples7,
      windows5,
      windows7,
      projections5,
      projections7,
      start: starts.length > 0 ? Math.min(...starts) : null,
    };
  }, [h5, h7, now]);

  const team = useMemo(
    () => model?.accounts.filter((account) => account.plan === 'team') ?? [],
    [model]
  );

  /** Pooled 5h simulations: the Team pool for the tile, and the chart's scope. */
  const pools = useMemo(
    () => (model ? buildPools(model.accounts, model.projections5, scope5, now, TAIL_5H_MS) : null),
    [model, scope5, now]
  );

  /* ---------- charts ---------- */

  const axisTicks = useCallback(
    (
      { times, splitIndex = times.length - 1 }: ChartData,
      unit: 'clock' | 'dayClock' | 'day'
    ): AxisTick[] => {
      const from = times[0];
      const at = times[splitIndex];
      const end = times[times.length - 1];
      const label = (time: number) => formatters[unit].format(time);
      const ticks = PAST_TICKS.map((fraction) => {
        const time = from + (at - from) * fraction;
        return { position: axisPosition(times, time), label: label(time) };
      });
      const nowPosition = axisPosition(times, at);
      ticks.push({ position: nowPosition, label: t('usage_history.now') });
      if (1 - nowPosition >= MIN_END_TICK_GAP) ticks.push({ position: 1, label: label(end) });
      return ticks;
    },
    [formatters, t]
  );

  const nowMarker = useCallback(
    ({ times, splitIndex = times.length - 1 }: ChartData): ChartMarker => ({
      position: axisPosition(times, times[splitIndex]),
      tone: 'now',
    }),
    []
  );

  const chart5 = useMemo(() => {
    if (!model || !pools) return null;
    const accounts = scope5 === 'team' ? team : model.accounts;
    const data = buildCapacityChart({
      accounts,
      samples: model.samples5,
      windows: model.windows5,
      kind: '5h',
      from: now - span5,
      to: now,
      points: CHART_POINTS,
      weightOf: capacity5h,
      tail: { horizonMs: TAIL_5H_MS, projections: model.projections5, pool: pools.chart },
    });
    const markers = [nowMarker(data)];
    const { emptyAt } = pools.chart;
    if (emptyAt !== null) {
      markers.push({
        position: axisPosition(data.times, emptyAt),
        tone: 'runway',
        label: t('usage_history.runway_marker', {
          duration: formatDuration(emptyAt - now),
          time: formatClock(emptyAt),
        }),
      });
    }
    const unit = span5 >= RANGE_5_MS['7d'] ? 'day' : span5 < DAY_MS ? 'clock' : 'dayClock';
    return { accounts, data, markers, ticks: axisTicks(data, unit) };
  }, [
    model,
    pools,
    now,
    span5,
    scope5,
    team,
    axisTicks,
    nowMarker,
    t,
    formatDuration,
    formatClock,
  ]);

  const chart7 = useMemo(() => {
    if (!model) return null;
    // Only accounts with a weekly reading in range: a window at 0% is drawn, an
    // account whose responses never carried the weekly headers is left out.
    const accounts = accountsWithWeeklyReadings(model.accounts, model.samples7);
    const data = buildCapacityChart({
      accounts,
      samples: model.samples7,
      windows: model.windows7,
      kind: '7d',
      from: now - span7,
      to: now,
      points: CHART_POINTS,
      labelDots: (account) => account.plan === 'max',
      weightOf: capacity7d,
      tail: { horizonMs: TAIL_7D_MS, projections: model.projections7 },
    });
    return { accounts, data, markers: [nowMarker(data)], ticks: axisTicks(data, 'day') };
  }, [model, now, span7, axisTicks, nowMarker]);

  /* ---------- render ---------- */

  const activeIds = (accounts: AccountInfo[]) => new Set(accounts.map((account) => account.authId));
  const teamScopeOptions = [
    { value: 'all' as const, label: t('usage_history.scope_all') },
    { value: 'team' as const, label: t('usage_history.scope_team') },
  ];
  const hasSamples = history !== null && history.h5.samples.length + history.h7.samples.length > 0;

  return (
    <div className={styles.page} ref={revealRef}>
      <header className={styles.header}>
        <div className={styles.copy}>
          <h1 className={styles.title} data-reveal>
            {t('usage_history.title')}
          </h1>
          <p className={styles.meta} data-reveal>
            <span>
              {t('usage_history.meta_accounts', {
                count: model?.accounts.filter(isActive).length ?? 0,
              })}
            </span>
            {model?.start !== null && model?.start !== undefined && (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span>
                  {t('usage_history.meta_recording_since', {
                    time: formatters.full.format(model.start),
                  })}
                </span>
              </>
            )}
            {now > 0 && (
              <>
                <span className={styles.metaDot} aria-hidden="true">
                  ·
                </span>
                <span>{t('usage_history.meta_updated', { time: formatClock(now) })}</span>
              </>
            )}
          </p>
          <p className={styles.headerNote} data-reveal>
            {t('usage_history.header_note')}
          </p>
        </div>
        <div className={styles.actions} data-reveal>
          <Segmented
            label={t('usage_history.range_5h_label')}
            value={range5}
            options={(['6h', '12h', '24h', '48h', '7d'] as const).map((value) => ({
              value,
              label: t(`usage_history.range_${value}`),
            }))}
            onChange={setRange5}
          />
          <Segmented
            label={t('usage_history.range_7d_label')}
            value={range7}
            options={(['2w', '4w', '8w'] as const).map((value) => ({
              value,
              label: t(`usage_history.range_${value}`),
            }))}
            onChange={setRange7}
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void refresh()}
            disabled={!connected || loading}
            aria-label={t('usage_history.refresh')}
          >
            <IconRefreshCw size={14} className={loading ? styles.spinning : undefined} />
          </Button>
        </div>
      </header>

      {error && history && (
        <p className={styles.notice} role="alert">
          {t('usage_history.refresh_failed', { message: error })}
        </p>
      )}
      {truncated && <p className={styles.notice}>{t('usage_history.truncated')}</p>}

      {!history && loading && (
        <div className={styles.loading}>
          <LoadingSpinner size={24} />
        </div>
      )}
      {!history && !loading && (
        <EmptyState
          title={t('usage_history.error_title')}
          description={error || t('usage_history.disconnected')}
        />
      )}
      {history && !hasSamples && (
        <EmptyState
          title={t('usage_history.empty_title')}
          description={t('usage_history.empty_desc')}
        />
      )}

      {model && pools && hasSamples && chart5 && chart7 && (
        <>
          <section className={styles.tiles} aria-label={t('usage_history.tiles_label')}>
            <RunwayTile
              pool={pools.team}
              now={now}
              formatDuration={formatDuration}
              formatClock={formatClock}
            />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{t('usage_history.section_5h_title')}</h2>
            </div>
            <div className={styles.controls}>
              <Segmented
                label={t('usage_history.scope_label')}
                value={scope5}
                options={teamScopeOptions}
                onChange={setScope5}
              />
            </div>
            <CapacityChart
              data={chart5.data}
              mode="stacked"
              xTicks={chart5.ticks}
              markers={chart5.markers}
              formatTime={formatTime}
              ariaLabel={t('usage_history.chart_aria_5h')}
            />
            <ChartLegend
              accounts={model.accounts}
              activeIds={activeIds(chart5.accounts)}
              kind="5h"
              showProjected
            />
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>{t('usage_history.section_7d_title')}</h2>
            </div>
            <CapacityChart
              data={chart7.data}
              mode="stacked"
              xTicks={chart7.ticks}
              markers={chart7.markers}
              formatTime={formatTime}
              ariaLabel={t('usage_history.chart_aria_7d')}
            />
            <ChartLegend
              accounts={model.accounts}
              activeIds={activeIds(chart7.accounts)}
              kind="7d"
              showProjected
            />
          </section>
        </>
      )}
    </div>
  );
}
