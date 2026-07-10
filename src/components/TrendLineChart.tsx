"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { formatPercent } from "@/components/format";

const faNum = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
const faTime = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tehran" });
const faDay = new Intl.DateTimeFormat("fa-IR", { month: "2-digit", day: "2-digit", timeZone: "Asia/Tehran" });
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

const W = 720;
const H = 280;
const PAD_X = 62;
const PAD_TOP = 28;
const PAD_BOTTOM = 36;
const PAD_RIGHT = 20;

type PlotPoint = { x: number; y: number; v: number; t: string };

function axisLabel(iso: string, range: TrendLineChartRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDay.format(date) : faTime.format(date);
}

function tooltipLabel(iso: string, range: TrendLineChartRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDateTime.format(date) : faTime.format(date);
}

function smoothLinePath(plotPoints: PlotPoint[]): string {
  if (plotPoints.length < 2) return "";
  if (plotPoints.length === 2) {
    return `M ${plotPoints[0].x} ${plotPoints[0].y} L ${plotPoints[1].x} ${plotPoints[1].y}`;
  }

  const tension = 0.24;
  let d = `M ${plotPoints[0].x} ${plotPoints[0].y}`;

  for (let i = 0; i < plotPoints.length - 1; i++) {
    const p0 = plotPoints[Math.max(0, i - 1)];
    const p1 = plotPoints[i];
    const p2 = plotPoints[i + 1];
    const p3 = plotPoints[Math.min(plotPoints.length - 1, i + 2)];

    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;

    d += ` C ${cp1x} ${cp1y} ${cp2x} ${cp2y} ${p2.x} ${p2.y}`;
  }

  return d;
}

function linearLinePath(plotPoints: PlotPoint[]): string {
  if (plotPoints.length < 2) return "";
  let d = `M ${plotPoints[0].x} ${plotPoints[0].y}`;
  for (let i = 1; i < plotPoints.length; i++) {
    d += ` L ${plotPoints[i].x} ${plotPoints[i].y}`;
  }
  return d;
}

function pointTimeMs(point: PlotPoint): number {
  const time = new Date(point.t).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function medianTimeDeltaMs(plotPoints: PlotPoint[]): number {
  if (plotPoints.length < 2) return Infinity;
  const deltas: number[] = [];
  for (let i = 1; i < plotPoints.length; i++) {
    const delta = pointTimeMs(plotPoints[i]) - pointTimeMs(plotPoints[i - 1]);
    if (delta > 0) deltas.push(delta);
  }
  if (!deltas.length) return Infinity;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)];
}

function splitPlotSegments(plotPoints: PlotPoint[], gapThresholdMs: number): PlotPoint[][] {
  if (plotPoints.length < 2) return plotPoints.length ? [plotPoints] : [];
  const segments: PlotPoint[][] = [[plotPoints[0]]];
  for (let i = 1; i < plotPoints.length; i++) {
    const prev = plotPoints[i - 1];
    const curr = plotPoints[i];
    const gap = pointTimeMs(curr) - pointTimeMs(prev);
    if (gap > gapThresholdMs) {
      if (segments[segments.length - 1].length >= 1) {
        segments.push([curr]);
      } else {
        segments[segments.length - 1].push(curr);
      }
      continue;
    }
    segments[segments.length - 1].push(curr);
  }
  return segments.filter((segment) => segment.length >= 2);
}

function buildLinePaths(
  plotPoints: PlotPoint[],
  pathMode: "linear" | "smooth",
  breakGaps: boolean
): string[] {
  if (plotPoints.length < 2) return [];
  const lineFn = pathMode === "linear" ? linearLinePath : smoothLinePath;
  if (!breakGaps) {
    const path = lineFn(plotPoints);
    return path ? [path] : [];
  }
  const gapThreshold = medianTimeDeltaMs(plotPoints) * 4;
  return splitPlotSegments(plotPoints, gapThreshold).map(lineFn).filter(Boolean);
}

function buildAreaPaths(plotPoints: PlotPoint[], baseY: number, pathMode: "linear" | "smooth", breakGaps: boolean): string[] {
  if (plotPoints.length < 2) return [];
  const lineFn = pathMode === "linear" ? linearLinePath : smoothLinePath;
  if (!breakGaps) {
    const line = lineFn(plotPoints);
    if (!line) return [];
    const first = plotPoints[0];
    const last = plotPoints[plotPoints.length - 1];
    return [`${line} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`];
  }
  const gapThreshold = medianTimeDeltaMs(plotPoints) * 4;
  return splitPlotSegments(plotPoints, gapThreshold)
    .map((segment) => {
      const line = lineFn(segment);
      if (!line) return "";
      const first = segment[0];
      const last = segment[segment.length - 1];
      return `${line} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`;
    })
    .filter(Boolean);
}

