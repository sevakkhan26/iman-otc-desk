"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { formatPercent } from "@/components/format";
import { SkeletonBlock } from "@/components/skeletons";
import {
  CHART_H as H,
  CHART_PAD_RIGHT as PAD_RIGHT,
  CHART_PAD_TOP as PAD_TOP,
  CHART_PAD_X as PAD_X,
  CHART_W as W,
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
  xFromTime,
  yFromValue,
  yGridValues
} from "@/components/chartMath";

const faNum = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
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

const LIGHT_COLORS = {
  blue: "#1774d1",
  blue2: "#0fb5d6",
  green: "#0c9c56",
  red: "#dc2f3a",
  card: "rgba(255, 255, 255, 0.72)"
};

const DARK_COLORS = {
  blue: "#4aa9f0",
  blue2: "#35d0e0",
  green: "#22d07a",
  red: "#ff6b74",
  card: "rgba(18, 36, 56, 0.82)"
};

type ChartColors = typeof LIGHT_COLORS;

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

export type TrendLineChartRange = "24h" | "7d";
export type TrendLineChartPoint = { t: string; v: number };
export type TrendLineChartData = {
  range: TrendLineChartRange;
  points: TrendLineChartPoint[];
  changePercent: number | null;
};
export type TrendLineChartFormatters = {
  formatValue: (value: number | null | undefined) => string;
  formatAxisValue?: (value: number) => string;
  formatAverage?: (value: number) => string;
  ariaLabel: string;
  emptyMessage?: string;
};

function axisLabelMs(ms: number, range: TrendLineChartRange) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDay.format(date) : faTime.format(date);
}

function tooltipLabel(iso: string, range: TrendLineChartRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDateTime.format(date) : faTime.format(date);
}

