"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { GoldHistoryRange, GoldPricesApiSource } from "@/lib/types";
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

const W = 720;
const H = 280;
const PAD_X = 62;
const PAD_TOP = 28;
const PAD_BOTTOM = 36;
const PAD_RIGHT = 20;

type PlotPoint = { x: number; y: number; v: number; t: string; time: number };

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

function axisLabel(iso: string, range: GoldHistoryRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDay.format(date) : faTime.format(date);
}

function tooltipLabel(iso: string, range: GoldHistoryRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDateTime.format(date) : faTime.format(date);
}

const X_EDGE_PAD = 0.03;

type XScale = (index: number) => number;

function makeXScale(pointCount: number, plotW: number): XScale {
  return (index: number) => {
    if (pointCount <= 1) return PAD_X + plotW / 2;
    const innerStart = PAD_X + plotW * X_EDGE_PAD;
    const innerW = plotW * (1 - 2 * X_EDGE_PAD);
    return innerStart + (index / (pointCount - 1)) * innerW;
  };
}

function buildUnifiedTimeline(parsed: Array<{ plotPoints: Array<{ t: string; time: number }> }>): number[] {
  const unique = new Set<number>();
  for (const entry of parsed) {
    for (const point of entry.plotPoints) unique.add(point.time);
  }
  return [...unique].sort((a, b) => a - b);
}

function linearLinePath(plotPoints: PlotPoint[]): string {
  if (plotPoints.length < 2) return "";
  let d = `M ${plotPoints[0].x} ${plotPoints[0].y}`;
  for (let i = 1; i < plotPoints.length; i++) {
    d += ` L ${plotPoints[i].x} ${plotPoints[i].y}`;
  }
  return d;
}

function linearAreaPath(plotPoints: PlotPoint[], baseY: number): string {
  const line = linearLinePath(plotPoints);
  if (!line) return "";
  const first = plotPoints[0];
  const last = plotPoints[plotPoints.length - 1];
  return `${line} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`;
}

function outageThresholdMs(range: GoldHistoryRange): number {
  return range === "7d" ? 24 * 60 * 60_000 : 5 * 60 * 60_000;
}

function splitByOutages(plotPoints: PlotPoint[], range: GoldHistoryRange): PlotPoint[][] {
  if (plotPoints.length < 2) return plotPoints.length ? [plotPoints] : [];
  const threshold = outageThresholdMs(range);
  const segments: PlotPoint[][] = [[plotPoints[0]]];
  for (let i = 1; i < plotPoints.length; i++) {
    const prev = plotPoints[i - 1];
    const curr = plotPoints[i];
    if (curr.time - prev.time > threshold) {
      segments.push([curr]);
    } else {
      segments[segments.length - 1].push(curr);
    }
  }
  return segments.filter((segment) => segment.length >= 2);
}

function buildSourceLinePaths(plotPoints: PlotPoint[], range: GoldHistoryRange): string[] {
  if (plotPoints.length < 2) return [];
  return splitByOutages(plotPoints, range).map(linearLinePath).filter(Boolean);
}

