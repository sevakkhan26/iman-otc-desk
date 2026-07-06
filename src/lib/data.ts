import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SourceStatus = "available" | "degraded" | "unavailable";
export type Severity = "low" | "medium" | "high";
export type MarketState = "calm" | "caution" | "risky";
export type AssetSymbol = "BTC" | "ETH" | "USDT" | "IRT" | "GLOBAL";
export type NewsCategory = "macro" | "assetSpecific";
export type AlertCategory = "priceVariance" | "iranianLp";

export type DomesticQuote = {
  exchangeId: string;
  exchangeName: string;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  spread: number | null;
  spreadPercent: number | null;
  deviationFromMedianPercent: number | null;
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  errorMessage?: string;
  isOutlier: boolean;
  excludedFromMedian: boolean;
};

export type PricePoint = {
  exchangeId: string;
  exchangeName: string;
  price: number;
};

export type TetherMarketResponse = {
  summary: {
    median: number | null;
    highest: number | null;
    highestExchange: string | null;
    highestPoint: PricePoint | null;
    lowest: number | null;
    lowestExchange: string | null;
    lowestPoint: PricePoint | null;
    marketSpreadPercent: number | null;
    bestBuy: number | null;
    bestSell: number | null;
    activeSources: number;
    connectedSources: number;
    degradedSources: number;
    unavailableSources: number;
    lastUpdated: string | null;
  };
  exchanges: DomesticQuote[];
};

export type GlobalPrice = {
  symbol: "BTC/USDT" | "ETH/USDT" | "USDT/USD";
  price: number | null;
  source: string;
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  errorMessage?: string;
};

export type ExchangeOperationalStatus = {
  exchangeName: "Binance" | "Kraken" | "OKX" | "Bybit" | "Coinbase";
  apiStatus: SourceStatus | "unknown";
  depositStatus: SourceStatus | "unknown";
  withdrawalStatus: SourceStatus | "unknown";
  maintenance: boolean | null;
  lastIncident: string | null;
  lastUpdated: string | null;
  impactOnDesk: string;
  sourceStatus: SourceStatus;
  errorMessage?: string;
};

export type ImpactNewsItem = {
  id: string;
  newsCategory: NewsCategory;
  assets: AssetSymbol[];
  title: string;
  source: string;
  publishedAt: string | null;
  severity: Severity;
  impactOnUsdtIrt: string;
  recommendedAction: string;
  url?: string;
};

export type AlertItem = {
  id: string;
  category: AlertCategory;
  assets: AssetSymbol[];
  title: string;
  severity: Severity;
  time: string;
  source: string;
  description: string;
  impactOnDesk: string;
  recommendedAction: string;
  details?: Record<string, string | number | null>;
};

export type CategorizedAlerts = {
  priceVariance: AlertItem[];
  iranianLp: AlertItem[];
  items: AlertItem[];
};