export function TrendLineChartPanel({
  data,
  formatters,
  pathMode = "smooth",
  breakGaps = true
}: {
  data: TrendLineChartData;
  formatters: TrendLineChartFormatters;
  pathMode?: "linear" | "smooth";
  breakGaps?: boolean;
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

  const { points, range } = data;

  const geom = useMemo(() => {
    const timed = collapseFlatRuns(parseTimedPoints(points));
    if (timed.length < 2) return null;

    const times = timed.map((p) => p.time);
    const values = timed.map((p) => p.v);
    const { tMin, tMax } = resolveTimeDomain(times, range);
    const { min, max } = resolveValueDomain(values);
    const plotW = plotWidth();
    const plotH = plotHeight(H);
    const baseY = PAD_TOP + plotH;
    const plotPoints = toPlotPoints(timed, tMin, tMax, min, max, plotW, plotH);

    const mode = pathMode === "linear" ? "linear" : "smooth";
    const finalLinePaths = breakGaps
      ? linePathsFor(plotPoints, range, mode)
      : connectAll(plotPoints, mode);
    const finalAreaPaths = breakGaps
      ? areaPathsFor(plotPoints, baseY, range, mode)
      : connectAllArea(plotPoints, baseY, mode);

    const last = plotPoints[plotPoints.length - 1]!;
    const avg = values.reduce((s, v) => s + v, 0) / values.length;
    const change =
      data.changePercent ??
      (values[0] !== 0 ? ((values[values.length - 1]! - values[0]!) / values[0]!) * 100 : null);

    return {
      min,
      max,
      tMin,
      tMax,
      plotW,
      plotH,
      baseY,
      plotPoints,
      linePaths: finalLinePaths,
      areaPaths: finalAreaPaths,
      lastX: last.x,
      lastY: last.y,
      lastV: last.v,
      lastT: last.t,
      lastTime: last.time,
      minV: Math.min(...values),
      maxV: Math.max(...values),
      avg,
      change,
      bands: outageBands(times, range, tMin, tMax, plotW, plotH),
      xTicks: timeAxisTicks(tMin, tMax, range === "7d" ? 6 : 5),
      yTicks: yGridValues(min, max, 5)
    };
  }, [points, data.changePercent, pathMode, breakGaps, range]);

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
  const activeTime = hoverTime ?? geom.lastTime;
  const hoverWindow = Math.max(outageThresholdMs(range), 30 * 60_000);
  const active =
    nearestTimedPoint(geom.plotPoints, activeTime, isHovering ? hoverWindow : undefined) ??
    geom.plotPoints[geom.plotPoints.length - 1]!;
  const crosshairX = xFromTime(activeTime, geom.tMin, geom.tMax, geom.plotW);

  const overlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, crosshairX, active.y)
      : { left: (crosshairX / W) * 100, top: (active.y / H) * 100 };
  const lastOverlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, geom.lastX, geom.lastY)
      : { left: (geom.lastX / W) * 100, top: (geom.lastY / H) * 100 };
  const badgeLeft = Math.min(Math.max(lastOverlayPos.left, 8), 72);

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
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={formatters.ariaLabel}
        >
          <defs>
            <linearGradient id={`medianFill-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.blue} stopOpacity="0.42" />
              <stop offset="55%" stopColor={colors.blue2} stopOpacity="0.16" />
              <stop offset="100%" stopColor={colors.blue} stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`medianGlass-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.card} stopOpacity="0.55" />
              <stop offset="100%" stopColor={colors.card} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`medianLine-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={colors.blue} />
              <stop offset="100%" stopColor={colors.blue2} />
            </linearGradient>
            <pattern
              id={`medianGapHatch-${uid}`}
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(35)"
            >
              <line x1="0" y1="0" x2="0" y2="8" stroke="currentColor" strokeWidth="1.5" opacity="0.12" />
            </pattern>
            <filter id={`medianGlow-${uid}`} x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="2.8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <clipPath id={`medianPlot-${uid}`}>
              <rect x={PAD_X} y={PAD_TOP} width={geom.plotW} height={geom.plotH} rx="10" />
            </clipPath>
          </defs>

          <rect
            className="median-chart-plot-bg"
            x={PAD_X}
            y={PAD_TOP}
            width={geom.plotW}
            height={geom.plotH}
            rx="10"
          />

          {geom.yTicks.map((v, i) => {
            const yy = yFromValue(v, geom.min, geom.max, geom.plotH);
            const edge = i === 0 || i === geom.yTicks.length - 1;
            return (
              <g key={i} className="median-grid">
                <line
                  x1={PAD_X}
                  y1={yy}
                  x2={W - PAD_RIGHT}
                  y2={yy}
                  className="median-grid-line"
                  strokeDasharray={edge ? "none" : "4 6"}
                />
                <text x={PAD_X - 10} y={yy + 4} textAnchor="end" className="median-axis">
                  {formatAxisValue(v)}
                </text>
              </g>
            );
          })}

          <line x1={PAD_X} y1={PAD_TOP} x2={PAD_X} y2={geom.baseY} className="median-axis-y-line" />

          {geom.xTicks.map((ms, i) => {
            const x = xFromTime(ms, geom.tMin, geom.tMax, geom.plotW);
            const anchor = i === 0 ? "start" : i === geom.xTicks.length - 1 ? "end" : "middle";
            return (
              <text key={i} x={x} y={H - 10} textAnchor={anchor} className="median-axis median-axis-x">
                {axisLabelMs(ms, range)}
              </text>
            );
          })}

          <g clipPath={`url(#medianPlot-${uid})`}>
            {geom.bands.map((band, i) => (
              <rect
                key={i}
                x={band.x}
                y={PAD_TOP}
                width={band.width}
                height={geom.plotH}
                className="chart-outage-band"
                fill={`url(#medianGapHatch-${uid})`}
              />
            ))}
            {geom.areaPaths.map((path, index) => (
              <path key={`area-${index}`} d={path} fill={`url(#medianFill-${uid})`} className="median-chart-area" />
            ))}
            <rect
              x={PAD_X}
              y={PAD_TOP}
              width={geom.plotW}
              height={geom.plotH}
              fill={`url(#medianGlass-${uid})`}
              pointerEvents="none"
            />
            {geom.linePaths.map((path, index) => (
              <path
                key={`line-${index}`}
                d={path}
                fill="none"
                stroke={`url(#medianLine-${uid})`}
                strokeWidth="3"
                strokeLinejoin="round"
                strokeLinecap="round"
                className="median-chart-line"
                filter={`url(#medianGlow-${uid})`}
              />
            ))}
            {isHovering ? (
              <line
                x1={crosshairX}
                y1={PAD_TOP}
                x2={crosshairX}
                y2={geom.baseY}
                className="median-hover-line"
              />
            ) : null}
          </g>

          {!isHovering ? (
            <g className="median-last-marker">
              <line x1={PAD_X} y1={geom.lastY} x2={geom.lastX} y2={geom.lastY} className="median-last-guide" />
              <circle cx={geom.lastX} cy={geom.lastY} r="11" className="median-last-pulse" />
              <circle cx={geom.lastX} cy={geom.lastY} r="6.5" className="median-last-ring" />
              <circle cx={geom.lastX} cy={geom.lastY} r="4" className={`median-last-dot ${up ? "up" : "down"}`} />
            </g>
          ) : (
            <g className="median-hover-marker">
              <circle cx={active.x} cy={active.y} r="6" className="median-hover-dot" />
              <circle cx={active.x} cy={active.y} r="2.75" fill="var(--bg)" />
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
          </div>
        ) : null}

        <div
          className={`median-chart-tooltip ${isHovering ? "visible" : ""}`}
          style={{ left: `${overlayPos.left}%`, top: `${overlayPos.top}%` }}
        >
          <span className="median-chart-tooltip-time">{tooltipLabel(active.t, range)}</span>
          <span className="median-chart-tooltip-value number">{formatters.formatValue(active.v)}</span>
        </div>
      </div>
    </div>
  );
}