type XScale = (index: number) => number;

function makeXScale(pointCount: number, plotW: number): XScale {
  return (index: number) => PAD_X + (index / (pointCount - 1)) * plotW;
}

function svgToClient(svg: SVGSVGElement, viewX: number, viewY: number) {
  const pt = svg.createSVGPoint();
  pt.x = viewX;
  pt.y = viewY;
  const ctm = svg.getScreenCTM();
  if (!ctm) return { x: 0, y: 0 };
  const mapped = pt.matrixTransform(ctm);
  return { x: mapped.x, y: mapped.y };
}

function plotScreenBounds(svg: SVGSVGElement, plotW: number) {
  const left = svgToClient(svg, PAD_X, PAD_TOP).x;
  const right = svgToClient(svg, PAD_X + plotW, PAD_TOP).x;
  return { left: Math.min(left, right), width: Math.abs(right - left) };
}

function indexFromClientX(
  clientX: number,
  svg: SVGSVGElement,
  plotW: number,
  pointCount: number
): number {
  if (pointCount < 2) return 0;
  const { left: plotLeft, width: plotWidth } = plotScreenBounds(svg, plotW);
  if (plotWidth <= 0) return 0;
  const relativeX = clientX - plotLeft;
  const ratio = Math.min(1, Math.max(0, relativeX / plotWidth));
  return Math.min(pointCount - 1, Math.max(0, Math.round(ratio * (pointCount - 1))));
}

function overlayPercent(svg: SVGSVGElement, body: HTMLDivElement, viewX: number, viewY: number) {
  const bodyRect = body.getBoundingClientRect();
  const client = svgToClient(svg, viewX, viewY);
  if (bodyRect.width <= 0 || bodyRect.height <= 0) {
    return { left: (viewX / W) * 100, top: (viewY / H) * 100 };
  }
  return {
    left: ((client.x - bodyRect.left) / bodyRect.width) * 100,
    top: ((client.y - bodyRect.top) / bodyRect.height) * 100
  };
}

