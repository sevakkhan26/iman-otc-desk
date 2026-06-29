"use client";

import { useEffect, useMemo, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { MedianHistoryRange, MedianHistoryResponse } from "@/lib/types";
import { formatPercent, formatToman } from "@/components/format";

const faNum = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
const faTime = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tehran" });
const faDay = new Intl.DateTimeFormat("fa-IR", { month: "2-digit", day: "2-digit", timeZone: "Asia/Tehran" });

function axisLabel(iso: string, range: MedianHistoryRange) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return range === "7d" ? faDay.format(date) : faTime.format(date);
}

const W = 720;
const H = 240;
const PAD_X = 56;
const PAD_TOP = 18;
const PAD_BOTTOM = 30;

function Chart({ data }: { data: MedianHistoryResponse }) {
  const { points, range } = data;
  const geom = useMemo(() => {
    if (points.length < 2) return null;
    const values = points.map((p) => p.v);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      // flat line: open a small band so it renders mid-height
      const pad = Math.max(Math.abs(min) * 0.001, 1);
      min -= pad;
      max += pad;
    }
    const plotW = W - PAD_X - 16;
    const plotH = H - PAD_TOP - PAD_BOTTOM;
    const x = (i: number) => PAD_X + (i / (points.length - 1)) * plotW;
    const y = (v: number) => PAD_TOP + (1 - (v - min) / (max - min)) * plotH;
    const line = points.map((p, i) => `${x(i)},${y(p.v)}`).join(" ");
    const area = `${PAD_X},${PAD_TOP + plotH} ${line} ${PAD_X + plotW},${PAD_TOP + plotH}`;
    return { min, max, plotW, plotH, x, y, line, area, lastX: x(points.length - 1), lastY: y(points[points.length - 1].v) };
  }, [points]);

  if (!geom) {
    return (
      <div className="empty">
        هنوز داده کافی برای نمودار ثبت نشده است؛ با باز ماندن داشبورد، روند قیمت به‌مرور تکمیل می‌شود.
      </div>
    );
  }

  const up = (data.changePercent ?? 0) >= 0;
  return (
    <svg className="median-chart-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="نمودار روند قیمت میانه تتر">
      <defs>
        <linearGradient id="medianFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--blue)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--blue)" stopOpacity="0" />
        </linearGradient>
      </defs>
      {/* horizontal gridlines + y labels (max / mid / min) */}
      {[0, 0.5, 1].map((frac) => {
        const v = geom.max - frac * (geom.max - geom.min);
        const yy = PAD_TOP + frac * geom.plotH;
        return (
          <g key={frac}>
            <line x1={PAD_X} y1={yy} x2={W - 16} y2={yy} stroke="var(--line-soft)" strokeWidth="1" />
            <text x={PAD_X - 8} y={yy + 4} textAnchor="end" className="median-axis">
              {faNum.format(Math.round(v))}
            </text>
          </g>
        );
      })}
      {/* x labels: first and last */}
      <text x={PAD_X} y={H - 8} textAnchor="start" className="median-axis">
        {axisLabel(points[0].t, range)}
      </text>
      <text x={W - 16} y={H - 8} textAnchor="end" className="median-axis">
        {axisLabel(points[points.length - 1].t, range)}
      </text>
      <polygon points={geom.area} fill="url(#medianFill)" />
      <polyline points={geom.line} fill="none" stroke="var(--blue)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={geom.lastX} cy={geom.lastY} r="4" fill={up ? "var(--green)" : "var(--red)"} stroke="var(--bg)" strokeWidth="2" />
    </svg>
  );
}

export function MedianChart() {
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
    <div className="median-chart">
      <div className="median-chart-head">
        <div className="median-chart-stats">
          <span className="median-chart-value number">{formatToman(data?.last)}</span>
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
        <Chart data={data} />
      ) : null}
    </div>
  );
}
