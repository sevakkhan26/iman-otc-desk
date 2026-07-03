import { createHash } from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { fetchText } from "@/lib/http";
import { detectAssets, newsCategoryFromAssets } from "@/lib/assets";
import type { DeskSettings, ImpactNewsItem, ImpactNewsResponse, NewsGroup, Severity } from "@/lib/types";

// دسته‌بندی خبر برای صفحه اخبار: اتصال صرافی‌ها (LP) / ایران / جهانی
function newsGroup(title: string): NewsGroup {
  const t = title.toLowerCase();
  if (
    /withdrawal|deposit|maintenance|outage|incident|downtime|halt|suspend|delisting|api\b|صرافی|واریز|برداشت|اختلال|توقف|قطعی/.test(
      t
    )
  ) {
    return "lp";
  }
  if (/iran|tehran|rial|toman|sanction|ایران|تهران|ریال|تومان|تحریم/.test(t)) {
    return "iran";
  }
  return "global";
}

type RssItem = {
  title?: string;
  link?: string;
  pubDate?: string;
  source?: string | { "#text"?: string };
};

const feeds = [
  {
    name: "Google News",
    url:
      "https://news.google.com/rss/search?q=(USDT%20OR%20Tether%20OR%20stablecoin%20OR%20Iran%20sanctions%20crypto%20OR%20Binance%20withdrawal%20OR%20Kraken%20API%20OR%20OKX%20maintenance%20OR%20Bybit%20incident%20OR%20Coinbase%20outage)&hl=en-US&gl=US&ceid=US:en"
  },
  {
    name: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/"
  }
];

const impactfulKeywords = [
  "usdt",
  "tether",
  "stablecoin",
  "usdc",
  "depeg",
  "peg",
  "iran",
  "sanction",
  "regulation",
  "regulator",
  "bank",
  "payment",
  "withdrawal",
  "deposit",
  "maintenance",
  "api",
  "outage",
  "incident",
  "hack",
  "exploit",
  "binance",
  "kraken",
  "okx",
  "bybit",
  "coinbase",
  "fomc",
  "cpi",
  "interest rate",
  "oil",
  "dollar",
  "war",
  "conflict",
  "geopolitical",
  "تحریم",
  "ایران",
  "تتر",
  "بانک",
  "واریز",
  "برداشت",
  "اختلال",
  "هک",
  "رگولاتوری",
  "جنگ"
];

const noiseKeywords = [
  "meme coin",
  "memecoin",
  "nft",
  "airdrop",
  "giveaway",
  "contest",
  "campaign",
  "sponsored",
  "promotion",
  "token launch",
  "gamefi"
];

const exchangeOrStablecoinKeywords = [
  "exchange",
  "binance",
  "kraken",
  "okx",
  "bybit",
  "coinbase",
  "usdt",
  "tether",
  "stablecoin",
  "usdc",
  "withdrawal",
  "deposit",
  "صرافی",
  "تتر",
  "واریز",
  "برداشت"
];

const macroKeywords = ["fomc", "cpi", "interest rate", "oil", "dollar", "نرخ بهره", "نفت", "دلار"];
const cryptoContextKeywords = ["crypto", "bitcoin", "btc", "stablecoin", "usdt", "tether", "iran", "ایران", "تتر", "کریپتو"];

