"use client";

import { useEffect, useState } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import type { MedianHistoryRange, MedianHistoryResponse } from "@/lib/types";
import { formatPercent } from "@/components/format";
import { TomanAmount } from "@/components/TomanAmount";
import { DeskAreaChart } from "@/components/DeskCharts";

const faNum = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });

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
        <DeskAreaChart
          range={range}
          points={data.points ?? []}
          formatValue={(v) => (v == null ? "—" : `تومان ${faNum.format(Math.round(v))}`)}
          formatAxisValue={(v) => faNum.format(Math.round(v))}
          formatAverage={(v) => `تومان ${faNum.format(Math.round(v))}`}
          height={tall ? 420 : 280}
          changePercent={data.changePercent}
          ariaLabel="نمودار روند قیمت میانه تتر"
        />
      ) : null}
    </div>
  );
}
