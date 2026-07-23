"use client";

/**
 * Premium desk charts powered by Recharts.
 * Replaces hand-rolled SVG panels with time-true, themed, interactive charts.
 */
import { useEffect, useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { formatPercent } from "@/components/format";

export type DeskChartRange = "24h" | "7d";

export type DeskSeriesPoint = { t: string; v: number };

export type DeskChartSeries = {
  id: string;
  name: string;
  color: string;
  points: DeskSeriesPoint[];
};

type ThemeTokens = {
  blue: string;
  blue2: string;
  green: string;
  yellow: string;
  red: string;
  muted: string;
  muted2: string;
  line: string;
  card: string;
  text: string;
  grid: string;
};

const FALLBACK_DARK: ThemeTokens = {
  blue: "#4aa9f0",
  blue2: "#35d0e0",
  green: "#22d07a",
  yellow: "#f2c14e",
  red: "#ff6b74",
  muted: "#9db0c5",
  muted2: "#7a8fa8",
  line: "rgba(157, 176, 197, 0.22)",
  card: "rgba(18, 36, 56, 0.94)",
  text: "#e8eef6",
  grid: "rgba(157, 176, 197, 0.12)"
};

const FALLBACK_LIGHT: ThemeTokens = {
  blue: "#1774d1",
  blue2: "#0fb5d6",
  green: "#0c9c56",
  yellow: "#a9750f",
  red: "#dc2f3a",
  muted: "#5a6b7d",
  muted2: "#7a8b9c",
  line: "rgba(90, 107, 125, 0.2)",
  card: "rgba(255, 255, 255, 0.96)",
  text: "#142033",
  grid: "rgba(90, 107, 125, 0.12)"
};

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

function readThemeTokens(): ThemeTokens {
  if (typeof document === "undefined") return FALLBACK_DARK;
  const dark = document.documentElement.dataset.theme !== "light";
  const fb = dark ? FALLBACK_DARK : FALLBACK_LIGHT;
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    blue: pick("--blue", fb.blue),
    blue2: pick("--blue-2", fb.blue2),
    green: pick("--green", fb.green),
    yellow: pick("--yellow", fb.yellow),
    red: pick("--red", fb.red),
    muted: pick("--muted", fb.muted),
    muted2: pick("--muted-2", fb.muted2),
    line: pick("--line-soft", fb.line),
    card: pick("--card", fb.card),
    text: pick("--text", fb.text),
    grid: pick("--line-soft", fb.grid)
  };
}

