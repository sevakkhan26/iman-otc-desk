import { getDomesticQuotes } from "@/lib/providers/domestic";
import { getGlobalExchangeStatuses } from "@/lib/providers/exchangeStatus";
import { getForexEvents } from "@/lib/providers/forex";
import { getGlobalPrices } from "@/lib/providers/globalMarket";
import { getImpactNews } from "@/lib/providers/news";
import { getSettings } from "@/lib/settings";
import type {
  AlertItem,
  DashboardResponse,
  DecisionCard,
  DeskSettings,
  DomesticQuote,
  ExchangeMonitorResponse,
  ExchangeOperationalStatus,
  GlobalPrice,
  MarketState,
  QuickDecision,
  TetherMarketResponse,
  TetherMarketSummary
} from "@/lib/types";
import { buildAlerts } from "@/lib/alerts";
import { getIntelligenceState } from "@/lib/intelligence";
import { recordMedian } from "@/lib/history";

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function latestTimestamp(values: Array<string | null>) {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function pick<T>(items: T[], selector: (item: T) => number | null, mode: "max" | "min"): T | null {
  let best: T | null = null;
  let bestValue: number | null = null;
  for (const item of items) {
    const value = selector(item);
    if (value === null) continue;
    if (bestValue === null || (mode === "max" ? value > bestValue : value < bestValue)) {
      best = item;
      bestValue = value;
    }
  }
  return best;
}

export function calculateTetherMarket(exchanges: DomesticQuote[], outlierThresholdPercent: number): TetherMarketResponse {
  const candidates = exchanges.filter((exchange) => exchange.midPrice !== null && exchange.sourceStatus !== "unavailable");
  const preliminaryMedian = median(candidates.map((exchange) => exchange.midPrice as number));
  const canDetectOutliers = candidates.length >= 3 && preliminaryMedian !== null;

  const marked = exchanges.map((exchange) => {
    const deviation =
      preliminaryMedian && exchange.midPrice !== null ? ((exchange.midPrice - preliminaryMedian) / preliminaryMedian) * 100 : null;
    const isOutlier = canDetectOutliers && deviation !== null && Math.abs(deviation) > outlierThresholdPercent;
    return {
      ...exchange,
      deviationFromMedianPercent: deviation,
      isOutlier,
      excludedFromMedian: isOutlier
    };
  });

  const finalCandidates = marked.filter(
    (exchange) => exchange.midPrice !== null && exchange.sourceStatus !== "unavailable" && !exchange.excludedFromMedian
  );
  const finalMedian = median(finalCandidates.map((exchange) => exchange.midPrice as number));
  const recalculated = marked.map((exchange) => ({
    ...exchange,
    deviationFromMedianPercent:
      finalMedian && exchange.midPrice !== null ? ((exchange.midPrice - finalMedian) / finalMedian) * 100 : null
  }));
  const valid = recalculated.filter(
    (exchange) => exchange.midPrice !== null && exchange.sourceStatus !== "unavailable" && !exchange.excludedFromMedian
  );
  const highestQuote = pick(valid, (exchange) => exchange.midPrice, "max");
  const lowestQuote = pick(valid, (exchange) => exchange.midPrice, "min");
  const highest = highestQuote?.midPrice ?? null;
  const lowest = lowestQuote?.midPrice ?? null;
  const marketSpreadPercent = highest !== null && lowest !== null && finalMedian ? ((highest - lowest) / finalMedian) * 100 : null;
  // بهترین قیمت خرید = پایین‌ترین قیمت خرید بین صرافی‌ها (ارزان‌ترین نقطه خرید)
  const bestBuyQuote = pick(valid, (exchange) => exchange.buyPrice, "min");
  // بهترین قیمت فروش = بالاترین قیمت فروش بین صرافی‌ها (گران‌ترین نقطه فروش)
  const bestSellQuote = pick(valid, (exchange) => exchange.sellPrice, "max");

  const summary: TetherMarketSummary = {
    median: finalMedian,
    highest,
    highestExchange: highestQuote?.exchangeName ?? null,
    lowest,
    lowestExchange: lowestQuote?.exchangeName ?? null,
    marketSpreadPercent,
    bestBuy: bestBuyQuote?.buyPrice ?? null,
    bestBuyExchange: bestBuyQuote?.exchangeName ?? null,
    bestSell: bestSellQuote?.sellPrice ?? null,
    bestSellExchange: bestSellQuote?.exchangeName ?? null,
    activeSources: recalculated.filter((exchange) => exchange.sourceStatus !== "unavailable").length,
    unavailableSources: recalculated.filter((exchange) => exchange.sourceStatus === "unavailable").length,
    outlierCount: recalculated.filter((exchange) => exchange.isOutlier).length,
    lastUpdated: latestTimestamp(recalculated.map((exchange) => exchange.lastUpdated))
  };

  return {
    summary,
    exchanges: recalculated,
    settings: {
      outlierThresholdPercent,
      marketSpreadAlertThresholdPercent: 0
    }
  };
}

export async function getTetherMarket(): Promise<TetherMarketResponse> {
  const settings = await getSettings();
  const exchanges = await getDomesticQuotes(settings);
  const response = calculateTetherMarket(exchanges, settings.outlierThresholdPercent);
  response.settings.marketSpreadAlertThresholdPercent = settings.marketSpreadAlertThresholdPercent;
  await recordMedian(response.summary.median);
  return response;
}

function marketStateFromAlerts(alerts: AlertItem[]): MarketState {
  if (alerts.some((alert) => alert.severity === "high")) return "risky";
  if (alerts.some((alert) => alert.severity === "medium")) return "caution";
  return "calm";
}

function buildQuickDecision(
  tetherMarket: TetherMarketResponse,
  globalMarket: GlobalPrice[],
  globalStatuses: ExchangeOperationalStatus[],
  settings: DeskSettings
): QuickDecision {
  const { summary, exchanges } = tetherMarket;
  const spread = summary.marketSpreadPercent;
  const spreadThreshold = settings.marketSpreadAlertThresholdPercent;

  let spreadAction: DecisionCard;
  if (spread === null) {
    spreadAction = {
      level: "watch",
      headline: "اختلاف بازار قابل محاسبه نیست",
      detail: "برای تصمیم درباره Spread حداقل به سه منبع فعال نیاز است."
    };
  } else if (spread > spreadThreshold * 2) {
    spreadAction = {
      level: "act",
      headline: "Spread را پهن‌تر کنید",
      detail: `اختلاف بازار ${spread.toFixed(2)}٪ است؛ بیش از دو برابر آستانه ${spreadThreshold}٪.`
    };
  } else if (spread > spreadThreshold) {
    spreadAction = {
      level: "watch",
      headline: "Spread را بازبینی کنید",
      detail: `اختلاف بازار ${spread.toFixed(2)}٪ است؛ بالاتر از آستانه ${spreadThreshold}٪.`
    };
  } else {
    spreadAction = {
      level: "ok",
      headline: "Spread فعلی متناسب است",
      detail: `اختلاف بازار ${spread.toFixed(2)}٪ و زیر آستانه ${spreadThreshold}٪ است.`
    };
  }

  const tetherUsd = globalMarket.find((item) => item.symbol === "USDT/USD");
  const depegDeviation =
    tetherUsd && tetherUsd.price !== null ? Math.abs(tetherUsd.price - 1) * 100 : null;
  const depegRisk = depegDeviation !== null && depegDeviation > settings.depegAlertThresholdPercent;
  const wideSpread = spread !== null && spread > spreadThreshold * 2;
  const manySourcesDown = summary.unavailableSources >= 2;

  let maxOrderAction: DecisionCard;
  if (depegRisk || wideSpread) {
    const reasons = [
      depegRisk ? `ریسک Depeg (${depegDeviation?.toFixed(2)}٪ فاصله از ۱ دلار)` : null,
      wideSpread ? "اختلاف زیاد قیمت بین صرافی‌ها" : null
    ].filter(Boolean);
    maxOrderAction = {
      level: "act",
      headline: "Max Order را کاهش دهید",
      detail: reasons.join(" + ") + "."
    };
  } else if (manySourcesDown || (spread !== null && spread > spreadThreshold)) {
    maxOrderAction = {
      level: "watch",
      headline: "Max Order را محتاطانه نگه دارید",
      detail: manySourcesDown
        ? `${summary.unavailableSources} منبع قطع است؛ پوشش بازار ناقص است.`
        : "اختلاف قیمت بالای آستانه است؛ تا تثبیت بازار محدودیت حفظ شود."
    };
  } else {
    maxOrderAction = {
      level: "ok",
      headline: "Max Order را می‌توان حفظ کرد",
      detail: "ریسک Depeg و اختلاف قیمت در محدوده عادی است."
    };
  }

  const cautionNames: string[] = [];
  for (const exchange of exchanges) {
    if (exchange.sourceStatus === "unavailable") cautionNames.push(`${exchange.exchangeName} (قطع)`);
    else if (exchange.isOutlier) cautionNames.push(`${exchange.exchangeName} (قیمت پرت)`);
    else if (exchange.sourceStatus === "degraded") cautionNames.push(`${exchange.exchangeName} (داده ناقص)`);
  }
  for (const status of globalStatuses) {
    if (status.sourceStatus === "unavailable" || status.apiStatus === "degraded" || status.apiStatus === "unavailable") {
      cautionNames.push(`${status.exchangeName} (اختلال)`);
    }
  }

  const lpCaution: DecisionCard = cautionNames.length
    ? {
        level: cautionNames.length >= 2 || summary.outlierCount > 0 ? "act" : "watch",
        headline: "روی این منابع احتیاط کنید",
        detail: cautionNames.join("، ")
      }
    : {
        level: "ok",
        headline: "همه منابع سالم‌اند",
        detail: "وضعیت اتصال و قیمت همه صرافی‌ها عادی است."
      };

  const outlierNames = exchanges
    .filter((exchange) => exchange.isOutlier)
    .map(
      (exchange) =>
        `${exchange.exchangeName}${
          exchange.deviationFromMedianPercent === null ? "" : ` (${exchange.deviationFromMedianPercent.toFixed(2)}٪)`
        }`
    );
  const outlierWatch: DecisionCard = summary.outlierCount
    ? {
        level: summary.outlierCount >= 2 ? "act" : "watch",
        headline: `${summary.outlierCount} قیمت پرت شناسایی شد`,
        detail: `${outlierNames.join("، ")} — از محاسبه Median کنار گذاشته شد.`
      }
    : {
        level: "ok",
        headline: "قیمت پرتی دیده نشد",
        detail: "همه قیمت‌ها در محدوده آستانه نسبت به Median هستند."
      };

  return {
    median: summary.median,
    spreadPercent: spread,
    highest: { price: summary.highest, exchange: summary.highestExchange },
    lowest: { price: summary.lowest, exchange: summary.lowestExchange },
    bestBuy: { price: summary.bestBuy, exchange: summary.bestBuyExchange },
    bestSell: { price: summary.bestSell, exchange: summary.bestSellExchange },
    spreadAction,
    maxOrderAction,
    lpCaution,
    outlierWatch
  };
}

export async function getExchangeMonitor(): Promise<ExchangeMonitorResponse> {
  const settings = await getSettings();
  const domestic = calculateTetherMarket(await getDomesticQuotes(settings), settings.outlierThresholdPercent);
  const global = await getGlobalExchangeStatuses(settings);
  return {
    domestic: domestic.exchanges,
    global,
    tetherSummary: domestic.summary
  };
}

export async function getDashboard(): Promise<DashboardResponse> {
  const settings = await getSettings();
  const [quotes, globalMarket, globalStatuses, news, forex] = await Promise.all([
    getDomesticQuotes(settings),
    getGlobalPrices(),
    getGlobalExchangeStatuses(settings),
    getImpactNews(settings),
    getForexEvents(settings)
  ]);
  const tetherMarket = calculateTetherMarket(quotes, settings.outlierThresholdPercent);
  tetherMarket.settings.marketSpreadAlertThresholdPercent = settings.marketSpreadAlertThresholdPercent;
  await recordMedian(tetherMarket.summary.median);
  const alerts = buildAlerts({
    tetherMarket,
    globalMarket,
    globalStatuses,
    news: news.items,
    forexEvents: forex.events,
    settings
  }).slice(0, 20);
  const intelligence = await getIntelligenceState({
    tetherMarket,
    globalMarket,
    globalStatuses,
    news: news.items,
    alerts,
    settings
  });

  return {
    globalMarket,
    tetherMarket,
    marketState: marketStateFromAlerts(alerts),
    quickDecision: buildQuickDecision(tetherMarket, globalMarket, globalStatuses, settings),
    forex,
    intelligence,
    alerts: alerts.slice(0, 5)
  };
}
