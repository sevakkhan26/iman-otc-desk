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
  ForexEventsResponse,
  GlobalPrice,
  ImpactNewsItem,
  IntelligenceState,
  MarketState,
  QuickDecision,
  TetherMarketResponse,
  TetherMarketSummary
} from "@/lib/types";
import { buildAlerts } from "@/lib/alerts";
import { getIntelligenceState } from "@/lib/intelligence";

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
  /**
   * Genuine Buy+Sell only for executable / market-difference logic.
   * - healthy (available) sources only — not degraded/stale/disconnected
   * - both bid and ask finite and > 0
   * - never invent Buy/Sell from reference/mid
   * - reference-only (null bid or ask) excluded
   */
  const executable = recalculated.filter(
    (exchange) =>
      exchange.sourceStatus === "available" &&
      exchange.buyPrice !== null &&
      exchange.sellPrice !== null &&
      Number.isFinite(exchange.buyPrice) &&
      Number.isFinite(exchange.sellPrice) &&
      exchange.buyPrice > 0 &&
      exchange.sellPrice > 0
  );
  // Mid extremes for «بیشترین قیمت» / «کمترین قیمت» cards only (not market-difference bar).
  // Still restricted to genuine Buy+Sell books — never reference-only mid.
  const highestQuote = pick(executable, (exchange) => exchange.midPrice, "max");
  const lowestQuote = pick(executable, (exchange) => exchange.midPrice, "min");
  const highest = highestQuote?.midPrice ?? null;
  const lowest = lowestQuote?.midPrice ?? null;
  // پایین‌ترین قیمت خرید (Buy/Bid) among genuine books
  const bestBuyQuote = pick(executable, (exchange) => exchange.buyPrice, "min");
  // بالاترین قیمت خرید
  const worstBuyQuote = pick(executable, (exchange) => exchange.buyPrice, "max");
  // بالاترین قیمت فروش (Sell/Ask) among genuine books
  const bestSellQuote = pick(executable, (exchange) => exchange.sellPrice, "max");
  // پایین‌ترین قیمت فروش
  const worstSellQuote = pick(executable, (exchange) => exchange.sellPrice, "min");

  const highestSell = bestSellQuote?.sellPrice ?? null;
  const lowestBuy = bestBuyQuote?.buyPrice ?? null;
  // marketDifferenceToman = highestSell − lowestBuy; percent vs lowestBuy
  const marketSpreadPercent =
    highestSell !== null && lowestBuy !== null && lowestBuy > 0
      ? ((highestSell - lowestBuy) / lowestBuy) * 100
      : null;

  const buySpreadPercent =
    bestBuyQuote?.buyPrice != null && worstBuyQuote?.buyPrice != null && bestBuyQuote.buyPrice > 0
      ? ((worstBuyQuote.buyPrice - bestBuyQuote.buyPrice) / bestBuyQuote.buyPrice) * 100
      : null;

  const sellSpreadPercent =
    bestSellQuote?.sellPrice != null && worstSellQuote?.sellPrice != null && worstSellQuote.sellPrice > 0
      ? ((bestSellQuote.sellPrice - worstSellQuote.sellPrice) / worstSellQuote.sellPrice) * 100
      : null;

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
    worstBuy: worstBuyQuote?.buyPrice ?? null,
    worstBuyExchange: worstBuyQuote?.exchangeName ?? null,
    buySpreadPercent,
    worstSell: worstSellQuote?.sellPrice ?? null,
    worstSellExchange: worstSellQuote?.exchangeName ?? null,
    sellSpreadPercent,
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

/**
 * Canonical tether market for all clients — shared server snapshot (file/Upstash).
 * Browsers never call providers; they only consume this payload.
 */
export async function getTetherMarket(): Promise<TetherMarketResponse> {
  const { getTetherMarketSnapshot } = await import("@/lib/marketSnapshot");
  return getTetherMarketSnapshot();
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
    buySpread: {
      best: { price: summary.bestBuy, exchange: summary.bestBuyExchange },
      worst: { price: summary.worstBuy, exchange: summary.worstBuyExchange },
      percent: summary.buySpreadPercent
    },
    sellSpread: {
      best: { price: summary.bestSell, exchange: summary.bestSellExchange },
      worst: { price: summary.worstSell, exchange: summary.worstSellExchange },
      percent: summary.sellSpreadPercent
    },
    spreadAction,
    maxOrderAction,
    lpCaution,
    outlierWatch
  };
}

