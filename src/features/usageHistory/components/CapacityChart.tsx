import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChartData } from '../chartData';
import { formatShare, seriesColor } from '../format';
import styles from './CapacityChart.module.scss';

const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 100;
const GRID_RATIOS = [1, 0.75, 0.5, 0.25, 0];
/** Past this point a marker's label sits left of its line so it is not clipped. */
const MARKER_FLIP_AT = 0.7;
/** Labelled dots closer than this (viewBox units) would print their labels on top of each other. */
const LABEL_CLASH_X = 60;
const LABEL_CLASH_Y = 15;

export interface ChartMarker {
  /** 0..1 along the time axis. */
  position: number;
  label?: string;
  tone: 'now' | 'runway';
}

export interface AxisTick {
  position: number;
  label: string;
}

interface CapacityChartProps {
  data: ChartData;
  mode: 'stacked' | 'multiples';
  xTicks: AxisTick[];
  markers?: ChartMarker[];
  formatTime: (time: number) => string;
  ariaLabel: string;
  /** Grid index highlighted before any pointer or key input; none by default. */
  defaultActiveIndex?: number | null;
}

const xOf = (positions: number[], index: number) =>
  positions.length > 1 ? (positions[index] ?? 0) * VIEW_WIDTH : VIEW_WIDTH / 2;

/** Grid index whose position is closest to `ratio`; positions ascend. */
function nearestIndex(positions: number[], ratio: number): number {
  let lo = 0;
  let hi = positions.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (positions[mid] < ratio) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && ratio - positions[lo - 1] < positions[lo] - ratio ? lo - 1 : lo;
}

const pct = (value: number) => `${value.toFixed(3)}%`;

/** A band's top per grid point; null where the account has no data and draws nothing. */
type Top = Array<number | null>;

/** Index ranges inside `[from, to]` where `top` has data, each at least two points wide. */
function dataRuns(top: Top, from: number, to: number): Array<[number, number]> {
  const runs: Array<[number, number]> = [];
  let start = -1;
  for (let index = from; index <= to + 1; index += 1) {
    const present = index <= to && top[index] !== null && top[index] !== undefined;
    if (present && start < 0) start = index;
    if (!present && start >= 0) {
      if (index - 1 > start) runs.push([start, index - 1]);
      start = -1;
    }
  }
  return runs;
}

/** Area between two polylines over grid indices `[from, to]`, skipping gaps in `top`. */
function bandPath(
  positions: number[],
  top: Top,
  base: number[],
  from: number,
  to: number,
  y: (v: number) => number
) {
  let path = '';
  dataRuns(top, from, to).forEach(([start, end]) => {
    for (let index = start; index <= end; index += 1) {
      path += `${index === start ? 'M' : 'L'}${xOf(positions, index).toFixed(2)} ${y(top[index] ?? 0).toFixed(2)} `;
    }
    for (let index = end; index >= start; index -= 1) {
      path += `L${xOf(positions, index).toFixed(2)} ${y(base[index]).toFixed(2)} `;
    }
    path += 'Z ';
  });
  return path.trim();
}

function linePath(
  positions: number[],
  values: Top,
  from: number,
  to: number,
  y: (v: number) => number
) {
  let path = '';
  dataRuns(values, from, to).forEach(([start, end]) => {
    for (let index = start; index <= end; index += 1) {
      path += `${index === start ? 'M' : 'L'}${xOf(positions, index).toFixed(2)} ${y(values[index] ?? 0).toFixed(2)} `;
    }
  });
  return path.trim();
}

interface CanvasProps {
  positions: number[];
  tops: Top[];
  bases: number[][];
  /** Each band's height at 100%, as a share of the plot. */
  shares: number[];
  slots: number[];
  splitIndex?: number;
  dots: ChartData['dots'];
  activeIndex: number | null;
  /** Band under the pointer, drawn at hover strength. */
  activeSeries: number | null;
  /** Value written to `data-canvas`, used to find the hovered band. */
  canvasId: string;
  markers: ChartMarker[];
  resetTicks: ChartData['resetTicks'];
  className: string;
}

