"use client";

import { useEffect, useMemo, useState } from "react";
import type { GoldHistoryRange, GoldHistoryResponse, GoldHistorySeries, GoldInstrumentType, GoldPriceUnit } from "@/lib/types";
import { formatToman, formatUsd } from "@/components/format";
import { GoldSourceChartPanel, type GoldSourceChartData, type GoldSourceChartSeries } from "@/components/GoldSourceChartPanel";
import { MedianChartShell } from "@/components/TrendLineChart";

const INSTRUMENTS: GoldInstrumentType[] = [
  "اونس طلا به دلار",
  "یک گرم طلای 18 عیار",
  "سکه طرح امامی",
  "مثقال طلای آبشده"
];

const SOURCE_ORDER: GoldHistorySeries["source"][] = ["navasan", "bonbast", "talavest"];

const SOURCE_LABELS: Record<GoldHistorySeries["source"], string> = {
  navasan: "نوسان",
  bonbast: "بن‌بست",
  talavest: "Talavest"
};

const faNum = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
const faUsd = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 });

function formatDisplayValue(unit: GoldPriceUnit, value: number | null | undefined) {
  return unit === "usd_oz" ? formatUsd(value) : formatToman(value);
}

function formatAxisValue(unit: GoldPriceUnit, value: number) {
  return unit === "usd_oz" ? faUsd.format(value) : faNum.format(Math.round(value));
}

function isValidPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function cleanSourceSeries(entry: GoldHistorySeries): GoldSourceChartSeries | null {
  const sorted = entry.points
    .filter((point) => point.t && isValidPrice(point.v))
    .map((point) => ({ point, time: new Date(point.t).getTime() }))
    .filter((row) => !Number.isNaN(row.time))
    .sort((a, b) => a.time - b.time);

  const points: Array<{ t: string; v: number }> = [];
  for (const row of sorted) {
    const last = points[points.length - 1];
    if (last && last.t === row.point.t) {
      points[points.length - 1] = { t: row.point.t, v: row.point.v };
      continue;
    }
    points.push({ t: row.point.t, v: row.point.v });
  }

  if (!points.length) return null;
  return {
    source: entry.source,
    sourceName: SOURCE_LABELS[entry.source] ?? entry.sourceName,
    points
  };
}

function prepareChartData(series: GoldHistorySeries[], range: GoldHistoryRange): GoldSourceChartData {
  const bySource = new Map(series.map((entry) => [entry.source, entry]));
  const cleaned = SOURCE_ORDER.map((source) => {
    const entry = bySource.get(source);
    if (!entry) return null;
    return cleanSourceSeries(entry);
  }).filter((entry): entry is GoldSourceChartSeries => entry !== null);

  const primary = cleaned.find((entry) => entry.source === "navasan") ?? cleaned[0];
  const primaryPoints = primary?.points ?? [];
  const first = primaryPoints[0]?.v;
  const last = primaryPoints[primaryPoints.length - 1]?.v;
  const changePercent =
    first !== undefined && last !== undefined && first !== 0 ? ((last - first) / first) * 100 : null;

  return { range, series: cleaned, changePercent };
}

function pickUnit(series: GoldHistorySeries[]): GoldPriceUnit {
  const match = series.find((entry) => SOURCE_ORDER.includes(entry.source) && entry.points.length > 0);
  return match?.unit ?? "toman";
}

function pickLastValue(chartData: GoldSourceChartData | null): number | null {
  if (!chartData?.series.length) return null;
  const primary = chartData.series.find((entry) => entry.source === "navasan") ?? chartData.series[0];
  return primary.points[primary.points.length - 1]?.v ?? null;
}

type GoldPriceChartProps = {
  instrument?: GoldInstrumentType;
  onInstrumentChange?: (instrument: GoldInstrumentType) => void;
};

export function GoldPriceChart({ instrument: controlledInstrument, onInstrumentChange }: GoldPriceChartProps = {}) {
  const [range, setRange] = useState<GoldHistoryRange>("24h");
  const [internalInstrument, setInternalInstrument] = useState<GoldInstrumentType>("اونس طلا به دلار");
  const instrument = controlledInstrument ?? internalInstrument;
  const setInstrument = onInstrumentChange ?? setInternalInstrument;
  const [data, setData] = useState<GoldHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/gold-history?range=${range}&instrument=${encodeURIComponent(instrument)}`, {
      cache: "no-store",
      signal: controller.signal
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as GoldHistoryResponse;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "داده‌ای دریافت نشد");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [range, instrument]);

  const chartData = useMemo<GoldSourceChartData | null>(() => {
    if (!data) return null;
    return prepareChartData(data.series, range);
  }, [data, range]);

  const unit = useMemo(() => (data ? pickUnit(data.series) : "toman"), [data]);
  const lastValue = pickLastValue(chartData);

  const formatters = useMemo(
    () => ({
      formatValue: (value: number | null | undefined) => formatDisplayValue(unit, value),
      formatAxisValue: (value: number) => formatAxisValue(unit, value),
      formatAverage: (value: number) => formatDisplayValue(unit, unit === "usd_oz" ? value : Math.round(value)),
      ariaLabel: `نمودار روند ${instrument}`,
      emptyMessage: "پس از جمع‌آوری داده‌های واقعی، نمودار قیمت طلا نمایش داده می‌شود."
    }),
    [instrument, unit]
  );

  const rangeOptions: Array<{ key: GoldHistoryRange; label: string }> = [
    { key: "24h", label: "۲۴ ساعته" },
    { key: "7d", label: "۷ روزه" }
  ];

  return (
    <MedianChartShell
      className="gold-panel-chart"
      lastValue={formatDisplayValue(unit, lastValue)}
      changePercent={chartData?.changePercent}
      showChange={Boolean(data)}
      range={range}
      rangeOptions={rangeOptions}
      onRangeChange={setRange}
      rangeAriaLabel="بازه زمانی نمودار"
      loading={loading}
      hasData={Boolean(data)}
      error={error}
      toolbar={
        <div className="median-chart-head median-chart-toolbar">
          <div className="segment" role="tablist" aria-label="انتخاب ابزار طلا">
            {INSTRUMENTS.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={instrument === item}
                className={`segment-item ${instrument === item ? "active" : ""}`}
                onClick={() => setInstrument(item)}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {chartData ? <GoldSourceChartPanel data={chartData} formatters={formatters} /> : null}
    </MedianChartShell>
  );
}