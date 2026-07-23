"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GoldHistoryRange, GoldPricesApiSource } from "@/lib/types";
import { formatPercent } from "@/components/format";
import {
  CHART_H,
  CHART_PAD_RIGHT,
  CHART_PAD_TOP,
  CHART_PAD_X,
  CHART_W,
  areaPathsFor,
  collapseFlatRuns,
  linePathsFor,
  nearestTimedPoint,
  outageBands,
  outageThresholdMs,
  overlayPercent,
  parseTimedPoints,
  plotHeight,
  plotWidth,
  resolveTimeDomain,
  resolveValueDomain,
  timeAxisTicks,
  timeFromClientX,
  toPlotPoints,
  type PlotPoint,
  yFromValue,
  yGridValues
} from "@/components/chartMath";

const faTime = new Intl.DateTimeFormat("fa-IR", {
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Tehran"
});
const faDay = new Intl.DateTimeFormat("fa-IR", {
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Tehran"
});
const faDateTime = new Intl.DateTimeFormat("fa-IR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Asia/Tehran"
});
const faNum = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });

export type GoldSourceChartSeries = {
  source: GoldPricesApiSource;
  sourceName: string;
  points: Array<{ t: string; v: number }>;
};

export type GoldSourceChartData = {
  range: GoldHistoryRange;
  series: GoldSourceChartSeries[];
  changePercent: number | null;
};

export type GoldSourceChartFormatters = {
  formatValue: (value: number | null | undefined) => string;
  formatAxisValue?: (value: number) => string;
  formatAverage?: (value: number) => string;
  ariaLabel: string;
  emptyMessage?: string;
};

type ChartColors = {
  blue: string;
  blue2: string;
  green: string;
  yellow: string;
  red: string;
  card: string;
};

const LIGHT_COLORS: ChartColors = {
  blue: "#1774d1",
  blue2: "#0fb5d6",
  green: "#0c9c56",
  yellow: "#a9750f",
  red: "#dc2f3a",
  card: "rgba(255, 255, 255, 0.72)"
};

const DARK_COLORS: ChartColors = {
  blue: "#4aa9f0",
  blue2: "#35d0e0",
  green: "#22d07a",
  yellow: "#f2c14e",
  red: "#ff6b74",
  card: "rgba(18, 36, 56, 0.82)"
};

const SOURCE_COLORS: Record<GoldPricesApiSource, { stroke: keyof ChartColors }> = {
  navasan: { stroke: "blue" },
  bonbast: { stroke: "green" },
  talavest: { stroke: "yellow" }
};

const SOURCE_ORDER: Record<GoldPricesApiSource, number> = {
  navasan: 0,
  bonbast: 1,
  talavest: 2
};

function readChartColors(): ChartColors {
  if (typeof document === "undefined") return LIGHT_COLORS;
  const theme = document.documentElement.dataset.theme;
  const fallback = theme === "dark" ? DARK_COLORS : LIGHT_COLORS;
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fb: string) => style.getPropertyValue(name).trim() || fb;
  return {
    blue: pick("--blue", fallback.blue),
    blue2: pick("--blue-2", fallback.blue2),
    green: pick("--green", fallback.green),
    yellow: pick("--yellow", fallback.yellow),
    red: pick("--red", fallback.red),
    card: pick("--card", fallback.card)
  };
}