function connectAll(
  plotPoints: Array<{ x: number; y: number }>,
  mode: "linear" | "smooth"
): string[] {
  if (plotPoints.length < 2) return [];
  // Always linear for continuous mode — avoids inventing prices across real outages
  void mode;
  let d = `M ${plotPoints[0]!.x} ${plotPoints[0]!.y}`;
  for (let i = 1; i < plotPoints.length; i++) d += ` L ${plotPoints[i]!.x} ${plotPoints[i]!.y}`;
  return [d];
}

function connectAllArea(
  plotPoints: Array<{ x: number; y: number }>,
  baseY: number,
  mode: "linear" | "smooth"
): string[] {
  const lines = connectAll(plotPoints, mode);
  if (!lines[0] || plotPoints.length < 2) return [];
  const first = plotPoints[0]!;
  const last = plotPoints[plotPoints.length - 1]!;
  return [`${lines[0]} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`];
}

export type MedianChartRangeOption<T extends string> = { key: T; label: string };

export function MedianChartShell<T extends string>({
  className,
  lastValue,
  changePercent,
  showChange,
  range,
  rangeOptions,
  onRangeChange,
  rangeAriaLabel,
  toolbar,
  loading,
  hasData,
  error,
  children
}: {
  className?: string;
  lastValue: ReactNode;
  changePercent: number | null | undefined;
  showChange: boolean;
  range: T;
  rangeOptions: MedianChartRangeOption<T>[];
  onRangeChange: (range: T) => void;
  rangeAriaLabel: string;
  toolbar?: ReactNode;
  loading: boolean;
  hasData: boolean;
  error: string | null;
  children: ReactNode;
}) {
  const up = (changePercent ?? 0) >= 0;

  return (
    <div className={className ? `median-chart ${className}` : "median-chart"}>
      <div className="median-chart-head">
        <div className="median-chart-stats">
          <span className="median-chart-value number">{lastValue}</span>
          {showChange && changePercent !== null && changePercent !== undefined ? (
            <span className={`median-chart-change ${up ? "good" : "danger"}`}>
              {up ? <TrendingUp aria-hidden="true" size={15} /> : <TrendingDown aria-hidden="true" size={15} />}
              {formatPercent(changePercent)}
            </span>
          ) : null}
        </div>
        <div className="segment" role="tablist" aria-label={rangeAriaLabel}>
          {rangeOptions.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={range === option.key}
              className={`segment-item ${range === option.key ? "active" : ""}`}
              onClick={() => onRangeChange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {toolbar}
      {loading && !hasData ? (
        <div className="median-chart-body" aria-busy="true" aria-live="polite">
          <span className="sr-only">در حال دریافت داده نمودار</span>
          <SkeletonBlock className="sk-chart-area" height={220} />
        </div>
      ) : error ? (
        <div className="empty">داده‌ای دریافت نشد: {error}</div>
      ) : hasData ? (
        children
      ) : null}
    </div>
  );
}
