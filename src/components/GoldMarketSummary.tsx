"use client";

import { useMemo, type ReactNode } from "react";
import type { GoldInstrumentType, GoldPricesApiItem, GoldPriceUnit } from "@/lib/types";
import { formatGoldTehran, formatPercent, formatToman, formatUsd } from "@/components/format";

const GOLD_SOURCES = new Set<GoldPricesApiItem["source"]>(["navasan", "bonbast", "talavest"]);

const SOURCE_LABELS: Record<GoldPricesApiItem["source"], string> = {
  navasan: "نوسان",
  bonbast: "بن‌بست",
  talavest: "Talavest"
};

type MarketSummaryStatus = "calm" | "wide" | "review";

type SummaryStats = {
  activeSources: number;
  lastUpdated: string | null;
  maxSpreadPercent: number | null;
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  unit: GoldPriceUnit;
  status: MarketSummaryStatus;
  minSource: string;
  maxSource: string;
};

function comparablePrice(item: GoldPricesApiItem): number | null {
  if (item.mid !== null && Number.isFinite(item.mid)) return item.mid;
  if (item.buy !== null && item.sell !== null && Number.isFinite(item.buy) && Number.isFinite(item.sell)) {
    return (item.buy + item.sell) / 2;
  }
  const single = item.buy ?? item.sell;
  return single !== null && Number.isFinite(single) ? single : null;
}

function formatGoldValue(unit: GoldPriceUnit, value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  return unit === "usd_oz" ? formatUsd(value) : formatToman(value);
}

function statusLabel(status: MarketSummaryStatus): string {
  if (status === "wide") return "اختلاف زیاد";
  if (status === "review") return "نیاز به بررسی";
  return "عادی";
}

function statusTone(status: MarketSummaryStatus): string {
  if (status === "wide") return "warn";
  if (status === "review") return "danger";
  return "good";
}

function computeSummary(items: GoldPricesApiItem[], instrument: GoldInstrumentType): SummaryStats | null {
  const priced = items
    .filter((item) => GOLD_SOURCES.has(item.source) && item.instrument === instrument)
    .map((item) => ({ item, price: comparablePrice(item) }))
    .filter((entry): entry is { item: GoldPricesApiItem; price: number } => entry.price !== null);

  if (priced.length < 2) return null;

  const prices = priced.map((entry) => entry.price);
  const minPrice = Math.min(...prices);
  const maxPrice = Math.max(...prices);
  const avgPrice = prices.reduce((sum, value) => sum + value, 0) / prices.length;
  const maxSpreadPercent = avgPrice > 0 ? ((maxPrice - minPrice) / avgPrice) * 100 : null;

  const minEntry = priced.find((entry) => entry.price === minPrice);
  const maxEntry = priced.find((entry) => entry.price === maxPrice);

  let status: MarketSummaryStatus = "calm";
  if (priced.length < 2) {
    status = "review";
  } else if (maxSpreadPercent !== null && maxSpreadPercent > 2) {
    status = "wide";
  } else if (priced.length < 3) {
    status = "review";
  }

  const timestamps = priced
    .map((entry) => entry.item.lastUpdated)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);

  return {
    activeSources: priced.length,
    lastUpdated: timestamps.length ? new Date(Math.max(...timestamps)).toISOString() : null,
    maxSpreadPercent,
    minPrice,
    maxPrice,
    avgPrice,
    unit: priced[0]?.item.unit ?? "toman",
    status,
    minSource: SOURCE_LABELS[minEntry?.item.source ?? "navasan"],
    maxSource: SOURCE_LABELS[maxEntry?.item.source ?? "navasan"]
  };
}

function SummaryRow({ label, value, note }: { label: string; value: ReactNode; note?: string }) {
  return (
    <div className="gold-summary-row">
      <span className="gold-summary-label">{label}</span>
      <span className="gold-summary-value number">{value}</span>
      {note ? <span className="gold-summary-note muted">{note}</span> : null}
    </div>
  );
}

export function GoldMarketSummary({
  items,
  instrument
}: {
  items: GoldPricesApiItem[];
  instrument: GoldInstrumentType;
}) {
  const summary = useMemo(() => computeSummary(items, instrument), [items, instrument]);

  return (
    <section className="panel gold-summary-panel" data-gold-summary="v1">
      <div className="panel-header">
        <h3 className="panel-title">خلاصه بازار طلا</h3>
      </div>
      <div className="panel-body gold-summary-body">
        <div className="gold-summary-instrument">{instrument}</div>
        {!summary ? (
          <div className="gold-summary-empty">داده کافی برای مقایسه وجود ندارد</div>
        ) : (
          <>
            <div className="gold-summary-stats">
              <SummaryRow label="تعداد منابع فعال" value={summary.activeSources} />
              <SummaryRow
                label="آخرین بروزرسانی"
                value={summary.lastUpdated ? formatGoldTehran(summary.lastUpdated) : "—"}
              />
              <SummaryRow
                label="بیشترین اختلاف بین منابع"
                value={formatPercent(summary.maxSpreadPercent)}
              />
              <SummaryRow
                label="کمترین قیمت"
                value={formatGoldValue(summary.unit, summary.minPrice)}
                note={summary.minSource}
              />
              <SummaryRow
                label="بیشترین قیمت"
                value={formatGoldValue(summary.unit, summary.maxPrice)}
                note={summary.maxSource}
              />
              <SummaryRow label="میانگین قیمت" value={formatGoldValue(summary.unit, summary.avgPrice)} />
            </div>
            <div className="gold-summary-status">
              <span className={`state-pill ${statusTone(summary.status)}`}>
                وضعیت کلی بازار: {statusLabel(summary.status)}
              </span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}