export async function getExchangeMonitor(): Promise<ExchangeMonitorResponse> {
  const settings = await getSettings();
  const [domesticResult, globalResult] = await Promise.allSettled([
    getTetherMarket(),
    getGlobalExchangeStatuses(settings)
  ]);
  const domestic =
    domesticResult.status === "fulfilled"
      ? domesticResult.value
      : calculateTetherMarket([], settings.outlierThresholdPercent);
  const global = globalResult.status === "fulfilled" ? globalResult.value : [];
  return {
    domestic: domestic.exchanges,
    global,
    tetherSummary: domestic.summary
  };
}

function emptyForex(): ForexEventsResponse {
  return { events: [], sourceStatus: "unavailable", lastUpdated: null, message: "داده فارکس در دسترس نیست" };
}

function emptyNews(): {
  items: ImpactNewsItem[];
  sourceStatus: "unavailable";
  lastUpdated: null;
  message: string;
} {
  return { items: [], sourceStatus: "unavailable", lastUpdated: null, message: "داده خبر در دسترس نیست" };
}

function emptyIntelligence(enabled: boolean): IntelligenceState {
  return {
    enabled,
    message: "تحلیل هوشمند در پس‌زمینه",
    latest: null
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getDashboard(): Promise<DashboardResponse> {
  const settings = await getSettings();
  const { getTetherMarketSnapshot } = await import("@/lib/marketSnapshot");

  // Tether/LP from shared persistent snapshot; other branches isolated in parallel
  const settled = await Promise.allSettled([
    getTetherMarketSnapshot(),
    getGlobalPrices(settings.globalMarketRefreshMinutes),
    getGlobalExchangeStatuses(settings),
    getImpactNews(settings),
    getForexEvents(settings)
  ]);

  const tetherSnap =
    settled[0].status === "fulfilled"
      ? settled[0].value
      : calculateTetherMarket([], settings.outlierThresholdPercent);
  const globalMarket = settled[1].status === "fulfilled" ? settled[1].value : [];
  const globalStatuses = settled[2].status === "fulfilled" ? settled[2].value : [];
  const news = settled[3].status === "fulfilled" ? settled[3].value : emptyNews();
  const forex = settled[4].status === "fulfilled" ? settled[4].value : emptyForex();

  const tetherMarket: TetherMarketResponse = tetherSnap;

  const alerts = buildAlerts({
    tetherMarket,
    globalMarket,
    globalStatuses,
    news: news.items,
    forexEvents: forex.events,
    settings
  }).slice(0, 20);

  // Intelligence can call OpenAI / disk — hard-cap so it never stalls the shell
  const intelligence = await withTimeout(
    getIntelligenceState({
      tetherMarket,
      globalMarket,
      globalStatuses,
      news: news.items,
      alerts,
      settings
    }),
    1_200,
    emptyIntelligence(Boolean(settings.openAiApiKey))
  );

  const serverNow =
    "serverNow" in tetherSnap && typeof tetherSnap.serverNow === "string"
      ? tetherSnap.serverNow
      : new Date().toISOString();

  return {
    globalMarket,
    tetherMarket,
    marketState: marketStateFromAlerts(alerts),
    quickDecision: buildQuickDecision(tetherMarket, globalMarket, globalStatuses, settings),
    forex,
    intelligence,
    // داشبورد فقط هشدارهای اتصال/قطع LPهای ایرانی را پایین نمایش می‌دهد
    alerts: alerts.filter((alert) => alert.category === "lp-specific").slice(0, 8),
    serverNow,
    generatedAt:
      "generatedAt" in tetherSnap && typeof tetherSnap.generatedAt === "string"
        ? tetherSnap.generatedAt
        : serverNow,
    isStale: "isStale" in tetherSnap ? Boolean(tetherSnap.isStale) : false,
    lastSuccessfulRefreshAt:
      "lastSuccessfulRefreshAt" in tetherSnap
        ? (tetherSnap.lastSuccessfulRefreshAt as string | null)
        : null,
    lastAttemptedRefreshAt:
      "lastAttemptedRefreshAt" in tetherSnap
        ? (tetherSnap.lastAttemptedRefreshAt as string | null)
        : null,
    refreshIntervalMs:
      "refreshIntervalMs" in tetherSnap && typeof tetherSnap.refreshIntervalMs === "number"
        ? tetherSnap.refreshIntervalMs
        : 0
  };
}
