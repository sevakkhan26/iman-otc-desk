import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BROWSER_UA, fetchPageWithCookies, fetchPostForm, fetchText, numeric } from "@/lib/http";
import type { DeskSettings, FxStreetAssetType, FxStreetQuote, FxStreetResponse, SourceStatus } from "@/lib/types";

const FRESH_TTL_MS = 3 * 60_000;
const STALE_TTL_MS = 30 * 60_000;
const MIN_FETCH_GAP_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;

const NAVASAN_CSRF_PREFIX = "2bba8a6abdcae9571d63fefcd1df29bb3a8f5d91http://www.navasan.net/54tf%f";

const dataDir = path.join(process.cwd(), ".data");
const cachePath = path.join(dataDir, "fx-street-source-cache.json");

type SourceId = "navasan" | "bonbast";
type NavasanRate = { value?: string | number; date?: number };
type NavasanRates = Record<string, NavasanRate>;
type SourceResult = { quotes: FxStreetQuote[]; live: boolean };
type SourceCacheEntry = { at: number; quotes: FxStreetQuote[] };
type SourceCacheFile = Partial<Record<SourceId, SourceCacheEntry>>;

let memCache: FxStreetResponse | null = null;
let memSourceCache: SourceCacheFile | null = null;
let inflight: Promise<FxStreetResponse> | null = null;
let lastFetchAt = 0;

const nowIso = () => new Date().toISOString();

const SOURCE_LABELS: Record<SourceId, string> = {
  navasan: "نوسان",
  bonbast: "بن‌بست"
};

function mid(buyPrice: number | null, sellPrice: number | null): number | null {
  if (buyPrice !== null && sellPrice !== null) return (buyPrice + sellPrice) / 2;
  return buyPrice ?? sellPrice ?? null;
}

function hasValidPrice(buyPrice: number | null, sellPrice: number | null): boolean {
  return buyPrice !== null || sellPrice !== null;
}

function quoteHasValidPrice(quote: FxStreetQuote): boolean {
  return hasValidPrice(quote.buyPrice, quote.sellPrice);
}

function quoteFromPrices(
  sourceId: SourceId,
  sourceName: string,
  assetType: FxStreetAssetType,
  buyPrice: number | null,
  sellPrice: number | null,
  options?: { lastUpdated?: string | null; status?: SourceStatus }
): FxStreetQuote | null {
  if (!hasValidPrice(buyPrice, sellPrice)) return null;
  return {
    sourceId,
    sourceName,
    assetType,
    buyPrice,
    sellPrice,
    midPrice: mid(buyPrice, sellPrice),
    lastUpdated: options?.lastUpdated ?? nowIso(),
    status: options?.status ?? "available"
  };
}