export type CategorizedNews = {
  macro: ImpactNewsItem[];
  assetSpecific: ImpactNewsItem[];
  items: ImpactNewsItem[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
};

export type DecisionCard = {
  title: string;
  status: MarketState;
  description: string;
  action: string;
};

export type ManualObservation = {
  id: string;
  createdAt: string;
  exchangeName: string;
  observedPrice: number | null;
  note: string;
};

export type IntelligenceReport = {
  id: string;
  generatedAt: string;
  riskLevel: Severity;
  summary: string;
  tetherAndCompetitors: string;
  importantNews: string;
  operationalRisks: string;
  pricingAction: string;
  spreadAction: string;
  lpSelectionAction: string;
  riskLimitsAction: string;
  treasuryAction: string;
  rawText: string;
};

export type IntelligenceState = {
  enabled: boolean;
  message: string;
  latest: IntelligenceReport | null;
};

export type Settings = {
  providerApiKeys: Record<string, string>;
  openAiApiKey: string;
  priceRefreshMinutes: number;
  globalMarketRefreshMinutes: number;
  globalExchangeRefreshMinutes: number;
  newsRefreshMinutes: number;
  intelligenceRefreshMinutes: number;
  outlierThresholdPercent: number;
  marketSpreadAlertThresholdPercent: number;
  depegAlertThresholdPercent: number;
  enabledSources: Record<string, boolean>;
};

const dataDir = path.join(process.cwd(), ".data");
const settingsPath = path.join(dataDir, "settings.json");
const historyPath = path.join(dataDir, "intelligence-history.json");
const sourceStatusPath = path.join(dataDir, "source-status-snapshot.json");
const connectivityAlertsPath = path.join(dataDir, "connectivity-alerts.json");
const manualObservationsPath = path.join(dataDir, "manual-observations.json");
const now = () => new Date().toISOString();

const defaultSettings: Settings = {
  providerApiKeys: {},
  openAiApiKey: "",
  priceRefreshMinutes: 3,
  globalMarketRefreshMinutes: 1,
  globalExchangeRefreshMinutes: 5,
  newsRefreshMinutes: 15,
  intelligenceRefreshMinutes: 60,
  outlierThresholdPercent: 1.5,
  marketSpreadAlertThresholdPercent: 1,
  depegAlertThresholdPercent: 0.5,
  enabledSources: {
    nobitex: true,
    wallex: true,
    bitpin: true,
    tabdeal: true,
    ramzinex: true,
    abantether: true,
    ompfinex: true,
    binance: true,
    kraken: true,
    okx: true,
    bybit: true,
    coinbase: true,
    news: true
  }
};

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toman(value: unknown, unit: "toman" | "rial" = "toman") {
  const parsed = num(value);
  if (parsed === null) return null;
  return unit === "rial" ? parsed / 10 : parsed;
}

async function json<T>(url: string, timeoutMs = 9000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json, text/plain;q=0.8, */*;q=0.5", "user-agent": "otc-desk/0.1" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (!text.trim()) throw new Error("پاسخ خالی بود");
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

async function text(url: string, timeoutMs = 9000): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/rss+xml, application/xml, text/plain;q=0.8", "user-agent": "otc-desk/0.1" }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    if (!body.trim()) throw new Error("پاسخ خالی بود");
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function unavailable(exchangeId: string, exchangeName: string, errorMessage: string): DomesticQuote {
  return {
    exchangeId,
    exchangeName,
    buyPrice: null,
    sellPrice: null,
    midPrice: null,
    spread: null,
    spreadPercent: null,
    deviationFromMedianPercent: null,
    sourceStatus: "unavailable",
    lastUpdated: null,
    errorMessage,
    isOutlier: false,
    excludedFromMedian: false
  };
}

function quote(
  exchangeId: string,
  exchangeName: string,
  buyPrice: number | null,
  sellPrice: number | null,
  midOverride?: number | null,
  errorMessage?: string
): DomesticQuote {
  const midPrice = midOverride ?? (buyPrice !== null && sellPrice !== null ? (buyPrice + sellPrice) / 2 : buyPrice ?? sellPrice);
  const spread = buyPrice !== null && sellPrice !== null ? Math.abs(sellPrice - buyPrice) : null;
  return {
    exchangeId,
    exchangeName,
    buyPrice,
    sellPrice,
    midPrice,
    spread,
    spreadPercent: spread !== null && midPrice ? (spread / midPrice) * 100 : null,
    deviationFromMedianPercent: null,
    sourceStatus: buyPrice === null || sellPrice === null ? "degraded" : "available",
    lastUpdated: now(),
    errorMessage,
    isOutlier: false,
    excludedFromMedian: false
  };
}

async function domesticProvider(id: string, name: string, run: () => Promise<DomesticQuote>) {
  try {
    return await run();
  } catch (error) {
    return unavailable(id, name, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

export async function getSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await readFile(settingsPath, "utf8")) as Partial<Settings>;
    return {
      ...defaultSettings,
      ...raw,
      providerApiKeys: { ...defaultSettings.providerApiKeys, ...(raw.providerApiKeys ?? {}) },
      enabledSources: { ...defaultSettings.enabledSources, ...(raw.enabledSources ?? {}) },
      openAiApiKey: process.env.OPENAI_API_KEY || raw.openAiApiKey || ""
    };
  } catch {
    return { ...defaultSettings, openAiApiKey: process.env.OPENAI_API_KEY || "" };
  }
}

export function publicSettings(settings: Settings) {
  return {
    providerApiKeysConfigured: Object.fromEntries(Object.entries(settings.providerApiKeys).map(([k, v]) => [k, Boolean(v)])),
    openAiApiKeyConfigured: Boolean(settings.openAiApiKey),
    priceRefreshMinutes: settings.priceRefreshMinutes,
    globalMarketRefreshMinutes: settings.globalMarketRefreshMinutes,
    globalExchangeRefreshMinutes: settings.globalExchangeRefreshMinutes,
    newsRefreshMinutes: settings.newsRefreshMinutes,
    intelligenceRefreshMinutes: settings.intelligenceRefreshMinutes,
    outlierThresholdPercent: settings.outlierThresholdPercent,
    marketSpreadAlertThresholdPercent: settings.marketSpreadAlertThresholdPercent,
    depegAlertThresholdPercent: settings.depegAlertThresholdPercent,
    enabledSources: settings.enabledSources
  };
}

export async function patchSettings(patch: Partial<Settings>) {
  const current = await getSettings();
  const next: Settings = {
    ...current,
    ...patch,
    providerApiKeys: { ...current.providerApiKeys, ...(patch.providerApiKeys ?? {}) },
    enabledSources: { ...current.enabledSources, ...(patch.enabledSources ?? {}) },
    openAiApiKey: patch.openAiApiKey?.trim() || current.openAiApiKey
  };
  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
  return publicSettings(next);
}

export async function getDomesticQuotes(settings: Settings): Promise<DomesticQuote[]> {
  const disabled = (id: string, name: string) => unavailable(id, name, "این منبع در تنظیمات غیرفعال است");
  const providers: Array<[string, string, () => Promise<DomesticQuote>]> = [
    [
      "nobitex",
      "نوبیتکس",
      async () => {
        const data = await json<{ stats?: Record<string, { bestBuy?: string; bestSell?: string }> }>(
          "https://api.nobitex.ir/market/stats?srcCurrency=usdt&dstCurrency=rls"
        );
        const item = data.stats?.["usdt-rls"] ?? data.stats?.USDT_RLS;
        const buy = toman(item?.bestBuy, "rial");
        const sell = toman(item?.bestSell, "rial");
        if (buy === null && sell === null) throw new Error("داده قیمت تتر دریافت نشد");
        return quote("nobitex", "نوبیتکس", buy, sell);
      }
    ],
    [
      "wallex",
      "والکس",
      async () => {
        const data = await json<{ result?: { symbols?: Record<string, { stats?: { bidPrice?: string; askPrice?: string } }> } }>(
          "https://api.wallex.ir/v1/markets"
        );
        const stats = data.result?.symbols?.USDTTMN?.stats;
        const buy = toman(stats?.bidPrice);
        const sell = toman(stats?.askPrice);
        if (buy === null && sell === null) throw new Error("داده قیمت تتر دریافت نشد");
        return quote("wallex", "والکس", buy, sell);
      }
    ],
    [
      "bitpin",
      "بیت‌پین",
      async () => {
        const data = await json<Array<{ symbol?: string; price?: string; timestamp?: number }>>(
          "https://api.bitpin.org/api/v1/mkt/tickers/?symbol=USDT_IRT"
        );
        const item = data.find((entry) => entry.symbol === "USDT_IRT");
        const mid = toman(item?.price);
        if (mid === null) throw new Error("داده قیمت تتر دریافت نشد");
        const q = quote("bitpin", "بیت‌پین", null, null, mid, "API عمومی فقط آخرین قیمت را برگرداند");
        q.lastUpdated = item?.timestamp ? new Date(item.timestamp * 1000).toISOString() : now();
        return q;
      }
    ],
    [
      "tabdeal",
      "تبدیل",
      async () => {
        const data = await json<{ asks?: Array<[string, string]>; bids?: Array<[string, string]> }>(
          "https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=1"
        );
        const buy = toman(data.bids?.[0]?.[0]);
        const sell = toman(data.asks?.[0]?.[0]);
        if (buy === null && sell === null) throw new Error("داده دفتر سفارش دریافت نشد");
        return quote("tabdeal", "تبدیل", buy, sell);
      }
    ],
    [
      "ramzinex",
      "رمزینکس",
      async () => {
        const data = await json<{ data?: Array<{ pair_id?: number; buy?: number; sell?: number }> }>(
          "https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs"
        );
        const item = data.data?.find((entry) => entry.pair_id === 11);
        const buy = toman(item?.buy, "rial");
        const sell = toman(item?.sell, "rial");
        if (buy === null && sell === null) throw new Error("داده قیمت تتر دریافت نشد");
        return quote("ramzinex", "رمزینکس", buy, sell);
      }
    ],
    [
      "abantether",
      "آبان‌تتر",
      async () => {
        const data = await json<Record<string, unknown>>("https://api.abantether.com/api/v1/otc/coin-price/?symbol=USDT");
        const buy = toman(data.buy ?? data.buyPrice ?? data.bid);
        const sell = toman(data.sell ?? data.sellPrice ?? data.ask);
        if (buy === null && sell === null) throw new Error("API عمومی سازگار دریافت نشد");
        return quote("abantether", "آبان‌تتر", buy, sell);
      }
    ],
    [
      "ompfinex",
      "OMPFinex",
      async () => {
        const data = await json<Record<string, unknown>>("https://api.ompfinex.com/v1/markets");
        const rows = Array.isArray(data.data) ? data.data : [];
        const item = rows.find((row) => {
          const record = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
          return String(record.symbol ?? record.market ?? "").toLowerCase().includes("usdt");
        }) as Record<string, unknown> | undefined;
        const mid = toman(item?.price ?? item?.last);
        if (mid === null) throw new Error("داده قیمت تتر دریافت نشد");
        return quote("ompfinex", "OMPFinex", null, null, mid, "خرید و فروش کامل دریافت نشد");
      }
    ]
  ];
  return Promise.all(providers.map(([id, name, run]) => (settings.enabledSources[id] === false ? disabled(id, name) : domesticProvider(id, name, run))));
}

function median(values: number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
}

function latest(values: Array<string | null>) {
  const times = values.map((v) => (v ? new Date(v).getTime() : NaN)).filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}

export function calculateTetherMarket(exchanges: DomesticQuote[], outlierThresholdPercent: number): TetherMarketResponse {
  const prelim = median(exchanges.filter((e) => e.midPrice !== null && e.sourceStatus !== "unavailable").map((e) => e.midPrice as number));
  const canDetect = prelim !== null && exchanges.filter((e) => e.midPrice !== null).length >= 3;
  const marked = exchanges.map((e) => {
    const deviation = prelim && e.midPrice !== null ? ((e.midPrice - prelim) / prelim) * 100 : null;
    const isOutlier = canDetect && deviation !== null && Math.abs(deviation) > outlierThresholdPercent;
    return { ...e, deviationFromMedianPercent: deviation, isOutlier, excludedFromMedian: isOutlier };
  });
  const valid = marked.filter((e) => e.midPrice !== null && e.sourceStatus !== "unavailable" && !e.excludedFromMedian);
  const finalMedian = median(valid.map((e) => e.midPrice as number));
  const recalculated = marked.map((e) => ({
    ...e,
    deviationFromMedianPercent: finalMedian && e.midPrice !== null ? ((e.midPrice - finalMedian) / finalMedian) * 100 : null
  }));
  const finalValid = recalculated.filter((e) => e.midPrice !== null && e.sourceStatus !== "unavailable" && !e.excludedFromMedian);
  const mids = finalValid.map((e) => e.midPrice as number);
  const buys = finalValid.map((e) => e.buyPrice).filter((v): v is number => v !== null);
  const sells = finalValid.map((e) => e.sellPrice).filter((v): v is number => v !== null);
  const highestRow = finalValid.reduce<DomesticQuote | null>((selected, row) => {
    if (row.midPrice === null) return selected;
    if (!selected || selected.midPrice === null || row.midPrice > selected.midPrice) return row;
    return selected;
  }, null);
  const lowestRow = finalValid.reduce<DomesticQuote | null>((selected, row) => {
    if (row.midPrice === null) return selected;
    if (!selected || selected.midPrice === null || row.midPrice < selected.midPrice) return row;
    return selected;
  }, null);
  const highest = highestRow?.midPrice ?? (mids.length ? Math.max(...mids) : null);
  const lowest = lowestRow?.midPrice ?? (mids.length ? Math.min(...mids) : null);
  return {
    summary: {
      median: finalMedian,
      highest,
      highestExchange: highestRow?.exchangeName ?? null,
      highestPoint:
        highestRow?.midPrice !== null && highestRow?.midPrice !== undefined
          ? { exchangeId: highestRow.exchangeId, exchangeName: highestRow.exchangeName, price: highestRow.midPrice }
          : null,
      lowest,
      lowestExchange: lowestRow?.exchangeName ?? null,
      lowestPoint:
        lowestRow?.midPrice !== null && lowestRow?.midPrice !== undefined
          ? { exchangeId: lowestRow.exchangeId, exchangeName: lowestRow.exchangeName, price: lowestRow.midPrice }
          : null,
      marketSpreadPercent: highest !== null && lowest !== null && finalMedian ? ((highest - lowest) / finalMedian) * 100 : null,
      bestBuy: buys.length ? Math.max(...buys) : null,
      bestSell: sells.length ? Math.min(...sells) : null,
      activeSources: recalculated.filter((e) => e.sourceStatus !== "unavailable").length,
      connectedSources: recalculated.filter((e) => e.sourceStatus === "available").length,
      degradedSources: recalculated.filter((e) => e.sourceStatus === "degraded").length,
      unavailableSources: recalculated.filter((e) => e.sourceStatus === "unavailable").length,
      lastUpdated: latest(recalculated.map((e) => e.lastUpdated))
    },
    exchanges: recalculated
  };
}

async function gate(pair: string, symbol: GlobalPrice["symbol"]): Promise<GlobalPrice> {
  try {
    const data = await json<Array<{ last?: string }>>(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`);
    const price = num(data[0]?.last);
    if (price === null) throw new Error("داده قیمت دریافت نشد");
    return { symbol, price, source: "Gate.io", sourceStatus: "available", lastUpdated: now() };
  } catch (error) {
    return { symbol, price: null, source: "Gate.io", sourceStatus: "unavailable", lastUpdated: null, errorMessage: error instanceof Error ? error.message : "منبع در دسترس نیست" };
  }
}

export async function getGlobalPrices() {
  return Promise.all([gate("BTC_USDT", "BTC/USDT"), gate("ETH_USDT", "ETH/USDT"), gate("USDT_USD", "USDT/USD")]);
}

function exchangeUnavailable(exchangeName: ExchangeOperationalStatus["exchangeName"], errorMessage: string): ExchangeOperationalStatus {
  return {
    exchangeName,
    apiStatus: "unavailable",
    depositStatus: "unknown",
    withdrawalStatus: "unknown",
    maintenance: null,
    lastIncident: null,
    lastUpdated: null,
    impactOnDesk: "برای انتخاب LP و مسیر واریز/برداشت با احتیاط عمل شود.",
    sourceStatus: "unavailable",
    errorMessage
  };
}

async function exchangeStatus(exchangeName: ExchangeOperationalStatus["exchangeName"], url: string) {
  try {
    const data = await json<Record<string, unknown>>(url, 8000);
    const status = data.status && typeof data.status === "object" ? (data.status as Record<string, unknown>) : {};
    const indicator = String(status.indicator ?? "");
    const description = String(status.description ?? "");
    const degraded = Boolean(indicator && indicator !== "none");
    return {
      exchangeName,
      apiStatus: degraded ? "degraded" : "available",
      depositStatus: "unknown",
      withdrawalStatus: "unknown",
      maintenance: degraded,
      lastIncident: description || null,
      lastUpdated: now(),
      impactOnDesk: degraded ? "برای قیمت‌گذاری و LP احتیاط شود." : "ریسک عملیاتی خاصی از وضعیت عمومی دیده نشد.",
      sourceStatus: "available"
    } satisfies ExchangeOperationalStatus;
  } catch (error) {
    return exchangeUnavailable(exchangeName, error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

export async function getGlobalExchangeStatuses(settings: Settings): Promise<ExchangeOperationalStatus[]> {
  const rows: Array<[keyof Settings["enabledSources"], ExchangeOperationalStatus["exchangeName"], string]> = [
    ["binance", "Binance", "https://api.binance.com/sapi/v1/system/status"],
    ["kraken", "Kraken", "https://status.kraken.com/api/v2/status.json"],
    ["okx", "OKX", "https://www.okx.com/api/v5/system/status"],
    ["bybit", "Bybit", "https://api.bybit.com/v5/system/status"],
    ["coinbase", "Coinbase", "https://status.coinbase.com/api/v2/status.json"]
  ];
  return Promise.all(rows.map(([id, name, url]) => (settings.enabledSources[String(id)] === false ? Promise.resolve(exchangeUnavailable(name, "این منبع در تنظیمات غیرفعال است")) : exchangeStatus(name, url))));
}

function cleanXml(value: string) {
  return value.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();
}

const impactfulNewsKeywords = [
  "usdt",
  "tether",
  "stablecoin",
  "usdc",
  "depeg",
  "iran",
  "sanction",
  "withdrawal",
  "deposit",
  "api",
  "outage",
  "maintenance",
  "binance",
  "kraken",
  "okx",
  "bybit",
  "coinbase",
  "regulation",
  "fomc",
  "cpi",
  "interest rate",
  "fed",
  "oil",
  "dollar",
  "geopolitical",
  "war",
  "etf",
  "bitcoin",
  "btc",
  "ethereum",
  "eth",
  "hack",
  "exploit",
  "تحریم",
  "ایران",
  "تتر",
  "برداشت",
  "واریز",
  "اختلال",
  "نرخ بهره",
  "تورم",
  "نفت",
  "دلار",
  "جنگ",
  "هک"
];

const lowValueNewsKeywords = ["meme", "nft", "airdrop", "giveaway", "contest", "campaign", "sponsored"];

function newsSeverity(title: string): Severity {
  const lowered = title.toLowerCase();
  if (["depeg", "sanction", "withdrawal", "outage", "hack", "exploit", "تحریم", "برداشت", "هک"].some((k) => lowered.includes(k))) return "high";
  return "medium";
}

function detectAssets(textValue: string): AssetSymbol[] {
  const lowered = textValue.toLowerCase();
  const assets = new Set<AssetSymbol>();
  if (["btc", "bitcoin", "بیت کوین", "بیت‌کوین"].some((k) => lowered.includes(k))) assets.add("BTC");
  if (["eth", "ethereum", "اتریوم"].some((k) => lowered.includes(k))) assets.add("ETH");
  if (["usdt", "tether", "stablecoin", "usdc", "depeg", "تتر", "استیبل"].some((k) => lowered.includes(k))) assets.add("USDT");
  if (["irt", "iran", "rial", "toman", "ایران", "ریال", "تومان"].some((k) => lowered.includes(k))) assets.add("IRT");
  if (!assets.size) assets.add("GLOBAL");
  return [...assets];
}

function classifyNewsCategory(title: string): NewsCategory {
  const lowered = title.toLowerCase();
  const macroKeywords = [
    "fomc",
    "cpi",
    "interest rate",
    "fed",
    "oil",
    "dollar",
    "sanction",
    "iran",
    "war",
    "geopolitical",
    "regulation",
    "hack",
    "outage",
    "exchange",
    "نرخ بهره",
    "تورم",
    "تحریم",
    "جنگ",
    "نفت",
    "دلار",
    "رگولاتوری"
  ];
  const assetSpecificKeywords = ["btc", "bitcoin", "eth", "ethereum", "etf", "upgrade", "halving", "بیت", "اتریوم"];
  if (macroKeywords.some((k) => lowered.includes(k))) return "macro";
  if (assetSpecificKeywords.some((k) => lowered.includes(k))) return "assetSpecific";
  return detectAssets(title).includes("GLOBAL") ? "macro" : "assetSpecific";
}

function isImpactfulNews(title: string) {
  const lowered = title.toLowerCase();
  const impactful = impactfulNewsKeywords.some((k) => lowered.includes(k));
  const lowValue = lowValueNewsKeywords.some((k) => lowered.includes(k));
  const hackNeedsMajorContext = (lowered.includes("hack") || lowered.includes("exploit") || lowered.includes("هک")) &&
    !["exchange", "binance", "kraken", "okx", "bybit", "coinbase", "stablecoin", "usdt", "tether", "صرافی", "تتر"].some((k) => lowered.includes(k));
  return impactful && !lowValue && !hackNeedsMajorContext;
}

function impactTextForNews(title: string) {
  const lowered = title.toLowerCase();
  if (lowered.includes("depeg")) return "احتمال اثر مستقیم روی ریسک USDT/USD و قیمت‌گذاری تتر ایران.";
  if (lowered.includes("sanction") || lowered.includes("iran") || lowered.includes("تحریم") || lowered.includes("ایران")) return "احتمال اثر روی پرمیوم USDT/IRT، پرداخت و ریسک نقدشوندگی.";
  if (lowered.includes("withdrawal") || lowered.includes("deposit") || lowered.includes("برداشت") || lowered.includes("واریز")) return "احتمال محدود شدن مسیرهای ورودی/خروجی و افزایش ریسک LP.";
  if (lowered.includes("api") || lowered.includes("outage") || lowered.includes("maintenance") || lowered.includes("اختلال")) return "احتمال اثر روی اتصال قیمت، اجرای سفارش یا انتخاب LP.";
  return "احتمال اثر روی ریسک USDT/IRT یا عملیات Dealing Desk؛ بدون داده تکمیلی عددسازی نمی‌شود.";
}

function newsAction(title: string, severity: Severity) {
  const lowered = title.toLowerCase();
  if (severity === "high") return "Spread و Max Order بازبینی شود و LP مرتبط با احتیاط استفاده شود.";
  if (lowered.includes("api") || lowered.includes("outage") || lowered.includes("maintenance")) return "سلامت اتصال منبع بررسی و fallback قیمت آماده باشد.";
  return "خبر پایش شود و اقدام قطعی با داده تکمیلی انجام شود.";
}

function parseRssNews(rss: string, fallbackSource: string): ImpactNewsItem[] {
  return [...rss.matchAll(/<item>([\s\S]*?)<\/item>/g)]
    .map((match, index): ImpactNewsItem | null => {
      const block = match[1];
      const title = cleanXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "");
      if (!title || !isImpactfulNews(title)) return null;
      const severity = newsSeverity(title);
      const source = cleanXml(block.match(/<source[^>]*>([\s\S]*?)<\/source>/)?.[1] ?? fallbackSource);
      const pubDate = cleanXml(block.match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1] ?? "");
      return {
        id: `${fallbackSource}-${index}-${title.slice(0, 28).replace(/\W/g, "")}`,
        newsCategory: classifyNewsCategory(title),
        assets: detectAssets(title),
        title,
        source,
        publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
        severity,
        impactOnUsdtIrt: impactTextForNews(title),
        recommendedAction: newsAction(title, severity),
        url: cleanXml(block.match(/<link>([\s\S]*?)<\/link>/)?.[1] ?? "")
      };
    })
    .filter((item): item is ImpactNewsItem => item !== null);
}

async function fetchCoinMarketCapNews(): Promise<ImpactNewsItem[]> {
  const html = await text("https://coinmarketcap.com/headlines/news/", 12000);
  if (html.includes("awsWaf") || html.includes("challenge.js")) {
    throw new Error("CoinMarketCap headlines در دسترس نیست");
  }
  const titles = [...html.matchAll(/<a[^>]+href="([^"]*headlines[^"]*)"[^>]*>([\s\S]*?)<\/a>/g)]
    .map((match, index): ImpactNewsItem | null => {
      const title = cleanXml(match[2]);
      if (!title || !isImpactfulNews(title)) return null;
      const severity = newsSeverity(title);
      return {
        id: `cmc-${index}-${title.slice(0, 28).replace(/\W/g, "")}`,
        newsCategory: classifyNewsCategory(title),
        assets: detectAssets(title),
        title,
        source: "CoinMarketCap",
        publishedAt: null,
        severity,
        impactOnUsdtIrt: impactTextForNews(title),
        recommendedAction: newsAction(title, severity),
        url: match[1].startsWith("http") ? match[1] : `https://coinmarketcap.com${match[1]}`
      };
    })
    .filter((item): item is ImpactNewsItem => item !== null);
  if (!titles.length) throw new Error("CoinMarketCap خبر قابل استفاده برنگرداند");
  return titles;
}

export async function getImpactNews(settings: Settings) {
  if (settings.enabledSources.news === false) {
    return {
      macro: [],
      assetSpecific: [],
      items: [],
      sourceStatus: "unavailable" as SourceStatus,
      lastUpdated: null,
      message: "منبع خبری در دسترس نیست"
    } satisfies CategorizedNews;
  }

  const providers = [
    fetchCoinMarketCapNews,
    async () => parseRssNews(await text("https://www.coindesk.com/arc/outboundfeeds/rss/", 12000), "CoinDesk"),
    async () =>
      parseRssNews(
        await text("https://news.google.com/rss/search?q=(USDT%20OR%20Tether%20OR%20stablecoin%20OR%20Bitcoin%20OR%20BTC%20OR%20Ethereum%20OR%20ETH%20OR%20ETF%20OR%20FOMC%20OR%20CPI%20OR%20interest%20rate%20OR%20Iran%20sanctions%20crypto%20OR%20Binance%20withdrawal%20OR%20Kraken%20API%20OR%20OKX%20maintenance%20OR%20Bybit%20incident%20OR%20Coinbase%20outage)&hl=en-US&gl=US&ceid=US:en", 12000),
        "Google News"
      )
  ];

  const results = await Promise.allSettled(providers.map((provider) => provider()));
  const items = Array.from(
    new Map(
      results
        .flatMap((result) => (result.status === "fulfilled" ? result.value : []))
        .sort((a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime())
        .map((item) => [item.title, item])
    ).values()
  ).slice(0, 30);

  if (!items.length) {
    const allFailed = results.every((result) => result.status === "rejected");
    return {
      macro: [],
      assetSpecific: [],
      items: [],
      sourceStatus: allFailed ? "unavailable" as SourceStatus : "degraded" as SourceStatus,
      lastUpdated: allFailed ? null : now(),
      message: allFailed ? "منبع خبری در دسترس نیست" : "داده‌ای دریافت نشد"
    } satisfies CategorizedNews;
  }

  return {
    macro: items.filter((item) => item.newsCategory === "macro"),
    assetSpecific: items.filter((item) => item.newsCategory === "assetSpecific"),
    items,
    sourceStatus: "available" as SourceStatus,
    lastUpdated: now(),
    message: undefined
  } satisfies CategorizedNews;
}

type SourceSnapshot = Record<string, { name: string; status: SourceStatus; lastSeen: string }>;

async function readConnectivityHistory(): Promise<AlertItem[]> {
  try {
    const parsed = JSON.parse(await readFile(connectivityAlertsPath, "utf8")) as AlertItem[];
    return Array.isArray(parsed)
      ? parsed.map((item) => ({
          ...item,
          category: "iranianLp" as const,
          assets: item.assets?.length ? item.assets : ["USDT", "IRT"]
        }))
      : [];
  } catch {
    return [];
  }
}

async function syncConnectivityAlerts(current: SourceSnapshot): Promise<AlertItem[]> {
  let previous: SourceSnapshot = {};
  try {
    previous = JSON.parse(await readFile(sourceStatusPath, "utf8")) as SourceSnapshot;
  } catch {
    previous = {};
  }

  const createdAt = now();
  const newAlerts: AlertItem[] = Object.entries(current)
    .filter(([id, value]) => previous[id] && previous[id].status !== value.status)
    .map(([id, value]) => {
      const oldStatus = previous[id].status;
      const connected = value.status === "available";
      return {
        id: `connectivity-${id}-${createdAt}`,
        category: "iranianLp" as const,
        assets: ["USDT", "IRT"],
        title: `${value.name} ${connected ? "وصل شد" : "قطع یا ناپایدار شد"}`,
        severity: connected ? "low" : "medium",
        time: createdAt,
        source: value.name,
        description: `وضعیت قبلی: ${oldStatus} / وضعیت جدید: ${value.status}`,
        impactOnDesk: connected ? "ظرفیت انتخاب LP بهتر شد." : "پوشش قیمت یا مسیر LP محدودتر شده است.",
        recommendedAction: connected ? "وزن منبع پس از یک چک دستی می‌تواند برگردد." : "تا پایدار شدن منبع، وزن آن در Pricing و LP Selection کاهش یابد.",
        details: {
          previousStatus: oldStatus,
          newStatus: value.status
        }
      };
    });

  const history = [...newAlerts, ...(await readConnectivityHistory())].slice(0, 50);
  await mkdir(dataDir, { recursive: true });
  await writeFile(sourceStatusPath, JSON.stringify(current, null, 2), "utf8");
  await writeFile(connectivityAlertsPath, JSON.stringify(history, null, 2), "utf8");
  return history;
}

function isIranianLpNews(item: ImpactNewsItem) {
  const lowered = item.title.toLowerCase();
  return [
    "nobitex",
    "wallex",
    "bitpin",
    "tabdeal",
    "ramzinex",
    "aban",
    "ompfinex",
    "iran",
    "sanction",
    "payment",
    "نوبیتکس",
    "والکس",
    "بیت‌پین",
    "تبدیل",
    "رمزینکس",
    "آبان",
    "ایران",
    "تحریم",
    "پرداخت"
  ].some((keyword) => lowered.includes(keyword));
}

export async function buildAlertGroups(input: { tetherMarket: TetherMarketResponse; globalMarket: GlobalPrice[]; globalStatuses: ExchangeOperationalStatus[]; news: ImpactNewsItem[]; settings: Settings }): Promise<CategorizedAlerts> {
  const time = input.tetherMarket.summary.lastUpdated ?? now();
  const priceVariance: AlertItem[] = [];
  const iranianLp: AlertItem[] = [];
  const spread = input.tetherMarket.summary.marketSpreadPercent;
  const medianPrice = input.tetherMarket.summary.median;

  if (spread !== null && spread > input.settings.marketSpreadAlertThresholdPercent) {
    priceVariance.push({
      id: "spread",
      category: "priceVariance",
      assets: ["USDT", "IRT"],
      title: "اختلاف شدید قیمت تتر بین صرافی‌ها",
      severity: spread > input.settings.marketSpreadAlertThresholdPercent * 2 ? "high" : "medium",
      time,
      source: "محاسبه بازار",
      description: `اختلاف فعلی بازار ${spread.toFixed(2)}٪ است.`,
      impactOnDesk: "ممکن است قیمت‌گذاری OTC نیاز به حاشیه امن‌تر داشته باشد.",
      recommendedAction: "Spread و Max Order بازبینی شود.",
      details: {
        currentSpreadPercent: Number(spread.toFixed(4)),
        highestExchange: input.tetherMarket.summary.highestExchange,
        lowestExchange: input.tetherMarket.summary.lowestExchange
      }
    });
  }

  if (medianPrice && input.tetherMarket.summary.highest !== null) {
    const diff = ((input.tetherMarket.summary.highest - medianPrice) / medianPrice) * 100;
    if (diff > input.settings.marketSpreadAlertThresholdPercent) {
      priceVariance.push({
        id: "highest-vs-median",
        category: "priceVariance",
        assets: ["USDT", "IRT"],
        title: "فاصله بالاترین قیمت با Median",
        severity: diff > input.settings.marketSpreadAlertThresholdPercent * 2 ? "high" : "medium",
        time,
        source: input.tetherMarket.summary.highestExchange || "بازار تتر ایران",
        description: `${input.tetherMarket.summary.highestExchange || "یک منبع"} حدود ${diff.toFixed(2)}٪ بالاتر از Median است.`,
        impactOnDesk: "احتمال گران‌تر شدن اجرای خرید یا افزایش پرمیوم بازار وجود دارد.",
        recommendedAction: "Spread سمت فروش و سقف سفارش‌های بزرگ بررسی شود.",
        details: {
          median: medianPrice,
          highest: input.tetherMarket.summary.highest,
          diffPercent: Number(diff.toFixed(4)),
          exchangeName: input.tetherMarket.summary.highestExchange
        }
      });
    }
  }

  if (medianPrice && input.tetherMarket.summary.lowest !== null) {
    const diff = ((medianPrice - input.tetherMarket.summary.lowest) / medianPrice) * 100;
    if (diff > input.settings.marketSpreadAlertThresholdPercent) {
      priceVariance.push({
        id: "lowest-vs-median",
        category: "priceVariance",
        assets: ["USDT", "IRT"],
        title: "فاصله پایین‌ترین قیمت با Median",
        severity: diff > input.settings.marketSpreadAlertThresholdPercent * 2 ? "high" : "medium",
        time,
        source: input.tetherMarket.summary.lowestExchange || "بازار تتر ایران",
        description: `${input.tetherMarket.summary.lowestExchange || "یک منبع"} حدود ${diff.toFixed(2)}٪ پایین‌تر از Median است.`,
        impactOnDesk: "احتمال قیمت پرت یا فرصت/ریسک اجرای نامتوازن وجود دارد.",
        recommendedAction: "قبل از اتکا به قیمت پایین، سلامت منبع و عمق بازار بررسی شود.",
        details: {
          median: medianPrice,
          lowest: input.tetherMarket.summary.lowest,
          diffPercent: Number(diff.toFixed(4)),
          exchangeName: input.tetherMarket.summary.lowestExchange
        }
      });
    }
  }

  for (const e of input.tetherMarket.exchanges) {
    if (e.isOutlier) {
      priceVariance.push({
        id: `outlier-${e.exchangeId}`,
        category: "priceVariance",
        assets: ["USDT", "IRT"],
        title: `قیمت پرت در ${e.exchangeName}`,
        severity: "medium",
        time: e.lastUpdated ?? time,
        source: e.exchangeName,
        description: "اختلاف با Median بیش از حد تنظیم‌شده است.",
        impactOnDesk: "این قیمت نباید مبنای Median یا LP باشد.",
        recommendedAction: "منبع بررسی و موقتاً از تصمیم قیمت‌گذاری کنار گذاشته شود.",
        details: {
          deviationFromMedianPercent: e.deviationFromMedianPercent === null ? null : Number(e.deviationFromMedianPercent.toFixed(4))
        }
      });
    }
  }

  for (const e of input.tetherMarket.exchanges) {
    if (e.sourceStatus === "unavailable") {
      iranianLp.push({
        id: `lp-down-${e.exchangeId}`,
        category: "iranianLp",
        assets: ["USDT", "IRT"],
        title: `منبع ایرانی ${e.exchangeName} قطع است`,
        severity: "medium",
        time,
        source: e.exchangeName,
        description: e.errorMessage || "منبع در دسترس نیست",
        impactOnDesk: "پوشش قیمت LPهای ایرانی ناقص می‌شود.",
        recommendedAction: "تا برگشت منبع، وزن آن در Pricing و LP Selection کاهش یابد.",
        details: {
          currentStatus: e.sourceStatus
        }
      });
    }
  }

  for (const n of input.news.filter(isIranianLpNews).slice(0, 5)) {
    iranianLp.push({
      id: `lp-news-${n.id}`,
      category: "iranianLp",
      assets: n.assets.includes("IRT") ? n.assets : [...n.assets, "IRT"],
      title: n.title,
      severity: n.severity,
      time: n.publishedAt ?? now(),
      source: n.source,
      description: n.impactOnUsdtIrt,
      impactOnDesk: n.impactOnUsdtIrt,
      recommendedAction: n.recommendedAction
    });
  }

  const currentSources: SourceSnapshot = Object.fromEntries([
    ...input.tetherMarket.exchanges.map((e) => [
      `domestic:${e.exchangeId}`,
      { name: e.exchangeName, status: e.sourceStatus, lastSeen: e.lastUpdated ?? time }
    ] as const)
  ]);
  const connectivity = await syncConnectivityAlerts(currentSources);
  const lpAlerts = [...connectivity, ...iranianLp].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());
  const items = [...priceVariance.slice(0, 3), ...lpAlerts.slice(0, 2)].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return {
    priceVariance: priceVariance.sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime()),
    iranianLp: lpAlerts,
    items
  };
}

export async function intelligenceState(settings: Settings): Promise<IntelligenceState & { history?: IntelligenceReport[] }> {
  let history: IntelligenceReport[] = [];
  try {
    history = JSON.parse(await readFile(historyPath, "utf8")) as IntelligenceReport[];
  } catch {
    history = [];
  }
  return { enabled: Boolean(settings.openAiApiKey), message: settings.openAiApiKey ? "تاریخچه تحلیل‌ها" : "تحلیل هوشمند فعال نیست", latest: history[0] ?? null, history };
}

export async function getManualObservations(): Promise<ManualObservation[]> {
  try {
    const parsed = JSON.parse(await readFile(manualObservationsPath, "utf8")) as ManualObservation[];
    return Array.isArray(parsed) ? parsed.slice(0, 50) : [];
  } catch {
    return [];
  }
}

export async function addManualObservation(input: Partial<Pick<ManualObservation, "exchangeName" | "observedPrice" | "note">>) {
  const note = String(input.note ?? "").trim();
  const exchangeName = String(input.exchangeName ?? "").trim() || "مشاهده دستی";
  const observedPrice = typeof input.observedPrice === "number" && Number.isFinite(input.observedPrice) ? input.observedPrice : null;
  if (!note && observedPrice === null) {
    throw new Error("برای ثبت مشاهده، قیمت یا نوت لازم است");
  }
  const item: ManualObservation = {
    id: `manual-${Date.now()}`,
    createdAt: now(),
    exchangeName,
    observedPrice,
    note
  };
  const history = [item, ...(await getManualObservations())].slice(0, 50);
  await mkdir(dataDir, { recursive: true });
  await writeFile(manualObservationsPath, JSON.stringify(history, null, 2), "utf8");
  return item;
}

function buildDecisionCards(input: { tetherMarket: TetherMarketResponse; globalMarket: GlobalPrice[]; alertGroups: CategorizedAlerts; settings: Settings }): DecisionCard[] {
  const spread = input.tetherMarket.summary.marketSpreadPercent;
  const disconnected = input.tetherMarket.summary.unavailableSources;
  const highLpRisk = input.alertGroups.iranianLp.some((alert) => alert.severity === "high");
  const highVariance = input.alertGroups.priceVariance.some((alert) => alert.severity === "high");
  const usdt = input.globalMarket.find((item) => item.symbol === "USDT/USD");
  const depegRisk = usdt?.price !== null && usdt?.price !== undefined && Math.abs(usdt.price - 1) * 100 > input.settings.depegAlertThresholdPercent;

  return [
    {
      title: "Pricing",
      status: highVariance ? "risky" : spread !== null && spread > input.settings.marketSpreadAlertThresholdPercent ? "caution" : "calm",
      description:
        spread === null
          ? "داده کافی برای تصمیم قیمت‌گذاری دریافت نشد."
          : `اختلاف بازار ${spread.toFixed(2)}٪ است؛ بالاترین قیمت در ${input.tetherMarket.summary.highestExchange || "نامشخص"} و پایین‌ترین در ${input.tetherMarket.summary.lowestExchange || "نامشخص"}.`,
      action: highVariance ? "قیمت مرجع و وزن منابع پرت بازبینی شود." : "قیمت‌گذاری با Median فعلی قابل ادامه است."
    },
    {
      title: "Spread",
      status: highLpRisk || depegRisk ? "risky" : spread !== null && spread > input.settings.marketSpreadAlertThresholdPercent ? "caution" : "calm",
      description: highLpRisk || depegRisk ? "ریسک LP ایرانی یا Depeg می‌تواند روی Spread اثر بگذارد." : "ریسک LP یا Depeg مهمی در داده فعلی دیده نشد.",
      action: highLpRisk || depegRisk ? "Spread موقتاً بازتر و Max Order محدودتر شود." : "Spread فعلی فقط با تغییر variance بازبینی شود."
    },
    {
      title: "LP Selection",
      status: disconnected > 2 ? "risky" : disconnected > 0 ? "caution" : "calm",
      description: `${input.tetherMarket.summary.connectedSources} منبع متصل و ${disconnected} منبع قطع است.`,
      action: disconnected ? "LPهای قطع یا ناپایدار با وزن کمتر استفاده شوند." : "انتخاب LP از منابع متصل قابل انجام است."
    },
    {
      title: "Risk Limits",
      status: highLpRisk || highVariance || disconnected > 2 ? "risky" : input.alertGroups.items.length ? "caution" : "calm",
      description: `${input.alertGroups.items.length} هشدار خلاصه در cockpit فعال است.`,
      action: highLpRisk || highVariance ? "سقف سفارش‌های بزرگ تا پایدار شدن بازار کاهش یابد." : "Risk limit فعلی نیاز به تغییر فوری ندارد."
    }
  ];
}

export async function getTetherMarket() {
  const settings = await getSettings();
  return calculateTetherMarket(await getDomesticQuotes(settings), settings.outlierThresholdPercent);
}

export async function getExchangeMonitor() {
  const settings = await getSettings();
  const tether = calculateTetherMarket(await getDomesticQuotes(settings), settings.outlierThresholdPercent);
  return { domestic: tether.exchanges, global: await getGlobalExchangeStatuses(settings), tetherSummary: tether.summary };
}

export async function getDashboard() {
  const settings = await getSettings();
  const [quotes, globalMarket, globalStatuses, news] = await Promise.all([getDomesticQuotes(settings), getGlobalPrices(), getGlobalExchangeStatuses(settings), getImpactNews(settings)]);
  const tetherMarket = calculateTetherMarket(quotes, settings.outlierThresholdPercent);
  const alertGroups = await buildAlertGroups({ tetherMarket, globalMarket, globalStatuses, news: news.items, settings });
  const intelligence = await intelligenceState(settings);
  const allAlerts = [...alertGroups.priceVariance, ...alertGroups.iranianLp];
  const marketState: MarketState = allAlerts.some((a) => a.severity === "high") ? "risky" : allAlerts.some((a) => a.severity === "medium") ? "caution" : "calm";
  return { globalMarket, tetherMarket, marketState, intelligence, alerts: alertGroups.items, alertGroups, decisionCards: buildDecisionCards({ tetherMarket, globalMarket, alertGroups, settings }) };
}