function idFor(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function sourceName(item: RssItem, fallback: string) {
  if (typeof item.source === "string") return item.source;
  return item.source?.["#text"] || fallback;
}

function classify(text: string): Severity {
  const lowered = text.toLowerCase();
  if (
    [
      "depeg",
      "sanction",
      "war",
      "hack",
      "withdrawal suspended",
      "deposit suspended",
      "outage",
      "تحریم",
      "جنگ",
      "هک",
      "توقف برداشت",
      "توقف واریز"
    ].some((keyword) => lowered.includes(keyword))
  ) {
    return "high";
  }
  if (
    ["stablecoin", "regulation", "maintenance", "api", "incident", "bank", "fomc", "cpi", "اختلال", "رگولاتوری"].some(
      (keyword) => lowered.includes(keyword)
    )
  ) {
    return "medium";
  }
  return "low";
}

function impactFor(text: string, severity: Severity) {
  const lowered = text.toLowerCase();
  if (lowered.includes("depeg") || lowered.includes("peg")) {
    return "احتمال اثر مستقیم روی ریسک USDT/USD و قیمت‌گذاری تتر.";
  }
  if (lowered.includes("sanction") || lowered.includes("iran") || lowered.includes("تحریم") || lowered.includes("ایران")) {
    return "احتمال افزایش ریسک پرداخت، نقدشوندگی و پرمیوم USDT/IRT.";
  }
  if (lowered.includes("withdrawal") || lowered.includes("deposit") || lowered.includes("واریز") || lowered.includes("برداشت")) {
    return "احتمال محدود شدن مسیرهای ورودی/خروجی و افزایش ریسک LP.";
  }
  if (lowered.includes("api") || lowered.includes("outage") || lowered.includes("maintenance") || lowered.includes("اختلال")) {
    return "احتمال اثر روی اتصال قیمت، اجرای سفارش یا انتخاب LP.";
  }
  return severity === "high" ? "احتمال اثر عملیاتی مهم روی Dealing Desk." : "اثر احتمالی نیازمند پایش، بدون عددسازی.";
}

function actionFor(text: string, severity: Severity) {
  const lowered = text.toLowerCase();
  if (severity === "high") {
    return "Spread و Max Order بازبینی شود و LP مرتبط موقتاً با احتیاط استفاده شود.";
  }
  if (lowered.includes("api") || lowered.includes("maintenance") || lowered.includes("outage")) {
    return "سلامت اتصال منبع بررسی و fallback قیمت فعال بماند.";
  }
  return "خبر در مانیتورینگ بماند؛ بدون داده تکمیلی اقدام قیمتی قطعی نشود.";
}

function isImpactful(title: string) {
  const lowered = title.toLowerCase();
  const hasImpact = impactfulKeywords.some((keyword) => lowered.includes(keyword));
  const isNoise = noiseKeywords.some((keyword) => lowered.includes(keyword));
  if (!hasImpact || isNoise) return false;

  const isHackOnly = (lowered.includes("hack") || lowered.includes("exploit") || lowered.includes("هک")) &&
    !exchangeOrStablecoinKeywords.some((keyword) => lowered.includes(keyword));
  if (isHackOnly) return false;

  const isMacroOnly = macroKeywords.some((keyword) => lowered.includes(keyword)) &&
    !cryptoContextKeywords.some((keyword) => lowered.includes(keyword));
  if (isMacroOnly) return false;

  return true;
}

async function fetchFeed(feed: (typeof feeds)[number]): Promise<ImpactNewsItem[]> {
  const xml = await fetchText(feed.url, 12_000);
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: ""
  });
  const parsed = parser.parse(xml) as { rss?: { channel?: { item?: RssItem | RssItem[] } } };
  const rawItems = parsed.rss?.channel?.item;
  const items = Array.isArray(rawItems) ? rawItems : rawItems ? [rawItems] : [];

  return items
    .filter((item) => item.title && isImpactful(item.title))
    .slice(0, 20)
    .map((item) => {
      const title = item.title ?? "";
      const severity = classify(title);
      const assets = detectAssets(title);
      return {
        id: idFor(`${title}:${item.link ?? ""}`),
        title,
        source: sourceName(item, feed.name),
        publishedAt: item.pubDate ? new Date(item.pubDate).toISOString() : null,
        severity,
        impactOnUsdtIrt: impactFor(title, severity),
        recommendedAction: actionFor(title, severity),
        assets,
        category: newsCategoryFromAssets(assets),
        group: newsGroup(title),
        url: item.link
      };
    });
}

export async function getImpactNews(settings: DeskSettings): Promise<ImpactNewsResponse> {
  if (settings.enabledSources.news === false) {
    return {
      items: [],
      sourceStatus: "unavailable",
      lastUpdated: null,
      message: "منبع خبر در تنظیمات غیرفعال است"
    };
  }

  const results = await Promise.allSettled(feeds.map(fetchFeed));
  const items = results
    .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
    .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime());

  const unique = Array.from(new Map(items.map((item) => [item.id, item])).values()).slice(0, 30);

  if (!unique.length) {
    const allFailed = results.every((result) => result.status === "rejected");
    return {
      items: [],
      sourceStatus: allFailed ? "unavailable" : "degraded",
      lastUpdated: allFailed ? null : new Date().toISOString(),
      message: allFailed ? "منبع در دسترس نیست" : "داده‌ای دریافت نشد"
    };
  }

  return {
    items: unique,
    sourceStatus: "available",
    lastUpdated: new Date().toISOString()
  };
}