/** One SVG plot: stacked bands (or a single band), reset dots, markers and crosshair. */
function Canvas({
  positions,
  tops,
  bases,
  shares,
  slots,
  splitIndex,
  dots,
  activeIndex,
  activeSeries,
  canvasId,
  markers,
  resetTicks,
  className,
}: CanvasProps) {
  const count = tops[0]?.length ?? 0;
  const y = (value: number) => VIEW_HEIGHT - value * VIEW_HEIGHT;
  const last = count - 1;
  const split = splitIndex === undefined ? last : Math.min(splitIndex, last);
  // A dot sits on its band's top; if that grid point has no data it sits at base + leftover.
  const dotTop = (dot: ChartData['dots'][number]): number | undefined => {
    const top = tops[dot.series]?.[dot.index];
    if (top !== null) return top;
    const base = bases[dot.series]?.[dot.index];
    return base === undefined ? undefined : base + dot.value * (shares[dot.series] ?? 0);
  };
  const dotY = (dot: ChartData['dots'][number]) => y(dotTop(dot) ?? 0);
  // A labelled dot right under another one puts its label below, so the two do not overlap.
  const labelled = dots.filter((dot) => dot.labelled);
  const labelsBelow = new Set(
    labelled.filter((dot) =>
      labelled.some(
        (other) =>
          other !== dot &&
          Math.abs(xOf(positions, other.index) - xOf(positions, dot.index)) < LABEL_CLASH_X &&
          dotY(dot) - dotY(other) >= 0 &&
          dotY(dot) - dotY(other) < LABEL_CLASH_Y &&
          (dotY(dot) > dotY(other) || other.series < dot.series)
      )
    )
  );

  return (
    <div className={className} data-canvas={canvasId}>
      <div className={styles.gridlines} aria-hidden="true">
        {GRID_RATIOS.map((ratio) => (
          <span key={ratio} className={styles.gridline} style={{ top: `${(1 - ratio) * 100}%` }} />
        ))}
      </div>
      <svg
        className={styles.svg}
        viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        {tops.map((top, index) => {
          const fill = seriesColor(slots[index]);
          const band = `${styles.band} ${index === activeSeries ? styles.bandActive : ''}`;
          const observed = bandPath(positions, top, bases[index], 0, split, y);
          const projected =
            split < last ? bandPath(positions, top, bases[index], split, last, y) : '';
          return (
            <g key={slots[index]}>
              {observed && <path className={band} d={observed} style={{ fill }} />}
              {projected && (
                <path
                  className={`${band} ${styles.bandProjected}`}
                  d={projected}
                  style={{ fill }}
                />
              )}
            </g>
          );
        })}
        {/* Edges after every band, so the next band's seam does not paint over them. */}
        {split < last &&
          tops.map((top, index) => {
            const edge = linePath(positions, top, split, last, y);
            return edge ? (
              <path
                key={slots[index]}
                className={styles.projectedEdge}
                d={edge}
                style={{ stroke: seriesColor(slots[index]) }}
              />
            ) : null;
          })}
      </svg>

      {dots.map((dot) => {
        const seriesTop = dotTop(dot);
        if (seriesTop === undefined) return null;
        const below = dot.labelled && labelsBelow.has(dot);
        return (
          <span
            key={`${dot.series}-${dot.index}`}
            className={styles.dot}
            style={{
              left: pct((xOf(positions, dot.index) / VIEW_WIDTH) * 100),
              top: pct((y(seriesTop) / VIEW_HEIGHT) * 100),
              background: seriesColor(slots[dot.series]),
            }}
            aria-hidden="true"
          >
            {dot.labelled && (
              <span className={`${styles.dotLabel} ${below ? styles.dotLabelBelow : ''}`}>
                {formatShare(dot.value)}
              </span>
            )}
          </span>
        );
      })}

      {resetTicks.map((tick) => (
        <span
          key={`${tick.series}-${tick.position}`}
          className={styles.resetTick}
          style={{ left: pct(tick.position * 100), background: seriesColor(slots[tick.series]) }}
          aria-hidden="true"
        />
      ))}

      {markers.map((marker) => (
        <span
          key={`${marker.tone}-${marker.position}`}
          className={marker.tone === 'runway' ? styles.markerRunway : styles.markerNow}
          style={{ left: pct(marker.position * 100) }}
          aria-hidden="true"
        >
          {marker.label && (
            <span
              className={`${styles.markerLabel} ${
                marker.position > MARKER_FLIP_AT ? styles.markerLabelEnd : ''
              }`}
            >
              {marker.label}
            </span>
          )}
        </span>
      ))}

      {activeIndex !== null && count > 0 && (
        <span
          className={styles.crosshair}
          style={{ left: pct((xOf(positions, activeIndex) / VIEW_WIDTH) * 100) }}
          aria-hidden="true"
        />
      )}
    </div>
  );
}

/**
 * Capacity left per account as a stacked area (or one row per account), hand-drawn
 * SVG. Pointer and arrow keys move a crosshair; the tooltip lists every account.
 */
