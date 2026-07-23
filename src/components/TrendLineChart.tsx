"use client";

/**
 * Chart shell + thin Recharts wrappers for generic single-series trends.
 * Heavy SVG implementation removed — use DeskCharts (Recharts).
 */
import { useMemo, type ReactNode } from "react";
import { TrendingDown, TrendingUp } from "lucide-react";
import { formatPercent } from "@/components/format";
import { SkeletonBlock } from "@/components/skeletons";
import { DeskAreaChart, type DeskChartRange } from "@/components/DeskCharts";

export type TrendLineChartRange = DeskChartRange;
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

/** @deprecated Prefer DeskAreaChart — kept for call-site compatibility. */
export function TrendLineChartPanel({
  data,
  formatters
}: {
  data: TrendLineChartData;
  formatters: TrendLineChartFormatters;
  pathMode?: "linear" | "smooth";
  breakGaps?: boolean;
}) {
  const points = useMemo(() => data.points ?? [], [data.points]);
  return (
    <DeskAreaChart
      range={data.range}
      points={points}
      formatValue={formatters.formatValue}
      formatAxisValue={formatters.formatAxisValue}
      formatAverage={formatters.formatAverage}
      changePercent={data.changePercent}
      emptyMessage={formatters.emptyMessage}
      ariaLabel={formatters.ariaLabel}
      height={280}
    />
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