function useThemeTokens(): ThemeTokens {
  const [tokens, setTokens] = useState<ThemeTokens>(FALLBACK_DARK);
  useEffect(() => {
    const sync = () => setTokens(readThemeTokens());
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return tokens;
}

function parseMs(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Collapse consecutive equal values (keep endpoints) so plateaus stay honest. */
function collapseFlats(points: DeskSeriesPoint[]): DeskSeriesPoint[] {
  if (points.length < 3) return points;
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.v) && p.v > 0 && parseMs(p.t) !== null)
    .sort((a, b) => (parseMs(a.t)! - parseMs(b.t)!));
  if (sorted.length < 3) return sorted;
  const out: DeskSeriesPoint[] = [sorted[0]!];
  for (let i = 1; i < sorted.length - 1; i++) {
    const prev = out[out.length - 1]!;
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    const tol = Math.max(Math.abs(prev.v) * 1e-9, 1e-6);
    if (Math.abs(cur.v - prev.v) <= tol && Math.abs(cur.v - next.v) <= tol) continue;
    out.push(cur);
  }
  const last = sorted[sorted.length - 1]!;
  if (out[out.length - 1]!.t !== last.t) out.push(last);
  return out;
}

function axisTimeLabel(ms: number, range: DeskChartRange): string {
  return range === "7d" ? faDay.format(ms) : faTime.format(ms);
}

function tooltipTimeLabel(ms: number, range: DeskChartRange): string {
  return range === "7d" ? faDateTime.format(ms) : faTime.format(ms);
}

function statsFromValues(values: number[]): {
  min: number;
  max: number;
  avg: number;
  last: number;
  first: number;
  change: number | null;
} | null {
  if (!values.length) return null;
  const first = values[0]!;
  const last = values[values.length - 1]!;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((s, v) => s + v, 0) / values.length;
  const change = first !== 0 ? ((last - first) / first) * 100 : null;
  return { min, max, avg, last, first, change };
}

function MiniStats({
  last,
  min,
  max,
  avg,
  change,
  formatValue,
  formatAverage
}: {
  last: number;
  min: number;
  max: number;
  avg: number;
  change: number | null;
  formatValue: (v: number) => string;
  formatAverage?: (v: number) => string;
}) {
  const up = (change ?? 0) >= 0;
  const avgFmt = formatAverage ?? formatValue;
  return (
    <div className="median-chart-mini-stats desk-chart-mini-stats" aria-label="خلاصه بازه نمودار">
      <div className="median-mini-stat">
        <span className="median-mini-stat-label">آخرین</span>
        <span className="median-mini-stat-value number">{formatValue(last)}</span>
      </div>
      <div className="median-mini-stat">
        <span className="median-mini-stat-label">کمترین</span>
        <span className="median-mini-stat-value number">{formatValue(min)}</span>
      </div>
      <div className="median-mini-stat">
        <span className="median-mini-stat-label">بیشترین</span>
        <span className="median-mini-stat-value number">{formatValue(max)}</span>
      </div>
      <div className="median-mini-stat">
        <span className="median-mini-stat-label">میانگین</span>
        <span className="median-mini-stat-value number">{avgFmt(avg)}</span>
      </div>
      <div className="median-mini-stat">
        <span className="median-mini-stat-label">تغییر</span>
        <span className={`median-mini-stat-value number ${up ? "good" : "danger"}`}>
          {change !== null ? formatPercent(change) : "—"}
        </span>
      </div>
    </div>
  );
}

type TooltipRow = { name: string; value: string; color: string };

function DeskTooltip({
  active,
  label,
  rows,
  tokens
}: {
  active?: boolean;
  label?: string;
  rows: TooltipRow[];
  tokens: ThemeTokens;
}) {
  if (!active || !rows.length) return null;
  return (
    <div
      className="desk-chart-tooltip"
      style={
        {
          "--desk-tt-bg": tokens.card,
          "--desk-tt-border": tokens.line,
          "--desk-tt-text": tokens.text,
          "--desk-tt-muted": tokens.muted2
        } as CSSProperties
      }
    >
      {label ? <div className="desk-chart-tooltip-time">{label}</div> : null}
      <div className="desk-chart-tooltip-rows">
        {rows.map((row) => (
          <div className="desk-chart-tooltip-row" key={row.name}>
            <span className="desk-chart-tooltip-swatch" style={{ background: row.color }} />
            <span className="desk-chart-tooltip-name">{row.name}</span>
            <span className="desk-chart-tooltip-value number">{row.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function EmptyChart({ message }: { message?: string }) {
  return (
    <div className="empty desk-chart-empty">
      {message ??
        "هنوز داده کافی برای نمودار ثبت نشده است؛ با باز ماندن داشبورد، روند قیمت به‌مرور تکمیل می‌شود."}
    </div>
  );
}

export type DeskAreaChartProps = {
  range: DeskChartRange;
  points: DeskSeriesPoint[];
  formatValue: (v: number | null | undefined) => string;
  formatAxisValue?: (v: number) => string;
  formatAverage?: (v: number) => string;
  height?: number;
  changePercent?: number | null;
  emptyMessage?: string;
  ariaLabel?: string;
};

/** Single-series area chart (median tether, generic trends). */
export function DeskAreaChart({
  range,
  points,
  formatValue,
  formatAxisValue,
  formatAverage,
  height = 280,
  changePercent,
  emptyMessage,
  ariaLabel = "نمودار روند قیمت"
}: DeskAreaChartProps) {
  const tokens = useThemeTokens();
  const uid = useId().replace(/:/g, "");
  const cleaned = useMemo(() => collapseFlats(points), [points]);

  const rows = useMemo(
    () =>
      cleaned
        .map((p) => {
          const ms = parseMs(p.t);
          if (ms === null) return null;
          return { ms, t: p.t, v: p.v };
        })
        .filter((r): r is { ms: number; t: string; v: number } => r !== null),
    [cleaned]
  );

  // One sample still draws: synthetic twin so Recharts has a segment (honest flat).
  const plotRows = useMemo(() => {
    if (rows.length >= 2) return rows;
    if (rows.length === 1) {
      const only = rows[0]!;
      return [
        { ...only, ms: only.ms - 60_000 },
        only
      ];
    }
    return rows;
  }, [rows]);

  const stats = useMemo(() => statsFromValues(plotRows.map((r) => r.v)), [plotRows]);
  const axisFmt = formatAxisValue ?? ((v: number) => formatValue(v));

  if (!stats || plotRows.length < 1) {
    return <EmptyChart message={emptyMessage} />;
  }

  const change = changePercent ?? stats.change;
  const stroke = tokens.blue;
  const gradId = `deskAreaFill-${uid}`;
  const sparse = rows.length < 2;

  return (
    <div className="median-chart-panel desk-chart-panel" data-chart-engine="recharts" aria-label={ariaLabel}>
      <MiniStats
        last={stats.last}
        min={stats.min}
        max={stats.max}
        avg={stats.avg}
        change={change}
        formatValue={(v) => formatValue(v)}
        formatAverage={formatAverage}
      />
      {sparse ? (
        <p className="desk-chart-sparse-note muted small">
          در این بازه نمونهٔ کم ثبت شده؛ آخرین داده‌های موجود نمایش داده می‌شود.
        </p>
      ) : null}
      <div className="median-chart-body desk-chart-body" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={plotRows} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity={0.45} />
                <stop offset="55%" stopColor={tokens.blue2} stopOpacity={0.16} />
                <stop offset="100%" stopColor={stroke} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke={tokens.grid} strokeDasharray="4 6" vertical={false} />
            <XAxis
              dataKey="ms"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(ms: number) => axisTimeLabel(ms, range)}
              tick={{ fill: tokens.muted2, fontSize: 11, fontWeight: 600 }}
              axisLine={{ stroke: tokens.line }}
              tickLine={false}
              minTickGap={36}
            />
            <YAxis
              domain={["auto", "auto"]}
              width={58}
              tickFormatter={(v: number) => axisFmt(v)}
              tick={{ fill: tokens.muted2, fontSize: 11, fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
              orientation="right"
            />
            <Tooltip
              cursor={{ stroke: tokens.blue, strokeWidth: 1, strokeDasharray: "4 4" }}
              content={({ active, payload, label }) => {
                const v = payload?.[0]?.value;
                if (typeof v !== "number") return null;
                return (
                  <DeskTooltip
                    active={active}
                    label={typeof label === "number" ? tooltipTimeLabel(label, range) : undefined}
                    rows={[{ name: "قیمت", value: formatValue(v), color: stroke }]}
                    tokens={tokens}
                  />
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="v"
              stroke={stroke}
              strokeWidth={2.75}
              fill={`url(#${gradId})`}
              dot={false}
              activeDot={{ r: 5, strokeWidth: 2, stroke: tokens.card, fill: stroke }}
              isAnimationActive
              animationDuration={650}
              animationEasing="ease-out"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export type DeskMultiLineChartProps = {
  range: DeskChartRange;
  series: DeskChartSeries[];
  primaryId?: string;
  formatValue: (v: number | null | undefined) => string;
  formatAxisValue?: (v: number) => string;
  formatAverage?: (v: number) => string;
  height?: number;
  changePercent?: number | null;
  emptyMessage?: string;
  ariaLabel?: string;
};

/** Multi-series line chart (gold sources). */
export function DeskMultiLineChart({
  range,
  series,
  primaryId,
  formatValue,
  formatAxisValue,
  formatAverage,
  height = 300,
  changePercent,
  emptyMessage,
  ariaLabel = "نمودار مقایسه منابع"
}: DeskMultiLineChartProps) {
  const tokens = useThemeTokens();
  const cleanedSeries = useMemo(
    () =>
      series
        .map((s) => ({ ...s, points: collapseFlats(s.points) }))
        .filter((s) => s.points.length > 0),
    [series]
  );

  const { rows, keys } = useMemo(() => {
    const map = new Map<number, Record<string, number | string>>();
    const keyList: string[] = [];
    for (const s of cleanedSeries) {
      keyList.push(s.id);
      for (const p of s.points) {
        const ms = parseMs(p.t);
        if (ms === null) continue;
        const row = map.get(ms) ?? { ms };
        row[s.id] = p.v;
        map.set(ms, row);
      }
    }
    const sorted = [...map.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, row]) => row);
    return { rows: sorted, keys: keyList };
  }, [cleanedSeries]);

  const primary =
    cleanedSeries.find((s) => s.id === primaryId) ?? cleanedSeries[0] ?? null;
  const primaryValues = primary?.points.map((p) => p.v) ?? [];
  const stats = useMemo(() => statsFromValues(primaryValues), [primaryValues]);
  const axisFmt = formatAxisValue ?? ((v: number) => formatValue(v));

  if (!stats || rows.length < 1 || !cleanedSeries.length) {
    return <EmptyChart message={emptyMessage} />;
  }

  const change = changePercent ?? stats.change;
  const colorById = new Map(cleanedSeries.map((s) => [s.id, s.color]));
  const nameById = new Map(cleanedSeries.map((s) => [s.id, s.name]));
  const sparse = rows.length < 2;

  return (
    <div className="median-chart-panel desk-chart-panel" data-chart-engine="recharts" aria-label={ariaLabel}>
      <MiniStats
        last={stats.last}
        min={stats.min}
        max={stats.max}
        avg={stats.avg}
        change={change}
        formatValue={(v) => formatValue(v)}
        formatAverage={formatAverage}
      />
      {sparse ? (
        <p className="desk-chart-sparse-note muted small">
          در این بازه نمونهٔ کم ثبت شده؛ آخرین داده‌های موجود نمایش داده می‌شود.
        </p>
      ) : null}
      <div className="gold-chart-legend desk-chart-legend" aria-label="منابع">
        {cleanedSeries.map((s) => (
          <span className="gold-chart-legend-item" key={s.id}>
            <span className="gold-chart-legend-swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.name}
          </span>
        ))}
      </div>
      <div className="median-chart-body desk-chart-body" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={rows} margin={{ top: 12, right: 12, left: 4, bottom: 4 }}>
            <CartesianGrid stroke={tokens.grid} strokeDasharray="4 6" vertical={false} />
            <XAxis
              dataKey="ms"
              type="number"
              domain={["dataMin", "dataMax"]}
              tickFormatter={(ms: number) => axisTimeLabel(ms, range)}
              tick={{ fill: tokens.muted2, fontSize: 11, fontWeight: 600 }}
              axisLine={{ stroke: tokens.line }}
              tickLine={false}
              minTickGap={36}
            />
            <YAxis
              domain={["auto", "auto"]}
              width={58}
              tickFormatter={(v: number) => axisFmt(v)}
              tick={{ fill: tokens.muted2, fontSize: 11, fontWeight: 600 }}
              axisLine={false}
              tickLine={false}
              orientation="right"
            />
            <Tooltip
              cursor={{ stroke: tokens.blue, strokeWidth: 1, strokeDasharray: "4 4" }}
              content={({ active, payload, label }) => {
                if (!active || !payload?.length) return null;
                const rowsTt: TooltipRow[] = payload
                  .filter((p) => typeof p.value === "number" && p.dataKey)
                  .map((p) => {
                    const id = String(p.dataKey);
                    return {
                      name: nameById.get(id) ?? id,
                      value: formatValue(p.value as number),
                      color: colorById.get(id) ?? tokens.blue
                    };
                  });
                return (
                  <DeskTooltip
                    active={active}
                    label={typeof label === "number" ? tooltipTimeLabel(label, range) : undefined}
                    rows={rowsTt}
                    tokens={tokens}
                  />
                );
              }}
            />
            <Legend content={() => null} />
            {keys.map((id) => {
              const isPrimary = primary?.id === id;
              const color = colorById.get(id) ?? tokens.blue;
              return (
                <Line
                  key={id}
                  type="monotone"
                  dataKey={id}
                  name={nameById.get(id) ?? id}
                  stroke={color}
                  strokeWidth={isPrimary ? 2.9 : 2.2}
                  dot={false}
                  activeDot={{ r: isPrimary ? 5 : 4, strokeWidth: 2, stroke: tokens.card, fill: color }}
                  connectNulls={false}
                  isAnimationActive
                  animationDuration={700}
                  animationEasing="ease-out"
                />
              );
            })}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/** Default palette for gold sources. */
export function goldSourceColor(sourceId: string, tokens?: ThemeTokens): string {
  const t = tokens ?? FALLBACK_DARK;
  if (sourceId === "navasan") return t.blue;
  if (sourceId === "bonbast") return t.green;
  if (sourceId === "talavest") return t.yellow;
  return t.blue2;
}

export function DeskChartShellStats(props: {
  last: ReactNode;
  changePercent: number | null | undefined;
  children?: ReactNode;
}) {
  const up = (props.changePercent ?? 0) >= 0;
  return (
    <div className="median-chart-stats">
      <span className="median-chart-value number">{props.last}</span>
      {props.changePercent !== null && props.changePercent !== undefined ? (
        <span className={`median-chart-change ${up ? "good" : "danger"}`}>
          {formatPercent(props.changePercent)}
        </span>
      ) : null}
      {props.children}
    </div>
  );
}
