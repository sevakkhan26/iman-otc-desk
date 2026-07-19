"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { MedianHistoryRange, MedianHistoryResponse } from "@/lib/types";
import { formatPercent } from "@/components/format";
import { TomanAmount } from "@/components/TomanAmount";

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

function axisLabel(iso: string, range: MedianHistoryRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDay.format(date) : faTime.format(date);
}

function tooltipLabel(iso: string, range: MedianHistoryRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDateTime.format(date) : faTime.format(date);
}

const W = 720;
const H_DEFAULT = 280;
const H_TALL = 420;
const PAD_X = 62;
const PAD_TOP = 28;
const PAD_BOTTOM = 36;
const PAD_RIGHT = 20;

type PlotPoint = { x: number; y: number; v: number; t: string };

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

function smoothAreaPath(plotPoints: PlotPoint[], baseY: number): string {
  const line = smoothLinePath(plotPoints);
  if (!line) return "";
  const first = plotPoints[0];
  const last = plotPoints[plotPoints.length - 1];
  return `${line} L ${last.x} ${baseY} L ${first.x} ${baseY} Z`;
}

type XScale = (index: number) => number;

function makeXScale(pointCount: number, plotW: number): XScale {
  return (index: number) => PAD_X + (index / (pointCount - 1)) * plotW;
}

/** SVG viewBox coords -> client coords (same transform as rendered points). */
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

/** Same ratio mapping used for hover index selection. */
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

function overlayPercent(
  svg: SVGSVGElement,
  body: HTMLDivElement,
  viewX: number,
  viewY: number,
  viewH: number = H_DEFAULT
) {
  const bodyRect = body.getBoundingClientRect();
  const client = svgToClient(svg, viewX, viewY);
  if (bodyRect.width <= 0 || bodyRect.height <= 0) {
    return { left: (viewX / W) * 100, top: (viewY / viewH) * 100 };
  }
  return {
    left: ((client.x - bodyRect.left) / bodyRect.width) * 100,
    top: ((client.y - bodyRect.top) / bodyRect.height) * 100
  };
}

function Chart({ data, tall = false }: { data: MedianHistoryResponse; tall?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const colors = useChartColors();
  const bodyRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const H = tall ? H_TALL : H_DEFAULT;

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
    const linePath = smoothLinePath(plotPoints);
    const areaPath = smoothAreaPath(plotPoints, baseY);
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
  }, [points, data.changePercent, H]);

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
        هنوز داده کافی برای نمودار ثبت نشده است؛ با باز ماندن داشبورد، روند قیمت به‌مرور تکمیل می‌شود.
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
      ? overlayPercent(svgRef.current, bodyRef.current, geom.xScale(activeIndex), active.y, H)
      : { left: (active.x / W) * 100, top: (active.y / H) * 100 };
  const lastOverlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, geom.lastX, geom.lastY, H)
      : { left: (geom.lastX / W) * 100, top: (geom.lastY / H) * 100 };
  const badgeLeft = Math.min(Math.max(lastOverlayPos.left, 8), 72);

  return (
    <div className="median-chart-panel" data-chart-version="premium-v2">
      <div className="median-chart-mini-stats" aria-label="خلاصه بازه نمودار">
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">آخرین</span>
          <span className="median-mini-stat-value number">
            <TomanAmount value={geom.lastV} />
          </span>
        </div>
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">کمترین</span>
          <span className="median-mini-stat-value number">
            <TomanAmount value={geom.minV} />
          </span>
        </div>
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">بیشترین</span>
          <span className="median-mini-stat-value number">
            <TomanAmount value={geom.maxV} />
          </span>
        </div>
        <div className="median-mini-stat">
          <span className="median-mini-stat-label">میانگین</span>
          <span className="median-mini-stat-value number">
            <TomanAmount value={Math.round(geom.avg)} />
          </span>
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
          aria-label="نمودار روند قیمت میانه تتر"
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
                  {faNum.format(Math.round(v))}
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
            <path d={geom.areaPath} fill={`url(#medianFill-${uid})`} className="median-chart-area" />
            <rect
              x={PAD_X}
              y={PAD_TOP}
              width={geom.plotW}
              height={geom.plotH}
              fill={`url(#medianGlass-${uid})`}
              pointerEvents="none"
            />
            <path
              d={geom.linePath}
              fill="none"
              stroke={`url(#medianLine-${uid})`}
              strokeWidth="3.25"
              strokeLinejoin="round"
              strokeLinecap="round"
              className="median-chart-line"
              filter={`url(#medianGlow-${uid})`}
            />
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
            <span className="median-chart-live-badge-value number">
              <TomanAmount value={geom.lastV} />
            </span>
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
          <span className="median-chart-tooltip-value number">
            <TomanAmount value={active.v} />
          </span>
        </div>
      </div>
    </div>
  );
}

export function MedianChart({ tall = false }: { tall?: boolean } = {}) {
  const [range, setRange] = useState<MedianHistoryRange>("24h");
  const [data, setData] = useState<MedianHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/median-history?range=${range}`, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as MedianHistoryResponse;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "داده‌ای دریافت نشد");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [range]);

  const up = (data?.changePercent ?? 0) >= 0;
  const options: Array<{ key: MedianHistoryRange; label: string }> = [
    { key: "24h", label: "۲۴ ساعته" },
    { key: "7d", label: "۷ روزه" }
  ];

  return (
    <div className={tall ? "median-chart median-chart-tall" : "median-chart"}>
      <div className="median-chart-head">
        <div className="median-chart-stats">
          <span className="median-chart-value number">
            <TomanAmount value={data?.last} />
          </span>
          {data && data.changePercent !== null ? (
            <span className={`median-chart-change ${up ? "good" : "danger"}`}>
              {up ? <TrendingUp aria-hidden="true" size={15} /> : <TrendingDown aria-hidden="true" size={15} />}
              {formatPercent(data.changePercent)}
            </span>
          ) : null}
        </div>
        <div className="segment" role="tablist" aria-label="بازه زمانی نمودار">
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="tab"
              aria-selected={range === option.key}
              className={`segment-item ${range === option.key ? "active" : ""}`}
              onClick={() => setRange(option.key)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <div className="loading">در حال دریافت داده...</div>
      ) : error ? (
        <div className="empty">داده‌ای دریافت نشد: {error}</div>
      ) : data ? (
        <Chart data={data} tall={tall} />
      ) : null}
    </div>
  );
}