function useChartColors() {
  const [colors, setColors] = useState<ChartColors>(LIGHT_COLORS);
  useEffect(() => {
    const sync = () => setColors(readChartColors());
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return colors;
}

function axisLabel(ms: number, range: GoldHistoryRange) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDay.format(date) : faTime.format(date);
}

function tooltipLabel(iso: string, range: GoldHistoryRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDateTime.format(date) : faTime.format(date);
}

function sourceStroke(colors: ChartColors, source: GoldPricesApiSource) {
  return colors[SOURCE_COLORS[source].stroke];
}

export function GoldSourceChartPanel({
  data,
  formatters
}: {
  data: GoldSourceChartData;
  formatters: GoldSourceChartFormatters;
}) {
  const uid = useId().replace(/:/g, "");
  const colors = useChartColors();
  const bodyRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const formatAxisValue =
    formatters.formatAxisValue ?? ((value: number) => faNum.format(Math.round(value)));
  const formatAverage =
    formatters.formatAverage ?? ((value: number) => formatters.formatValue(Math.round(value)));

  const { range, series } = data;
  const orderedSeries = useMemo(
    () => [...series].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]),
    [series]
  );

  const geom = useMemo(() => {
    if (!orderedSeries.length) return null;

    const parsed = orderedSeries
      .map((entry) => {
        const timed = collapseFlatRuns(parseTimedPoints(entry.points));
        return { ...entry, timed };
      })
      .filter((entry) => entry.timed.length >= 1);

    if (!parsed.length) return null;

    const allTimes = parsed.flatMap((e) => e.timed.map((p) => p.time));
    const allValues = parsed.flatMap((e) => e.timed.map((p) => p.v));
    const { tMin, tMax } = resolveTimeDomain(allTimes, range);
    const { min, max } = resolveValueDomain(allValues);
    const plotW = plotWidth();
    const plotH = plotHeight(CHART_H);
    const baseY = CHART_PAD_TOP + plotH;

    const plotted = parsed.map((entry) => {
      const plotPoints: PlotPoint[] = toPlotPoints(entry.timed, tMin, tMax, min, max, plotW, plotH);
      return {
        ...entry,
        plotPoints,
        linePaths: linePathsFor(plotPoints, range, "smooth"),
        areaPaths: areaPathsFor(plotPoints, baseY, range, "smooth"),
        isSinglePoint: plotPoints.length === 1,
        last: plotPoints[plotPoints.length - 1]!
      };
    });

    const primary = plotted.find((e) => e.source === "navasan") ?? plotted[0]!;
    const avg = allValues.reduce((s, v) => s + v, 0) / allValues.length;
    const firstPrimary = primary.plotPoints[0]?.v;
    const change =
      data.changePercent ??
      (firstPrimary !== undefined && firstPrimary !== 0
        ? ((primary.last.v - firstPrimary) / firstPrimary) * 100
        : null);

    const bands = outageBands(allTimes, range, tMin, tMax, plotW, plotH);
    const xTicks = timeAxisTicks(tMin, tMax, range === "7d" ? 6 : 5);
    const yTicks = yGridValues(min, max, 5);

    return {
      min,
      max,
      tMin,
      tMax,
      plotW,
      plotH,
      baseY,
      plotted,
      primary,
      minV: Math.min(...allValues),
      maxV: Math.max(...allValues),
      lastV: primary.last.v,
      avg,
      change,
      bands,
      xTicks,
      yTicks,
      allTimes
    };
  }, [orderedSeries, data.changePercent, range]);

  const handlePointer = useCallback(
    (clientX: number) => {
      if (!geom || !svgRef.current) return;
      setHoverTime(timeFromClientX(clientX, svgRef.current, geom.tMin, geom.tMax, geom.plotW));
    },
    [geom]
  );
  const clearHover = useCallback(() => setHoverTime(null), []);

  if (!geom) {
    return (
      <div className="empty">
        {formatters.emptyMessage ??
          "هنوز داده کافی برای نمودار ثبت نشده است؛ با باز ماندن داشبورد، روند قیمت به‌مرور تکمیل می‌شود."}
      </div>
    );
  }

  const up = (geom.change ?? 0) >= 0;
  const isHovering = hoverTime !== null;
  const activeTime = hoverTime ?? geom.primary.last.time;
  const hoverWindowMs = Math.max(outageThresholdMs(range) * 0.75, 20 * 60_000);

  const hoverRows = geom.plotted
    .map((entry) => ({
      source: entry.source,
      sourceName: entry.sourceName,
      point: nearestTimedPoint(entry.plotPoints, activeTime, isHovering ? hoverWindowMs : undefined),
      color: sourceStroke(colors, entry.source)
    }))
    .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);

  const crosshairX = (() => {
    const span = Math.max(geom.tMax - geom.tMin, 1);
    const innerStart = CHART_PAD_X + geom.plotW * 0.02;
    const innerW = geom.plotW * 0.96;
    const ratio = Math.min(1, Math.max(0, (activeTime - geom.tMin) / span));
    return innerStart + ratio * innerW;
  })();

  const activeY =
    hoverRows.find((row) => row.source === geom.primary.source)?.point?.y ?? geom.primary.last.y;

  const overlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, crosshairX, activeY)
      : { left: (crosshairX / CHART_W) * 100, top: (activeY / CHART_H) * 100 };

  const lastOverlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, geom.primary.last.x, geom.primary.last.y)
      : { left: (geom.primary.last.x / CHART_W) * 100, top: (geom.primary.last.y / CHART_H) * 100 };

  const badgeLeft = Math.min(Math.max(lastOverlayPos.left, 8), 72);
  const navasanEntry = geom.plotted.find((entry) => entry.source === "navasan");
  const hasOutage = geom.bands.length > 0;

  return (
    <div className="median-chart-panel" data-chart-version="premium-v3-time">
      <div className="median-chart-mini-stats" aria-label="خلاصه بازه نمودار">
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">آخرین</span>
          <span className="median-mini-stat-value number">{formatters.formatValue(geom.lastV)}</span>
        </div>
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">کمترین</span>
          <span className="median-mini-stat-value number">{formatters.formatValue(geom.minV)}</span>
        </div>
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">بیشترین</span>
          <span className="median-mini-stat-value number">{formatters.formatValue(geom.maxV)}</span>
        </div>
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">میانگین</span>
          <span className="median-mini-stat-value number">{formatAverage(geom.avg)}</span>
        </div>
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">تغییر</span>
          <span className={`median-mini-stat-value number ${up ? "good" : "danger"}`}>
            {geom.change !== null ? formatPercent(geom.change) : "—"}
          </span>
        </div>
      </div>

      <div className="gold-chart-legend" aria-label="منابع قیمت طلا">
        {geom.plotted.map((entry) => (
          <span className="gold-chart-legend-item" key={entry.source}>
            <span
              className="gold-chart-legend-swatch"
              style={{ background: sourceStroke(colors, entry.source) }}
              aria-hidden="true"
            />
            {entry.sourceName}
          </span>
        ))}
        {hasOutage ? (
          <span className="gold-chart-legend-item gold-chart-legend-gap">
            <span className="gold-chart-legend-swatch gold-chart-legend-swatch-gap" aria-hidden="true" />
            قطع داده
          </span>
        ) : null}
      </div>

      <div
        className="median-chart-body"
        ref={bodyRef}
        onMouseMove={(e) => handlePointer(e.clientX)}
        onMouseLeave={clearHover}
        onTouchStart={(e) => handlePointer(e.touches[0]?.clientX ?? 0)}
        onTouchMove={(e) => handlePointer(e.touches[0]?.clientX ?? 0)}
        onTouchEnd={clearHover}
      >
        <svg
          ref={svgRef}
          className="median-chart-svg"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={formatters.ariaLabel}
        >
          <defs>
            <linearGradient id={`goldFill-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.blue} stopOpacity="0.42" />
              <stop offset="55%" stopColor={colors.blue2} stopOpacity="0.16" />
              <stop offset="100%" stopColor={colors.blue} stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`goldGlass-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.card} stopOpacity="0.55" />
              <stop offset="100%" stopColor={colors.card} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`goldLineNavasan-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={colors.blue} />
              <stop offset="100%" stopColor={colors.blue2} />
            </linearGradient>
            <pattern
              id={`goldGapHatch-${uid}`}
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(35)"
            >
              <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" strokeWidth="1.5" opacity="0.12" />
            </pattern>
            <filter id={`goldGlow-${uid}`} x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="2.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <clipPath id={`goldPlot-${uid}`}>
              <rect x={CHART_PAD_X} y={CHART_PAD_TOP} width={geom.plotW} height={geom.plotH} rx="10" />
            </clipPath>
          </defs>

          <rect
            className="median-chart-plot-bg"
            x={CHART_PAD_X}
            y={CHART_PAD_TOP}
            width={geom.plotW}
            height={geom.plotH}
            rx="10"
          />

          {geom.yTicks.map((value, i) => {
            const yy = yFromValue(value, geom.min, geom.max, geom.plotH);
            const edge = i === 0 || i === geom.yTicks.length - 1;
            return (
              <g key={`y-${i}`} className="median-grid">
                <line
                  x1={CHART_PAD_X}
                  y1={yy}
                  x2={CHART_W - CHART_PAD_RIGHT}
                  y2={yy}
                  className="median-grid-line"
                  strokeDasharray={edge ? "none" : "4 6"}
                />
                <text x={CHART_PAD_X - 10} y={yy + 4} textAnchor="end" className="median-axis">
                  {formatAxisValue(value)}
                </text>
              </g>
            );
          })}

          <line
            x1={CHART_PAD_X}
            y1={CHART_PAD_TOP}
            x2={CHART_PAD_X}
            y2={geom.baseY}
            className="median-axis-y-line"
          />

          {geom.xTicks.map((ms, i) => {
            const span = Math.max(geom.tMax - geom.tMin, 1);
            const ratio = (ms - geom.tMin) / span;
            const x = CHART_PAD_X + geom.plotW * 0.02 + geom.plotW * 0.96 * ratio;
            const anchor = i === 0 ? "start" : i === geom.xTicks.length - 1 ? "end" : "middle";
            return (
              <text
                key={`x-${i}`}
                x={x}
                y={CHART_H - 10}
                textAnchor={anchor}
                className="median-axis median-axis-x"
              >
                {axisLabel(ms, range)}
              </text>
            );
          })}

          <g clipPath={`url(#goldPlot-${uid})`}>
            {geom.bands.map((band, i) => (
              <rect
                key={`gap-${i}`}
                x={band.x}
                y={CHART_PAD_TOP}
                width={band.width}
                height={geom.plotH}
                className="chart-outage-band"
                fill={`url(#goldGapHatch-${uid})`}
              />
            ))}

            {navasanEntry?.areaPaths.map((areaPath, index) => (
              <path
                key={`navasan-area-${index}`}
                d={areaPath}
                fill={`url(#goldFill-${uid})`}
                className="median-chart-area"
              />
            ))}
            <rect
              x={CHART_PAD_X}
              y={CHART_PAD_TOP}
              width={geom.plotW}
              height={geom.plotH}
              fill={`url(#goldGlass-${uid})`}
              pointerEvents="none"
            />
            {geom.plotted.map((entry) =>
              entry.linePaths.map((linePath, index) => (
                <path
                  key={`${entry.source}-line-${index}`}
                  d={linePath}
                  fill="none"
                  stroke={
                    entry.source === "navasan"
                      ? `url(#goldLineNavasan-${uid})`
                      : sourceStroke(colors, entry.source)
                  }
                  strokeWidth={entry.source === "navasan" ? "3" : "2.4"}
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  className="median-chart-line"
                  filter={entry.source === "navasan" ? `url(#goldGlow-${uid})` : undefined}
                />
              ))
            )}
            {geom.plotted.map((entry) =>
              entry.isSinglePoint
                ? entry.plotPoints.map((point) => (
                    <circle
                      key={`${entry.source}-single`}
                      cx={point.x}
                      cy={point.y}
                      r="5.5"
                      fill={sourceStroke(colors, entry.source)}
                      stroke="var(--bg)"
                      strokeWidth="2"
                    />
                  ))
                : null
            )}
            {/* End markers for each series */}
            {geom.plotted.map((entry) =>
              !entry.isSinglePoint ? (
                <circle
                  key={`${entry.source}-end`}
                  cx={entry.last.x}
                  cy={entry.last.y}
                  r={entry.source === "navasan" ? 4.5 : 3.5}
                  fill={sourceStroke(colors, entry.source)}
                  stroke="var(--bg)"
                  strokeWidth="1.5"
                  opacity={0.95}
                />
              ) : null
            )}
            {isHovering ? (
              <line
                x1={crosshairX}
                y1={CHART_PAD_TOP}
                x2={crosshairX}
                y2={geom.baseY}
                className="median-hover-line"
              />
            ) : null}
          </g>

          {!isHovering ? (
            <g className="median-last-marker">
              <line
                x1={CHART_PAD_X}
                y1={geom.primary.last.y}
                x2={geom.primary.last.x}
                y2={geom.primary.last.y}
                className="median-last-guide"
              />
              <circle cx={geom.primary.last.x} cy={geom.primary.last.y} r="11" className="median-last-pulse" />
              <circle cx={geom.primary.last.x} cy={geom.primary.last.y} r="6.5" className="median-last-ring" />
              <circle
                cx={geom.primary.last.x}
                cy={geom.primary.last.y}
                r="4"
                className={`median-last-dot ${up ? "up" : "down"}`}
              />
            </g>
          ) : (
            <g className="median-hover-marker">
              {hoverRows.map((row) =>
                row.point ? (
                  <circle key={row.source} cx={row.point.x} cy={row.point.y} r="6" className="median-hover-dot" />
                ) : null
              )}
              {hoverRows.map((row) =>
                row.point ? (
                  <circle
                    key={`${row.source}-inner`}
                    cx={row.point.x}
                    cy={row.point.y}
                    r="2.75"
                    fill="var(--bg)"
                  />
                ) : null
              )}
            </g>
          )}
        </svg>

        {!isHovering ? (
          <div
            className={`median-chart-live-badge ${up ? "up" : "down"}`}
            style={{ left: `${badgeLeft}%`, top: `${lastOverlayPos.top}%` }}
          >
            <span className="median-chart-live-badge-label">آخرین قیمت</span>
            <span className="median-chart-live-badge-value number">
              {formatters.formatValue(geom.lastV)}
            </span>
            <span className="gold-chart-live-badge-source">{geom.primary.sourceName}</span>
          </div>
        ) : null}

        <div
          className={`median-chart-tooltip ${isHovering ? "visible" : ""} gold-chart-tooltip-multi`}
          style={{ left: `${overlayPos.left}%`, top: `${overlayPos.top}%` }}
        >
          <div className="gold-chart-tooltip-sources">
            {hoverRows.map((row) => (
              <div className="gold-chart-tooltip-row" key={row.source}>
                <span className="gold-chart-tooltip-source" style={{ color: row.color }}>
                  {row.sourceName}
                </span>
                <span className="gold-chart-tooltip-value number">
                  {row.point ? formatters.formatValue(row.point.v) : "—"}
                </span>
                <span className="median-chart-tooltip-time">
                  {row.point ? tooltipLabel(row.point.t, range) : "بدون نمونه"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