export function TrendLineChartPanel({
  data,
  formatters,
  pathMode = "smooth",
  breakGaps = false
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const formatAxisValue = formatters.formatAxisValue ?? ((value: number) => faNum.format(Math.round(value)));
  const formatAverage = formatters.formatAverage ?? ((value: number) => formatters.formatValue(Math.round(value)));

  const { points, range } = data;

  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((p) => p.v);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      const pad = Math.max(Math.abs(min) * 0.001, 1);
      min -= pad;
      max += pad;
    }
    const plotW = W - PAD_X - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const baseY = PAD_TOP + plotH;
    const xScale = makeXScale(points.length, plotW);
    const y = (v: number) => PAD_TOP + (1 - (v - min) / (max - min)) * plotH;
    const plotPoints: PlotPoint[] = points.map((p, i) => ({ x: xScale(i), y: y(p.v), v: p.v, t: p.t }));
    const linePaths = buildLinePaths(plotPoints, pathMode, breakGaps);
    const areaPaths = buildAreaPaths(plotPoints, baseY, pathMode, breakGaps);
    const linePath = linePaths[0] ?? "";
    const areaPath = areaPaths[0] ?? "";
    const last = plotPoints[plotPoints.length - 1];
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    const change =
      data.changePercent ??
      (values[0] !== 0 ? ((values[values.length - 1] - values[0]) / values[0]) * 100 : null);

    return {
      min,
      max,
      plotW,
      plotH,
      baseY,
      xScale,
      plotPoints,
      linePaths,
      areaPaths,
      linePath,
      areaPath,
      lastX: last.x,
      lastY: last.y,
      lastV: last.v,
      minV: Math.min(...values),
      maxV: Math.max(...values),
      avg,
      change
    };
  }, [points, data.changePercent, pathMode, breakGaps]);

  const handlePointer = useCallback(
    (clientX: number) => {
      if (!geom || !svgRef.current) return;
      setHoverIndex(indexFromClientX(clientX, svgRef.current, geom.plotW, points.length));
    },
    [geom, points.length]
  );

  const clearHover = useCallback(() => setHoverIndex(null), []);

  if (!geom) {
    return (
      <div className="empty">
        {formatters.emptyMessage ??
          "هنوز داده کافی برای نمودار ثبت نشده است؛ با باز ماندن داشبورد، روند قیمت به‌مرور تکمیل می‌شود."}
      </div>
    );
  }

  const up = (geom.change ?? 0) >= 0;
  const activeIndex = hoverIndex ?? points.length - 1;
  const active = geom.plotPoints[activeIndex];
  const isHovering = hoverIndex !== null;
  const gridFracs = [0, 0.25, 0.5, 0.75, 1];
  const overlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, geom.xScale(activeIndex), active.y)
      : { left: (active.x / W) * 100, top: (active.y / H) * 100 };
  const lastOverlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, geom.lastX, geom.lastY)
      : { left: (geom.lastX / W) * 100, top: (geom.lastY / H) * 100 };
  const badgeLeft = Math.min(Math.max(lastOverlayPos.left, 8), 72);

  return (
    <div className="median-chart-panel" data-chart-version="premium-v2">
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
              <stop offset="0%" stopColor={colors.blue} stopOpacity="0.52" />
              <stop offset="55%" stopColor={colors.blue2} stopOpacity="0.22" />
              <stop offset="100%" stopColor={colors.blue} stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`medianGlass-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.card} stopOpacity="0.75" />
              <stop offset="100%" stopColor={colors.card} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`medianLine-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={colors.blue} />
              <stop offset="100%" stopColor={colors.blue2} />
            </linearGradient>
            <filter id={`medianGlow-${uid}`} x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <clipPath id={`medianPlot-${uid}`}>
              <rect x={PAD_X} y={PAD_TOP} width={geom.plotW} height={geom.plotH} rx="8" />
            </clipPath>
          </defs>

          <rect className="median-chart-plot-bg" x={PAD_X} y={PAD_TOP} width={geom.plotW} height={geom.plotH} rx="8" />

          {gridFracs.map((frac) => {
            const v = geom.max - frac * (geom.max - geom.min);
            const yy = PAD_TOP + frac * geom.plotH;
            return (
              <g key={frac} className="median-grid">
                <line
                  x1={PAD_X}
                  y1={yy}
                  x2={W - PAD_RIGHT}
                  y2={yy}
                  className="median-grid-line"
                  strokeDasharray={frac === 0 || frac === 1 ? "none" : "5 7"}
                />
                <text x={PAD_X - 12} y={yy + 4} textAnchor="end" className="median-axis">
                  {formatAxisValue(v)}
                </text>
              </g>
            );
          })}

          <line x1={PAD_X} y1={PAD_TOP} x2={PAD_X} y2={geom.baseY} className="median-axis-y-line" />
          <text x={PAD_X} y={H - 10} textAnchor="start" className="median-axis median-axis-x">
            {axisLabel(points[0].t, range)}
          </text>
          <text x={W - PAD_RIGHT} y={H - 10} textAnchor="end" className="median-axis median-axis-x">
            {axisLabel(points[points.length - 1].t, range)}
          </text>

          <g clipPath={`url(#medianPlot-${uid})`}>
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
                strokeWidth="3.25"
                strokeLinejoin="round"
                strokeLinecap="round"
                className="median-chart-line"
                filter={`url(#medianGlow-${uid})`}
              />
            ))}
            {isHovering ? (
              <line
                x1={geom.xScale(activeIndex)}
                y1={PAD_TOP}
                x2={geom.xScale(activeIndex)}
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
              <circle cx={geom.xScale(activeIndex)} cy={active.y} r="6" className="median-hover-dot" />
              <circle cx={geom.xScale(activeIndex)} cy={active.y} r="2.75" fill="var(--bg)" />
            </g>
          )}
        </svg>

        {!isHovering ? (
          <div
            className={`median-chart-live-badge ${up ? "up" : "down"}`}
            style={{
              left: `${badgeLeft}%`,
              top: `${lastOverlayPos.top}%`
            }}
          >
            <span className="median-chart-live-badge-label">آخرین قیمت</span>
            <span className="median-chart-live-badge-value number">{formatters.formatValue(geom.lastV)}</span>
          </div>
        ) : null}

        <div
          className={`median-chart-tooltip ${isHovering ? "visible" : ""}`}
          style={{
            left: `${overlayPos.left}%`,
            top: `${overlayPos.top}%`
          }}
        >
          <span className="median-chart-tooltip-time">{tooltipLabel(active.t, range)}</span>
          <span className="median-chart-tooltip-value number">{formatters.formatValue(active.v)}</span>
        </div>
      </div>
    </div>
  );
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
        <div className="loading">در حال دریافت داده...</div>
      ) : error ? (
        <div className="empty">داده‌ای دریافت نشد: {error}</div>
      ) : hasData ? (
        children
      ) : null}
    </div>
  );
}