export function CapacityChart({
  data,
  mode,
  xTicks,
  markers = [],
  formatTime,
  ariaLabel,
  defaultActiveIndex = null,
}: CapacityChartProps) {
  const { t } = useTranslation();
  const hintId = useId();
  const [storedIndex, setActiveIndex] = useState<number | null>(defaultActiveIndex);
  const [activeSeries, setActiveSeries] = useState<number | null>(null);
  const { times, positions, series, dots, resetTicks, splitIndex } = data;
  const count = times.length;
  // A refresh can shorten the grid under a held index; never read past its end.
  const activeIndex =
    storedIndex === null || count === 0 ? null : Math.max(0, Math.min(storedIndex, count - 1));
  const slots = useMemo(() => series.map((entry) => entry.account.slot), [series]);

  // Each band's height is its share of the total weight of the accounts with data, so
  // the stack reads as the share of the whole pool left; one never seen takes no room. A
  // band with no data at a point adds nothing there, so the bands above close down.
  const stacked = useMemo(() => {
    const seen = series.map((entry) => entry.values.some((value) => value != null));
    const totalWeight = series.reduce(
      (total, entry, index) => (seen[index] ? total + entry.weight : total),
      0
    );
    const tops: Top[] = [];
    const bases: number[][] = [];
    const shares: number[] = [];
    let running = new Array<number>(count).fill(0);
    series.forEach((entry, index) => {
      const share = seen[index] && totalWeight > 0 ? entry.weight / totalWeight : 0;
      const base = running;
      bases.push(base);
      shares.push(share);
      tops.push(
        base.map((value, index) => {
          const own = entry.values[index];
          return own === null || own === undefined ? null : value + own * share;
        })
      );
      running = base.map((value, index) => value + (entry.values[index] ?? 0) * share);
    });
    return { tops, bases, shares };
  }, [series, count]);

  if (series.length === 0 || count === 0) {
    return <p className={styles.empty}>{t('usage_history.chart_no_accounts')}</p>;
  }

  const clampIndex = (index: number) => Math.max(0, Math.min(count - 1, index));
  const keyStep = Math.max(1, Math.ceil(count / 48));

  /** Series whose band is under the pointer at grid `index`, or null. */
  const seriesUnder = (event: PointerEvent<HTMLDivElement>, index: number): number | null => {
    const canvas = event.target instanceof Element ? event.target.closest('[data-canvas]') : null;
    if (!(canvas instanceof HTMLElement)) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.height <= 0) return null;
    const value = 1 - (event.clientY - rect.top) / rect.height;
    if (canvas.dataset.canvas === 'stack') {
      const found = stacked.tops.findIndex((top, seriesIndex) => {
        const topValue = top[index];
        return topValue != null && value >= stacked.bases[seriesIndex][index] && value < topValue;
      });
      return found < 0 ? null : found;
    }
    const row = Number(canvas.dataset.canvas);
    const rowValue = series[row]?.values[index];
    return rowValue != null && value >= 0 && value <= rowValue ? row : null;
  };

  const handlePointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = (event.clientX - rect.left) / rect.width;
    const index = clampIndex(nearestIndex(positions, ratio));
    setActiveIndex(index);
    setActiveSeries(seriesUnder(event, index));
  };

  const clearActive = () => {
    setActiveIndex(null);
    setActiveSeries(null);
  };

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 1 : keyStep;
    const current = activeIndex ?? count - 1;
    const next =
      event.key === 'ArrowLeft'
        ? current - step
        : event.key === 'ArrowRight'
          ? current + step
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? count - 1
              : null;
    if (event.key === 'Escape') {
      clearActive();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    setActiveIndex(clampIndex(next));
    setActiveSeries(null);
  };

  /** Capacity left over the accounts with a reading at `index`, weighted by window size. */
  const groupAt = (index: number) => {
    const readings = series.flatMap((entry) => {
      const value = entry.values[index];
      return value === null || value === undefined ? [] : [{ value, weight: entry.weight }];
    });
    const weight = readings.reduce((total, reading) => total + reading.weight, 0);
    const value =
      weight > 0
        ? readings.reduce((total, reading) => total + reading.value * reading.weight, 0) / weight
        : null;
    return { value, count: readings.length };
  };
  const projectedAt = (index: number) => splitIndex !== undefined && index > splitIndex;
  const activeRatio = activeIndex === null ? 0 : (positions[activeIndex] ?? 0);
  const group = activeIndex === null ? null : groupAt(activeIndex);

  const canvasProps = {
    positions,
    splitIndex,
    activeIndex,
    markers,
  };

  return (
    <figure className={styles.chart}>
      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {mode === 'stacked' &&
            GRID_RATIOS.map((ratio) => (
              <span key={ratio} className={styles.yTick} style={{ top: `${(1 - ratio) * 100}%` }}>
                {formatShare(ratio)}
              </span>
            ))}
        </div>

        <div
          className={styles.surface}
          tabIndex={0}
          role="group"
          aria-label={ariaLabel}
          aria-describedby={hintId}
          onPointerMove={handlePointer}
          onPointerDown={handlePointer}
          onPointerLeave={clearActive}
          onKeyDown={handleKey}
          onFocus={() => setActiveIndex((current) => current ?? count - 1)}
          onBlur={clearActive}
        >
          <span id={hintId} className={styles.srOnly}>
            {t('usage_history.chart_keyboard_hint')}
          </span>
          {mode === 'stacked' ? (
            <Canvas
              {...canvasProps}
              className={styles.canvas}
              canvasId="stack"
              activeSeries={activeSeries}
              tops={stacked.tops}
              bases={stacked.bases}
              shares={stacked.shares}
              slots={slots}
              dots={dots}
              resetTicks={resetTicks}
            />
          ) : (
            series.map((entry, index) => (
              <div key={entry.account.authId} className={styles.row}>
                <span className={styles.rowLabel}>
                  <span
                    className={styles.swatch}
                    style={{ background: seriesColor(entry.account.slot) }}
                    aria-hidden="true"
                  />
                  {entry.account.label}
                </span>
                <Canvas
                  {...canvasProps}
                  className={styles.rowCanvas}
                  canvasId={String(index)}
                  activeSeries={activeSeries === index ? 0 : null}
                  markers={
                    index === 0
                      ? markers
                      : markers.map((marker) => ({ ...marker, label: undefined }))
                  }
                  tops={[entry.values]}
                  bases={[new Array<number>(count).fill(0)]}
                  shares={[1]}
                  slots={[entry.account.slot]}
                  dots={dots
                    .filter((dot) => dot.series === index)
                    .map((dot) => ({ ...dot, series: 0 }))}
                  resetTicks={resetTicks
                    .filter((tick) => tick.series === index)
                    .map((tick) => ({ ...tick, series: 0 }))}
                />
              </div>
            ))
          )}

          {activeIndex !== null && (
            <div
              className={styles.tooltip}
              style={{
                left: pct(activeRatio * 100),
                transform:
                  activeRatio < 0.2
                    ? 'translateX(8px)'
                    : activeRatio > 0.8
                      ? 'translateX(calc(-100% - 8px))'
                      : 'translateX(-50%)',
              }}
              role="status"
            >
              <span className={styles.tooltipTime}>
                {formatTime(times[activeIndex])}
                {projectedAt(activeIndex) && (
                  <span className={styles.tooltipNote}>{t('usage_history.legend_projected')}</span>
                )}
              </span>
              {series.map((entry) => {
                const value = entry.values[activeIndex];
                return (
                  <span key={entry.account.authId} className={styles.tooltipRow}>
                    <span
                      className={styles.tooltipKey}
                      style={{ background: seriesColor(entry.account.slot) }}
                      aria-hidden="true"
                    />
                    <span className={styles.tooltipName}>{entry.account.label}</span>
                    {value === null || value === undefined ? (
                      <span className={styles.tooltipNoData}>{t('usage_history.no_data')}</span>
                    ) : (
                      <b>{formatShare(value)}</b>
                    )}
                  </span>
                );
              })}
              {group && (
                <span className={`${styles.tooltipRow} ${styles.tooltipGroup}`}>
                  <span className={styles.tooltipName}>
                    {group.count > 0 && group.count < series.length
                      ? t('usage_history.group_left_partial', {
                          shown: group.count,
                          total: series.length,
                        })
                      : t('usage_history.group_left')}
                  </span>
                  {group.value === null ? (
                    <span className={styles.tooltipNoData}>{t('usage_history.no_data')}</span>
                  ) : (
                    <b>{formatShare(group.value)}</b>
                  )}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {xTicks.map((tick) => (
          <span
            key={`${tick.position}-${tick.label}`}
            className={styles.xTick}
            style={{
              left: pct(tick.position * 100),
              transform:
                tick.position <= 0
                  ? 'none'
                  : tick.position >= 1
                    ? 'translateX(-100%)'
                    : 'translateX(-50%)',
            }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </figure>
  );
}