function latestTimestamp(values: Array<string | null>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function aggregateStatus(quotes: FxStreetQuote[]): SourceStatus {
  if (!quotes.length) return "unavailable";
  if (quotes.some((quote) => quote.status === "degraded")) return "degraded";
  return "available";
}

function parseNavasanRates(text: string): NavasanRates {
  const match = text.match(/var\s+lastrates\s*=\s*(\{[\s\S]*?\});/);
  if (!match) {
    throw new Error("داده نرخ نوسان در پاسخ پیدا نشد");
  }
  return JSON.parse(match[1]) as NavasanRates;
}

function navasanUpdatedAt(rate: NavasanRate | undefined): string | null {
  if (!rate?.date || !Number.isFinite(rate.date)) return null;
  return new Date(rate.date).toISOString();
}

function navasanValue(rate: NavasanRate | undefined): number | null {
  return numeric(rate?.value);
}

function extractPhpSessionId(cookies: string): string | null {
  const match = cookies.match(/(?:^|;\s*)PHPSESSID=([^;]+)/i);
  return match?.[1]?.trim() || null;
}

function navasanCsrfToken(sessionId: string): string {
  return Buffer.from(`${NAVASAN_CSRF_PREFIX}${sessionId}`, "utf8").toString("base64");
}

function mergeCookieHeader(existing: string, extra: string): string {
  const jar = new Map<string, string>();
  for (const part of `${existing};${extra}`.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    jar.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
  }
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function quotesFromNavasanRates(rates: NavasanRates, sourceId: SourceId, sourceName: string): FxStreetQuote[] {
  return [
    quoteFromPrices(
      sourceId,
      sourceName,
      "دلار کاغذی",
      navasanValue(rates.harat_naghdi_sell),
      navasanValue(rates.harat_naghdi_buy),
      { lastUpdated: navasanUpdatedAt(rates.harat_naghdi_sell) ?? navasanUpdatedAt(rates.harat_naghdi_buy) }
    ),
    quoteFromPrices(
      sourceId,
      sourceName,
      "دلار فردایی",
      navasanValue(rates.usd_farda_sell),
      navasanValue(rates.usd_farda_buy),
      { lastUpdated: navasanUpdatedAt(rates.usd_farda_sell) ?? navasanUpdatedAt(rates.usd_farda_buy) }
    ),
    quoteFromPrices(
      sourceId,
      sourceName,
      "دلار سبزه میدان",
      navasanValue(rates.usd_sell),
      navasanValue(rates.usd_buy),
      { lastUpdated: navasanUpdatedAt(rates.usd_sell) ?? navasanUpdatedAt(rates.usd_buy) }
    ),
    quoteFromPrices(
      sourceId,
      sourceName,
      "درهم امارات",
      navasanValue(rates.aed_sell) ?? navasanValue(rates.dirham_dubai),
      navasanValue(rates.aed_buy),
      {
        lastUpdated: navasanUpdatedAt(rates.aed_sell) ?? navasanUpdatedAt(rates.dirham_dubai) ?? navasanUpdatedAt(rates.aed_buy),
        status: navasanValue(rates.aed_buy) === null ? "degraded" : "available"
      }
    )
  ].filter((quote): quote is FxStreetQuote => quote !== null);
}

async function fetchNavasanRatesText(cookies: string, sessionId: string | null): Promise<string> {
  const commonHeaders = {
    "user-agent": BROWSER_UA,
    accept: "text/javascript, application/javascript, application/json, text/html, */*;q=0.8",
    referer: "https://www.navasan.net/",
    "accept-language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
    "x-requested-with": "XMLHttpRequest",
    cookie: cookies
  };

  const attempts = [
    `https://www.navasan.net/initrates.php?_=${Date.now()}`,
    sessionId
      ? `https://www.navasan.net/initrates.php?csrf=${encodeURIComponent(navasanCsrfToken(sessionId))}&_=${Date.now()}`
      : null,
    sessionId
      ? `https://www.navasan.net/last_currencies.php?csrf=${encodeURIComponent(navasanCsrfToken(sessionId))}&_=${Date.now()}`
      : null
  ].filter((url): url is string => Boolean(url));

  let lastError: Error | null = null;
  for (const url of attempts) {
    try {
      const text = await fetchText(url, FETCH_TIMEOUT_MS, { headers: commonHeaders });
      if (text.includes("lastrates") || text.trim().startsWith("{")) {
        return text;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("خطای نوسان");
    }
  }

  throw lastError ?? new Error("پاسخ معتبری از نوسان دریافت نشد");
}

function quotesFromNavasanPayload(text: string, sourceId: SourceId, sourceName: string): FxStreetQuote[] {
  if (text.includes("lastrates")) {
    return quotesFromNavasanRates(parseNavasanRates(text), sourceId, sourceName);
  }

  const json = JSON.parse(text) as Record<string, { value?: string | number; date?: number }>;
  const rates: NavasanRates = {};
  for (const [key, entry] of Object.entries(json)) {
    rates[key] = entry;
  }

  const mapped = quotesFromNavasanRates(rates, sourceId, sourceName);
  if (mapped.length) return mapped;

  const usd = navasanValue(json.usd);
  const aed = navasanValue(json.aed);
  const fallback: FxStreetQuote[] = [];
  const usdQuote = quoteFromPrices(sourceId, sourceName, "دلار سبزه میدان", usd, usd, {
    lastUpdated: navasanUpdatedAt(json.usd),
    status: "degraded"
  });
  if (usdQuote) fallback.push(usdQuote);
  const aedQuote = quoteFromPrices(sourceId, sourceName, "درهم امارات", aed, aed, {
    lastUpdated: navasanUpdatedAt(json.aed),
    status: "degraded"
  });
  if (aedQuote) fallback.push(aedQuote);
  return fallback;
}

async function fetchNavasan(): Promise<SourceResult> {
  const sourceId = "navasan";
  const sourceName = SOURCE_LABELS[sourceId];
  const { cookies: pageCookies, html } = await fetchPageWithCookies("https://www.navasan.net/", FETCH_TIMEOUT_MS);
  const sessionId = extractPhpSessionId(pageCookies) ?? extractPhpSessionId(html);

  let cookies = pageCookies;
  if (sessionId && !cookies.includes("PHPSESSID")) {
    cookies = mergeCookieHeader(cookies, `PHPSESSID=${sessionId}`);
  }

  const ratesText = await fetchNavasanRatesText(cookies, sessionId);
  const quotes = quotesFromNavasanPayload(ratesText, sourceId, sourceName);

  if (!quotes.length) {
    throw new Error("داده معتبری دریافت نشد");
  }
  return { quotes, live: true };
}

type BonbastPayload = Record<string, string | number | undefined> & {
  rest?: string;
  last_modified?: string;
  created?: string;
};

function bonbastPrice(value: unknown): number | null {
  return numeric(typeof value === "string" || typeof value === "number" ? value : null);
}

function bonbastUpdatedAt(payload: BonbastPayload): string | null {
  const modified = typeof payload.last_modified === "string" ? payload.last_modified.trim() : "";
  if (modified) {
    const parsed = new Date(modified);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  const created = typeof payload.created === "string" ? payload.created.trim() : "";
  if (created) {
    const parsed = new Date(created);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return null;
}

function extractBonbastParam(html: string): string | null {
  const patterns = [/param:\s*"([^"]+)"/, /param\s*=\s*"([^"]+)"/, /"param"\s*:\s*"([^"]+)"/];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

async function fetchBonbast(): Promise<SourceResult> {
  const sourceId = "bonbast";
  const sourceName = SOURCE_LABELS[sourceId];
  const { html, cookies } = await fetchPageWithCookies("https://bonbast.com/", FETCH_TIMEOUT_MS);
  const param = extractBonbastParam(html);
  if (!param) {
    throw new Error("کلید درخواست در صفحه پیدا نشد");
  }

  const payload = await fetchPostForm<BonbastPayload>(
    "https://bonbast.com/json",
    { param },
    FETCH_TIMEOUT_MS,
    {
      headers: {
        cookie: cookies,
        referer: "https://bonbast.com/",
        "x-requested-with": "XMLHttpRequest",
        accept: "application/json, text/plain, */*;q=0.8"
      }
    }
  );

  if (payload.rest) {
    throw new Error("محدودیت نرخ؛ بعداً دوباره تلاش کنید");
  }

  const updatedAt = bonbastUpdatedAt(payload);
  // Bonbast's "USD / US Dollar" row: usd1 = Sell column, usd2 = Buy column.
  // This is Bonbast's own USD quote — a separate instrument from کاغذی/فردایی/سبزه میدان.
  const quotes = [
    quoteFromPrices(sourceId, sourceName, "دلار بن‌بست", bonbastPrice(payload.usd2), bonbastPrice(payload.usd1), {
      lastUpdated: updatedAt
    }),
    quoteFromPrices(sourceId, sourceName, "درهم امارات", bonbastPrice(payload.aed1), bonbastPrice(payload.aed2), {
      lastUpdated: updatedAt
    })
  ].filter((quote): quote is FxStreetQuote => quote !== null);

  if (!quotes.length) {
    throw new Error("داده معتبری دریافت نشد");
  }
  return { quotes, live: true };
}

async function readSourceCache(): Promise<SourceCacheFile> {
  if (memSourceCache) return memSourceCache;
  try {
    const raw = await readFile(cachePath, "utf8");
    memSourceCache = JSON.parse(raw) as SourceCacheFile;
    return memSourceCache;
  } catch {
    memSourceCache = {};
    return memSourceCache;
  }
}

async function writeSourceCache(cache: SourceCacheFile): Promise<void> {
  memSourceCache = cache;
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(cache), "utf8");
  } catch {
    // best-effort
  }
}

function validCachedQuotes(entry: SourceCacheEntry | undefined): FxStreetQuote[] {
  if (!entry?.quotes.length) return [];
  if (Date.now() - entry.at >= STALE_TTL_MS) return [];
  return entry.quotes.filter(quoteHasValidPrice);
}

async function resolveSource(
  sourceId: SourceId,
  enabled: boolean,
  fetcher: () => Promise<SourceResult>,
  sourceCache: SourceCacheFile
): Promise<{ quotes: FxStreetQuote[]; notes: string[]; usedStale: boolean }> {
  if (!enabled) {
    return { quotes: [], notes: [], usedStale: false };
  }

  try {
    const live = await fetcher();
    if (live.quotes.some(quoteHasValidPrice)) {
      sourceCache[sourceId] = { at: Date.now(), quotes: live.quotes.filter(quoteHasValidPrice) };
      return { quotes: live.quotes, notes: [], usedStale: false };
    }
    throw new Error("داده معتبری دریافت نشد");
  } catch {
    const cached = validCachedQuotes(sourceCache[sourceId]);
    if (cached.length) {
      return {
        quotes: cached,
        notes: [],
        usedStale: true
      };
    }
    return { quotes: [], notes: [], usedStale: false };
  }
}

async function fetchFresh(settings: DeskSettings): Promise<FxStreetResponse> {
  const sourceCache = await readSourceCache();
  const notes: string[] = [];
  let usedStale = false;

  const [navasan, bonbast] = await Promise.all([
    resolveSource("navasan", settings.enabledSources.navasan !== false, fetchNavasan, sourceCache),
    resolveSource("bonbast", settings.enabledSources.bonbast !== false, fetchBonbast, sourceCache)
  ]);

  await writeSourceCache(sourceCache);

  const quotes = [...navasan.quotes, ...bonbast.quotes].filter(quoteHasValidPrice);
  usedStale = navasan.usedStale || bonbast.usedStale;

  if (!quotes.length) {
    if (settings.enabledSources.navasan !== false && !navasan.quotes.length) {
      notes.push("نوسان: در دسترس نیست");
    }
    if (settings.enabledSources.bonbast !== false && !bonbast.quotes.length) {
      notes.push("بن‌بست: در دسترس نیست");
    }
  } else if (usedStale) {
    notes.push("برخی قیمت‌ها از آخرین به‌روزرسانی موفق نمایش داده می‌شوند");
  }

  return {
    quotes,
    sourceStatus: aggregateStatus(quotes),
    lastUpdated: latestTimestamp(quotes.map((quote) => quote.lastUpdated)),
    notes: notes.length ? notes : undefined,
    stale: usedStale || undefined
  };
}

export async function getFxStreetPrices(settings: DeskSettings): Promise<FxStreetResponse> {
  if (memCache && Date.now() - lastFetchAt < FRESH_TTL_MS && memCache.quotes.some(quoteHasValidPrice)) {
    return memCache;
  }

  if (Date.now() - lastFetchAt < MIN_FETCH_GAP_MS && memCache?.quotes.some(quoteHasValidPrice)) {
    return memCache;
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        lastFetchAt = Date.now();
        const fresh = await fetchFresh(settings);
        if (fresh.quotes.some(quoteHasValidPrice)) {
          memCache = fresh;
          return fresh;
        }

        if (memCache?.quotes.some(quoteHasValidPrice)) {
          return {
            ...memCache,
            sourceStatus: "degraded",
            stale: true,
            notes: fresh.notes ?? memCache.notes
          };
        }

        memCache = fresh;
        return fresh;
      } finally {
        inflight = null;
      }
    })();
  }

  return inflight;
}