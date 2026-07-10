import { NextResponse } from "next/server";
import { buildAlerts } from "@/lib/alerts";
import { calculateTetherMarket } from "@/lib/market";
import { getDomesticQuotes } from "@/lib/providers/domestic";
import { getGlobalExchangeStatuses } from "@/lib/providers/exchangeStatus";
import { getForexEvents } from "@/lib/providers/forex";
import { getGlobalPrices } from "@/lib/providers/globalMarket";
import { getImpactNews } from "@/lib/providers/news";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const settings = await getSettings();
  const [quotes, globalMarket, globalStatuses, news, forex] = await Promise.all([
    getDomesticQuotes(settings),
    getGlobalPrices(settings.globalMarketRefreshMinutes),
    getGlobalExchangeStatuses(settings),
    getImpactNews(settings),
    getForexEvents(settings)
  ]);
  const tetherMarket = calculateTetherMarket(quotes, settings.outlierThresholdPercent);
  const alerts = buildAlerts({
    tetherMarket,
    globalMarket,
    globalStatuses,
    news: news.items,
    forexEvents: forex.events,
    settings
  });
  return NextResponse.json({ items: alerts });
}
