"use client";

import { useMemo } from "react";
import type { GoldHistoryRange, GoldPricesApiSource } from "@/lib/types";
import { DeskMultiLineChart, goldSourceColor, type DeskChartSeries } from "@/components/DeskCharts";

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

const SOURCE_ORDER: Record<string, number> = {
  navasan: 0,
  bonbast: 1,
  talavest: 2
};

export function GoldSourceChartPanel({
  data,
  formatters
}: {
  data: GoldSourceChartData;
  formatters: GoldSourceChartFormatters;
}) {
  const series: DeskChartSeries[] = useMemo(
    () =>
      [...data.series]
        .sort((a, b) => (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9))
        .map((entry) => ({
          id: entry.source,
          name: entry.sourceName,
          color: goldSourceColor(entry.source),
          points: entry.points
        })),
    [data.series]
  );

  return (
    <DeskMultiLineChart
      range={data.range}
      series={series}
      primaryId="navasan"
      formatValue={formatters.formatValue}
      formatAxisValue={formatters.formatAxisValue}
      formatAverage={formatters.formatAverage}
      height={300}
      changePercent={data.changePercent}
      emptyMessage={formatters.emptyMessage}
      ariaLabel={formatters.ariaLabel}
    />
  );
}