function buildSourceAreaPaths(plotPoints: PlotPoint[], baseY: number, range: GoldHistoryRange): string[] {
  if (plotPoints.length < 2) return [];
  return splitByOutages(plotPoints, range)
    .map((segment) => linearAreaPath(segment, baseY))
    .filter(Boolean);
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

function nearestPoint(points: PlotPoint[], targetTime: number, maxDeltaMs?: number): PlotPoint | null {
  if (!points.length) return null;
  let best = points[0];
  let bestDelta = Math.abs(best.time - targetTime);
  for (let i = 1; i < points.length; i++) {
    const delta = Math.abs(points[i].time - targetTime);
    if (delta < bestDelta) {
      best = points[i];
      bestDelta = delta;
    }
  }
  if (maxDeltaMs !== undefined && bestDelta > maxDeltaMs) return null;
  return best;
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
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const formatAxisValue = formatters.formatAxisValue ?? ((value: number) => faNum.format(Math.round(value)));
  const formatAverage = formatters.formatAverage ?? ((value: number) => formatters.formatValue(Math.round(value)));

  const { range, series } = data;
  const orderedSeries = useMemo(
    () => [...series].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]),
    [series]
  );

  const geom = useMemo(() => {
    if (!orderedSeries.length) return null;

    const parsed = orderedSeries
      .map((entry) => ({
        ...entry,
        plotPoints: entry.points
          .map((point) => {
            const time = new Date(point.t).getTime();
            if (Number.isNaN(time) || !Number.isFinite(point.v) || point.v <= 0) return null;
            return { ...point, time };
          })
          .filter((point): point is { t: string; v: number; time: number } => point !== null)
          .sort((a, b) => a.time - b.time)
      }))
      .filter((entry) => entry.plotPoints.length >= 1);

    if (!parsed.length) return null;

    const allValues = parsed.flatMap((entry) => entry.plotPoints.map((point) => point.v));
    let min = Math.min(...allValues);
    let max = Math.max(...allValues);
    if (min === max) {
      const pad = Math.max(Math.abs(min) * 0.001, 1);
      min -= pad;
      max += pad;
    }

    const unifiedTimes = buildUnifiedTimeline(parsed);
    const timeToIndex = new Map(unifiedTimes.map((time, index) => [time, index]));
    const timelineCount = unifiedTimes.length;
    const plotW = W - PAD_X - PAD_RIGHT;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const baseY = PAD_TOP + plotH;
    const xScale = makeXScale(timelineCount, plotW);
    const y = (value: number) => PAD_TOP + (1 - (value - min) / (max - min)) * plotH;

    const plotted = parsed.map((entry) => {
      const plotPoints: PlotPoint[] = entry.plotPoints.map((point) => ({
        x: xScale(timeToIndex.get(point.time) ?? 0),
        y: y(point.v),
        v: point.v,
        t: point.t,
        time: point.time
      }));
      return {
        ...entry,
        plotPoints,
        linePaths: buildSourceLinePaths(plotPoints, range),
        areaPaths: buildSourceAreaPaths(plotPoints, baseY, range),
        isSinglePoint: plotPoints.length === 1,
        last: plotPoints[plotPoints.length - 1]
      };
    });

    const primary = plotted.find((entry) => entry.source === "navasan") ?? plotted[0];
    const avg = allValues.reduce((sum, value) => sum + value, 0) / allValues.length;
    const firstPrimary = primary.plotPoints[0]?.v;
    const change =
      data.changePercent ??
      (firstPrimary !== undefined && firstPrimary !== 0
        ? ((primary.last.v - firstPrimary) / firstPrimary) * 100
        : null);

    const firstTime = unifiedTimes[0] ?? Date.now();
    const lastTime = unifiedTimes[unifiedTimes.length - 1] ?? firstTime;

    return {
      min,
      max,
      plotW,
      plotH,
      baseY,
      unifiedTimes,
      timelineCount,
      xScale,
      plotted,
      primary,
      minV: Math.min(...allValues),
      maxV: Math.max(...allValues),
      lastV: primary.last.v,
      avg,
      change,
      startLabel: new Date(firstTime).toISOString(),
      endLabel: new Date(lastTime).toISOString()
    };
  }, [orderedSeries, data.changePercent, range]);

  const handlePointer = useCallback(
    (clientX: number) => {
      if (!geom || !svgRef.current) return;
      setHoverIndex(indexFromClientX(clientX, svgRef.current, geom.plotW, geom.timelineCount));
    },
    [geom]
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
  const isHovering = hoverIndex !== null;
  const activeIndex = hoverIndex ?? Math.max(0, geom.timelineCount - 1);
  const activeTime = geom.unifiedTimes[activeIndex] ?? geom.unifiedTimes[geom.unifiedTimes.length - 1] ?? Date.now();
  const crosshairX = geom.xScale(activeIndex);
  const dataSpanMs = Math.max(
    (geom.unifiedTimes[geom.unifiedTimes.length - 1] ?? activeTime) - (geom.unifiedTimes[0] ?? activeTime),
    1
  );
  const hoverWindowMs = Math.max(dataSpanMs * 0.06, 5 * 60_000);

  const hoverRows = geom.plotted
    .map((entry) => ({
      source: entry.source,
      sourceName: entry.sourceName,
      point: nearestPoint(entry.plotPoints, activeTime, hoverWindowMs),
      color: sourceStroke(colors, entry.source)
    }))
    .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);

  const activeY =
    hoverRows.find((row) => row.source === geom.primary.source)?.point?.y ?? geom.primary.last.y;

  const overlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, crosshairX, activeY)
      : { left: (crosshairX / W) * 100, top: (activeY / H) * 100 };

  const lastOverlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, geom.primary.last.x, geom.primary.last.y)
      : { left: (geom.primary.last.x / W) * 100, top: (geom.primary.last.y / H) * 100 };

  const badgeLeft = Math.min(Math.max(lastOverlayPos.left, 8), 72);
  const gridFracs = [0, 0.25, 0.5, 0.75, 1];
  const navasanEntry = geom.plotted.find((entry) => entry.source === "navasan");

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
            <linearGradient id={`goldFill-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.blue} stopOpacity="0.52" />
              <stop offset="55%" stopColor={colors.blue2} stopOpacity="0.22" />
              <stop offset="100%" stopColor={colors.blue} stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id={`goldGlass-${uid}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors.card} stopOpacity="0.75" />
              <stop offset="100%" stopColor={colors.card} stopOpacity="0" />
            </linearGradient>
            <linearGradient id={`goldLineNavasan-${uid}`} x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor={colors.blue} />
              <stop offset="100%" stopColor={colors.blue2} />
            </linearGradient>
            <filter id={`goldGlow-${uid}`} x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="3.5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
            <clipPath id={`goldPlot-${uid}`}>
              <rect x={PAD_X} y={PAD_TOP} width={geom.plotW} height={geom.plotH} rx="8" />
            </clipPath>
          </defs>

          <rect className="median-chart-plot-bg" x={PAD_X} y={PAD_TOP} width={geom.plotW} height={geom.plotH} rx="8" />

          {gridFracs.map((frac) => {
            const value = geom.max - frac * (geom.max - geom.min);
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
                  {formatAxisValue(value)}
                </text>
              </g>
            );
          })}

          <line x1={PAD_X} y1={PAD_TOP} x2={PAD_X} y2={geom.baseY} className="median-axis-y-line" />
          <text x={PAD_X} y={H - 10} textAnchor="start" className="median-axis median-axis-x">
            {axisLabel(geom.startLabel, range)}
          </text>
          <text x={W - PAD_RIGHT} y={H - 10} textAnchor="end" className="median-axis median-axis-x">
            {axisLabel(geom.endLabel, range)}
          </text>

          <g clipPath={`url(#goldPlot-${uid})`}>
            {navasanEntry?.areaPaths.map((areaPath, index) => (
              <path
                key={`navasan-area-${index}`}
                d={areaPath}
                fill={`url(#goldFill-${uid})`}
                className="median-chart-area"
              />
            ))}
            <rect
              x={PAD_X}
              y={PAD_TOP}
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
                    entry.source === "navasan" ? `url(#goldLineNavasan-${uid})` : sourceStroke(colors, entry.source)
                  }
                  strokeWidth={entry.source === "navasan" ? "3.25" : "2.75"}
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
                      r="6"
                      fill={sourceStroke(colors, entry.source)}
                      stroke="var(--bg)"
                      strokeWidth="2"
                    />
                  ))
                : null
            )}
            {isHovering ? (
              <line x1={crosshairX} y1={PAD_TOP} x2={crosshairX} y2={geom.baseY} className="median-hover-line" />
            ) : null}
          </g>

          {!isHovering ? (
            <g className="median-last-marker">
              <line
                x1={PAD_X}
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
                  <circle key={`${row.source}-inner`} cx={row.point.x} cy={row.point.y} r="2.75" fill="var(--bg)" />
                ) : null
              )}
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
            <span className="gold-chart-live-badge-source">{geom.primary.sourceName}</span>
          </div>
        ) : null}

        <div
          className={`median-chart-tooltip ${isHovering ? "visible" : ""} gold-chart-tooltip-multi`}
          style={{
            left: `${overlayPos.left}%`,
            top: `${overlayPos.top}%`
          }}
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
                  {row.point ? tooltipLabel(row.point.t, range) : "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}