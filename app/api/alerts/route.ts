import { NextResponse } from "next/server";
import { buildAlertGroups, calculateTetherMarket, getDomesticQuotes, getGlobalExchangeStatuses, getGlobalPrices, getImpactNews, getSettings } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const settings = await getSettings();
  const [quotes, globalMarket, globalStatuses, news] = await Promise.all([
    getDomesticQuotes(settings),
    getGlobalPrices(),
    getGlobalExchangeStatuses(settings),
    getImpactNews(settings)
  ]);
  return NextResponse.json(await buildAlertGroups({ tetherMarket: calculateTetherMarket(quotes, settings.outlierThresholdPercent), globalMarket, globalStatuses, news: news.items, settings }));
}
