"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { MedianHistoryRange, MedianHistoryResponse } from "@/lib/types";
import { formatPercent } from "@/components/format";
import { TomanAmount } from "@/components/TomanAmount";
import {
  CHART_H_TALL,
  CHART_H as H_DEFAULT,
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

function axisLabelMs(ms: number, range: MedianHistoryRange) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDay.format(date) : faTime.format(date);
}

function tooltipLabel(iso: string, range: MedianHistoryRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDateTime.format(date) : faTime.format(date);
}

function Chart({ data, tall = false }: { data: MedianHistoryResponse; tall?: boolean }) {
  const uid = useId().replace(/:/g, "");
  const colors = useChartColors();
  const bodyRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const H = tall ? CHART_H_TALL : H_DEFAULT;
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
    const linePaths = linePathsFor(plotPoints, range, "smooth");
    const areaPaths = areaPathsFor(plotPoints, baseY, range, "smooth");
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
      linePaths,
      areaPaths,
      lastX: last.x,
      lastY: last.y,
      lastV: last.v,
      lastTime: last.time,
      minV: Math.min(...values),
      maxV: Math.max(...values),
      avg,
      change,
      bands: outageBands(times, range, tMin, tMax, plotW, plotH),
      xTicks: timeAxisTicks(tMin, tMax, range === "7d" ? 6 : 5),
      yTicks: yGridValues(min, max, 5)
    };
  }, [points, data.changePercent, range, H]);

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
        هنوز داده کافی برای نمودار ثبت نشده است؛ با باز ماندن داشبورد، روند قیمت به‌مرور تکمیل می‌شود.
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
      ? overlayPercent(svgRef.current, bodyRef.current, crosshairX, active.y, W, H)
      : { left: (crosshairX / W) * 100, top: (active.y / H) * 100 };
  const lastOverlayPos =
    svgRef.current && bodyRef.current
      ? overlayPercent(svgRef.current, bodyRef.current, geom.lastX, geom.lastY, W, H)
      : { left: (geom.lastX / W) * 100, top: (geom.lastY / H) * 100 };
  const badgeLeft = Math.min(Math.max(lastOverlayPos.left, 8), 72);

  return (
    <div className="median-chart-panel" data-chart-version="premium-v3-time">
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
                  {faNum.format(Math.round(v))}
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
              <path key={`a-${index}`} d={path} fill={`url(#medianFill-${uid})`} className="median-chart-area" />
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
                key={`l-${index}`}
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
              <TomanAmount value={geom.lastV} />
            </span>
          </div>
        ) : null}

        <div
          className={`median-chart-tooltip ${isHovering ? "visible" : ""}`}
          style={{ left: `${overlayPos.left}%`, top: `${overlayPos.top}%` }}
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
