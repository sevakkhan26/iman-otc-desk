import type {
  AlertItem,
  DeskSettings,
  ExchangeOperationalStatus,
  ForexEvent,
  GlobalPrice,
  ImpactNewsItem,
  TetherMarketResponse
} from "@/lib/types";

type AlertInput = {
  tetherMarket: TetherMarketResponse;
  globalMarket: GlobalPrice[];
  globalStatuses: ExchangeOperationalStatus[];
  news: ImpactNewsItem[];
  forexEvents: ForexEvent[];
  settings: DeskSettings;
};

const nowIso = () => new Date().toISOString();

function idFor(prefix: string, value: string) {
  return `${prefix}-${value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || Date.now()}`;
}

export function buildAlerts(input: AlertInput): AlertItem[] {
  const alerts: AlertItem[] = [];
  const { tetherMarket, globalMarket, globalStatuses, news, forexEvents, settings } = input;
  const alertTime = tetherMarket.summary.lastUpdated ?? nowIso();

  // High-impact forex events: warn 30 minutes before release.
  const now = Date.now();
  for (const event of forexEvents) {
    if (!event.date || event.impact !== "high") continue;
    const eventTime = new Date(event.date).getTime();
    if (!Number.isFinite(eventTime)) continue;
    const minutesUntil = Math.round((eventTime - now) / 60_000);
    if (minutesUntil < 0 || minutesUntil > 30) continue;
    alerts.push({
      id: `forex-${event.id}`,
      title: `⚠️ ${event.category} تا ${minutesUntil} دقیقه دیگر (${event.country})`,
      severity: "high",
      time: event.date,
      source: "تقویم اقتصادی فارکس",
      description: `${event.title} — قبلی: ${event.previous ?? "—"} / پیش‌بینی: ${event.forecast ?? "—"}`,
      impactOnDesk: "داده پرنوسان است؛ احتمال جهش ناگهانی در دلار، طلا و کل بازار کریپتو و در نتیجه قیمت USDT/IRT.",
      recommendedAction: "تا چند دقیقه پس از انتشار، Spread را پهن‌تر و Max Order را کاهش دهید و قیمت‌دهی تهاجمی نکنید.",
      assets: ["MACRO"],
      category: "forex"
    });
  }

  if (
    tetherMarket.summary.marketSpreadPercent !== null &&
    tetherMarket.summary.marketSpreadPercent > settings.marketSpreadAlertThresholdPercent
  ) {
    alerts.push({
      id: "market-spread",
      title: "اختلاف شدید قیمت تتر بین صرافی‌ها",
      severity: tetherMarket.summary.marketSpreadPercent > settings.marketSpreadAlertThresholdPercent * 2 ? "high" : "medium",
      time: alertTime,
      source: "محاسبه بازار تتر ایران",
      description: `اختلاف بازار ${tetherMarket.summary.marketSpreadPercent.toFixed(2)}٪ است${
        tetherMarket.summary.highestExchange && tetherMarket.summary.lowestExchange
          ? ` (${tetherMarket.summary.highestExchange} بالاترین، ${tetherMarket.summary.lowestExchange} پایین‌ترین).`
          : "."
      }`,
      impactOnDesk: "ممکن است قیمت‌گذاری و اجرای OTC نیاز به فاصله امن‌تر داشته باشد.",
      recommendedAction: "Spread و Max Order بازبینی شود و قیمت پرت‌ها از تصمیم قیمت‌گذاری حذف شوند.",
      assets: ["USDT"],
      category: "price-diff"
    });
  }

  for (const exchange of tetherMarket.exchanges) {
    if (exchange.isOutlier) {
      alerts.push({
        id: idFor("outlier", exchange.exchangeId),
        title: `قیمت پرت در ${exchange.exchangeName}`,
        severity: "medium",
        time: exchange.lastUpdated ?? alertTime,
        source: exchange.exchangeName,
        description: `اختلاف با Median: ${
          exchange.deviationFromMedianPercent === null ? "نامشخص" : `${exchange.deviationFromMedianPercent.toFixed(2)}٪`
        }`,
        impactOnDesk: "این قیمت نباید مبنای Median یا انتخاب LP باشد.",
        recommendedAction: "منبع بررسی شود و تا رفع اختلاف از محاسبه قیمت کنار گذاشته شود.",
        assets: ["USDT"],
        category: "price-diff"
      });
    }

    if (exchange.sourceStatus === "unavailable") {
      alerts.push({
        id: idFor("source-down", exchange.exchangeId),
        title: `قطع شدن منبع قیمت ${exchange.exchangeName}`,
        severity: "medium",
        time: alertTime,
        source: exchange.exchangeName,
        description: exchange.errorMessage || "منبع در دسترس نیست",
        impactOnDesk: "پوشش بازار داخلی ناقص می‌شود و اتکا به منابع باقی‌مانده افزایش می‌یابد.",
        recommendedAction: "سلامت API بررسی شود و تا برگشت منبع، وزن آن صفر بماند.",
        assets: ["USDT"],
        category: "lp-specific"
      });
    }
  }

  const tetherUsd = globalMarket.find((item) => item.symbol === "USDT/USD");
  if (tetherUsd?.price !== null && tetherUsd?.price !== undefined) {
    const deviation = Math.abs(tetherUsd.price - 1) * 100;
    if (deviation > settings.depegAlertThresholdPercent) {
      alerts.push({
        id: "depeg-risk",
        title: "Depeg یا ریسک Depeg در USDT/USD",
        severity: deviation > settings.depegAlertThresholdPercent * 2 ? "high" : "medium",
        time: tetherUsd.lastUpdated ?? nowIso(),
        source: tetherUsd.source,
        description: `USDT/USD برابر ${tetherUsd.price.toFixed(4)} است.`,
        impactOnDesk: "ریسک تبدیل و قیمت‌گذاری USDT/IRT بالا می‌رود.",
        recommendedAction: "Spread افزایش یابد و Max Order تا روشن شدن وضعیت کاهش پیدا کند.",
        assets: ["USDT"],
        category: "market"
      });
    }
  } else if (tetherUsd?.sourceStatus === "unavailable") {
    alerts.push({
      id: "depeg-source-down",
      title: "منبع وضعیت USDT/USD در دسترس نیست",
      severity: "medium",
      time: nowIso(),
      source: tetherUsd.source,
      description: tetherUsd.errorMessage || "منبع در دسترس نیست",
      impactOnDesk: "پایش Depeg ناقص است.",
      recommendedAction: "منبع جایگزین USDT/USD یا بررسی دستی فعال شود.",
      assets: ["USDT"],
      category: "market"
    });
  }

  for (const status of globalStatuses) {
    if (status.sourceStatus === "unavailable" || status.apiStatus === "degraded" || status.apiStatus === "unavailable") {
      alerts.push({
        id: idFor("global-exchange", status.exchangeName),
        title: `اختلال یا نبود داده وضعیت ${status.exchangeName}`,
        severity: status.apiStatus === "degraded" ? "medium" : "low",
        time: status.lastUpdated ?? nowIso(),
        source: status.exchangeName,
        description: status.lastIncident || status.errorMessage || "داده‌ای دریافت نشد",
        impactOnDesk: status.impactOnDesk,
        recommendedAction: "در انتخاب LP و مسیر واریز/برداشت این صرافی با احتیاط عمل شود.",
        assets: ["MACRO"],
        category: "market"
      });
    }
  }

  for (const item of news.filter((entry) => entry.severity !== "low").slice(0, 5)) {
    alerts.push({
      id: idFor("news", item.id),
      title: item.title,
      severity: item.severity,
      time: item.publishedAt ?? nowIso(),
      source: item.source,
      description: item.impactOnUsdtIrt,
      impactOnDesk: item.impactOnUsdtIrt,
      recommendedAction: item.recommendedAction,
      assets: item.assets.length ? item.assets : ["MACRO"],
      category: "market"
    });
  }

  return alerts.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
}
