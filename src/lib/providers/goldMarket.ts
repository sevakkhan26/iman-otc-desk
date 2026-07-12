import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordGoldHistory } from "@/lib/goldHistory";
import {
  clampToNow,
  parseNavasanEpoch,
  parseTehranNaiveDateTime,
  toUtcIso
} from "@/lib/tehranTime";
import { BROWSER_UA, fetchJson, fetchPageWithCookies, fetchPostForm, fetchText, numeric } from "@/lib/http";
import type { DeskSettings, GoldInstrumentType, GoldMarketQuote, GoldMarketResponse, GoldPriceUnit, SourceStatus } from "@/lib/types";

const FRESH_TTL_MS = 3 * 60_000;
const STALE_TTL_MS = 30 * 60_000;
const MIN_FETCH_GAP_MS = 15_000;
const FETCH_TIMEOUT_MS = 15_000;
const NAVASAN_CSRF_PREFIX = "2bba8a6abdcae9571d63fefcd1df29bb3a8f5d91http://www.navasan.net/54tf%f";
const TALAVEST_GOLD_API = "http://et.tala.ir/webservice/westgold.app/6397dbw8222f0ffb85cd539f865g9994";

const dataDir = path.join(process.cwd(), ".data");
const cachePath = path.join(dataDir, "gold-market-source-cache.json");

type SourceId = "navasan" | "bonbast" | "talavest";
type NavasanRate = { value?: string | number; date?: number };
type NavasanRates = Record<string, NavasanRate>;
type SourceCacheEntry = { at: number; quotes: GoldMarketQuote[] };
type SourceCacheFile = Partial<Record<SourceId, SourceCacheEntry>>;

let memCache: GoldMarketResponse | null = null;
let memSourceCache: SourceCacheFile | null = null;
let inflight: Promise<GoldMarketResponse> | null = null;
let lastFetchAt = 0;

const nowIso = () => new Date().toISOString();

const SOURCE_LABELS: Record<SourceId, string> = {
  navasan: "نوسان",
  bonbast: "بن‌بست",
  talavest: "Talavest"
};

/** Navasan lastrates uses thousands for sekkeh and abshodeh; 18ayar is already in tomans. */
const NAVASAN_THOUSANDS_KEYS = new Set(["sekkeh", "abshodeh"]);

function navasanUpdatedAt(rate: NavasanRate | undefined): string | null {
  if (!rate?.date || !Number.isFinite(rate.date)) return null;
  const parsed = parseNavasanEpoch(rate.date);
  if (!parsed) return null;
  return clampToNow(toUtcIso(parsed));
}

function navasanValue(rate: NavasanRate | undefined): number | null {
  return numeric(rate?.value);
}

function normalizeNavasanToman(key: string, value: number | null): number | null {
  if (value === null) return null;
  return NAVASAN_THOUSANDS_KEYS.has(key) ? value * 1000 : value;
}

function quoteFromMid(
  sourceId: SourceId,
  sourceName: string,
  instrument: GoldInstrumentType,
  unit: GoldPriceUnit,
  midPrice: number | null,
  lastUpdated: string | null
): GoldMarketQuote | null {
  if (midPrice === null || !Number.isFinite(midPrice)) return null;
  return {
    sourceId,
    sourceName,
    instrument,
    unit,
    buyPrice: null,
    sellPrice: null,
    midPrice,
    lastUpdated: lastUpdated ?? nowIso(),
    status: "available"
  };
}

function quoteFromPrices(
  sourceId: SourceId,
  sourceName: string,
  instrument: GoldInstrumentType,
  unit: GoldPriceUnit,
  buyPrice: number | null,
  sellPrice: number | null,
  lastUpdated: string | null
): GoldMarketQuote | null {
  if (buyPrice === null && sellPrice === null) return null;
  const midPrice =
    buyPrice !== null && sellPrice !== null ? (buyPrice + sellPrice) / 2 : (buyPrice ?? sellPrice ?? null);
  return {
    sourceId,
    sourceName,
    instrument,
    unit,
    buyPrice,
    sellPrice,
    midPrice,
    lastUpdated: lastUpdated ?? nowIso(),
    status: "available"
  };
}

function latestTimestamp(values: Array<string | null>): string | null {
  const timestamps = values
    .map((value) => clampToNow(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  if (!timestamps.length) return null;
  return clampToNow(new Date(Math.max(...timestamps)).toISOString());
}

function aggregateStatus(quotes: GoldMarketQuote[]): SourceStatus {
  if (!quotes.length) return "unavailable";
  if (quotes.some((quote) => quote.status === "degraded")) return "degraded";
  return "available";
}

function quoteHasValidPrice(quote: GoldMarketQuote): boolean {
  return quote.midPrice !== null || quote.buyPrice !== null || quote.sellPrice !== null;
}

function parseNavasanRates(text: string): NavasanRates {
  const rates: NavasanRates = {};
  const lastMatch = text.match(/var\s+lastrates\s*=\s*(\{[\s\S]*?\});/);
  if (lastMatch) Object.assign(rates, JSON.parse(lastMatch[1]) as NavasanRates);

  const yesterdayMatch = text.match(/var\s+yesterday\s*=\s*(\{[\s\S]*?\});/);
  if (yesterdayMatch) {
    const yesterday = JSON.parse(yesterdayMatch[1]) as NavasanRates;
    for (const [key, entry] of Object.entries(yesterday)) {
      if (!rates[key]) rates[key] = entry;
    }
  }

  return rates;
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
      if (text.includes("lastrates") || text.includes("yesterday") || text.trim().startsWith("{")) {
        return text;
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("خطای نوسان");
    }
  }

  throw lastError ?? new Error("پاسخ معتبری از نوسان دریافت نشد");
}

function quotesFromNavasanRates(rates: NavasanRates, sourceId: SourceId, sourceName: string): GoldMarketQuote[] {
  const updatedAt = (keys: string[]) =>
    latestTimestamp(keys.map((key) => navasanUpdatedAt(rates[key])));

  const price = (key: string) => normalizeNavasanToman(key, navasanValue(rates[key]));

  const candidates: Array<GoldMarketQuote | null> = [
    quoteFromMid(sourceId, sourceName, "اونس طلا به دلار", "usd_oz", navasanValue(rates.usd_xau), updatedAt(["usd_xau"])),
    quoteFromMid(sourceId, sourceName, "یک گرم طلای 18 عیار", "toman", price("18ayar"), updatedAt(["18ayar"])),
    quoteFromMid(sourceId, sourceName, "سکه طرح امامی", "toman", price("sekkeh"), updatedAt(["sekkeh"])),
    quoteFromMid(sourceId, sourceName, "مثقال طلای آبشده", "toman", price("abshodeh"), updatedAt(["abshodeh"]))
  ];

  return candidates.filter((quote): quote is GoldMarketQuote => quote !== null);
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
    const parsed = parseTehranNaiveDateTime(modified);
    if (parsed) return clampToNow(toUtcIso(parsed));
  }
  const created = typeof payload.created === "string" ? payload.created.trim() : "";
  if (created) {
    const parsed = parseTehranNaiveDateTime(created);
    if (parsed) return clampToNow(toUtcIso(parsed));
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

function quotesFromBonbastPayload(
  payload: BonbastPayload,
  sourceId: SourceId,
  sourceName: string,
  updatedAt: string | null
): GoldMarketQuote[] {
  const candidates: Array<GoldMarketQuote | null> = [
    quoteFromMid(sourceId, sourceName, "اونس طلا به دلار", "usd_oz", bonbastPrice(payload.ounce), updatedAt),
    quoteFromMid(sourceId, sourceName, "یک گرم طلای 18 عیار", "toman", bonbastPrice(payload.gol18), updatedAt),
    quoteFromPrices(
      sourceId,
      sourceName,
      "سکه طرح امامی",
      "toman",
      bonbastPrice(payload.emami12),
      bonbastPrice(payload.emami1),
      updatedAt
    ),
    quoteFromMid(sourceId, sourceName, "مثقال طلای آبشده", "toman", bonbastPrice(payload.mithqal), updatedAt)
  ];

  return candidates.filter((quote): quote is GoldMarketQuote => quote !== null);
}

type TalavestTalaEntry = { value?: string | number; caption?: string; timestamp?: string };
type TalavestTalaPayload = {
  ounce?: TalavestTalaEntry;
  geram18?: TalavestTalaEntry;
  jad_buy?: TalavestTalaEntry;
  jad_sell?: TalavestTalaEntry;
  bazartehran?: TalavestTalaEntry;
  serverTime?: string;
  timestamp?: string | number;
};

function talavestEntryValue(entry: TalavestTalaEntry | undefined): number | null {
  return numeric(entry?.value);
}

function talavestRialToToman(value: number | null): number | null {
  if (value === null) return null;
  return value / 10;
}

function talavestUpdatedAt(payload: TalavestTalaPayload): string | null {
  const timestamp = Number(payload.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    const parsed = parseNavasanEpoch(timestamp);
    if (parsed) return clampToNow(toUtcIso(parsed));
  }
  const serverTime = typeof payload.serverTime === "string" ? payload.serverTime.trim() : "";
  if (serverTime) {
    const parsed = parseTehranNaiveDateTime(serverTime);
    if (parsed) return clampToNow(toUtcIso(parsed));
  }
  return null;
}

function quotesFromTalavestPayload(
  payload: TalavestTalaPayload,
  sourceId: SourceId,
  sourceName: string,
  updatedAt: string | null
): GoldMarketQuote[] {
  const candidates: Array<GoldMarketQuote | null> = [
    quoteFromMid(sourceId, sourceName, "اونس طلا به دلار", "usd_oz", talavestEntryValue(payload.ounce), updatedAt),
    quoteFromMid(
      sourceId,
      sourceName,
      "یک گرم طلای 18 عیار",
      "toman",
      talavestRialToToman(talavestEntryValue(payload.geram18)),
      updatedAt
    ),
    quoteFromPrices(
      sourceId,
      sourceName,
      "سکه طرح امامی",
      "toman",
      talavestRialToToman(talavestEntryValue(payload.jad_buy)),
      talavestRialToToman(talavestEntryValue(payload.jad_sell)),
      updatedAt
    ),
    quoteFromMid(
      sourceId,
      sourceName,
      "مثقال طلای آبشده",
      "toman",
      talavestRialToToman(talavestEntryValue(payload.bazartehran)),
      updatedAt
    )
  ];

  return candidates.filter((quote): quote is GoldMarketQuote => quote !== null);
}

async function fetchTalavest(): Promise<{ quotes: GoldMarketQuote[]; live: boolean }> {
  const sourceId = "talavest";
  const sourceName = SOURCE_LABELS[sourceId];
  const payload = await fetchJson<TalavestTalaPayload>(TALAVEST_GOLD_API, FETCH_TIMEOUT_MS, {
    headers: {
      accept: "application/json",
      referer: "https://talavest.com/"
    }
  });
  const updatedAt = talavestUpdatedAt(payload);
  const quotes = quotesFromTalavestPayload(payload, sourceId, sourceName, updatedAt);

  if (!quotes.length) {
    throw new Error("داده معتبری دریافت نشد");
  }
  return { quotes, live: true };
}

async function fetchBonbast(): Promise<{ quotes: GoldMarketQuote[]; live: boolean }> {
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
  const quotes = quotesFromBonbastPayload(payload, sourceId, sourceName, updatedAt);

  if (!quotes.length) {
    throw new Error("داده معتبری دریافت نشد");
  }
  return { quotes, live: true };
}

async function fetchNavasan(): Promise<{ quotes: GoldMarketQuote[]; live: boolean }> {
  const sourceId = "navasan";
  const sourceName = SOURCE_LABELS[sourceId];
  const { cookies: pageCookies, html } = await fetchPageWithCookies("https://www.navasan.net/", FETCH_TIMEOUT_MS);
  const sessionId = extractPhpSessionId(pageCookies) ?? extractPhpSessionId(html);

  let cookies = pageCookies;
  if (sessionId && !cookies.includes("PHPSESSID")) {
    cookies = mergeCookieHeader(cookies, `PHPSESSID=${sessionId}`);
  }

  const ratesText = await fetchNavasanRatesText(cookies, sessionId);
  const rates = parseNavasanRates(ratesText);
  const quotes = quotesFromNavasanRates(rates, sourceId, sourceName);

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

function validCachedQuotes(entry: SourceCacheEntry | undefined): GoldMarketQuote[] {
  if (!entry?.quotes.length) return [];
  if (Date.now() - entry.at >= STALE_TTL_MS) return [];
  return entry.quotes.filter(quoteHasValidPrice);
}

async function resolveSource(
  sourceId: SourceId,
  enabled: boolean,
  fetcher: () => Promise<{ quotes: GoldMarketQuote[]; live: boolean }>,
  sourceCache: SourceCacheFile
): Promise<{ quotes: GoldMarketQuote[]; notes: string[]; usedStale: boolean }> {
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
      return { quotes: cached, notes: [], usedStale: true };
    }
    return { quotes: [], notes: [], usedStale: false };
  }
}

async function fetchFresh(settings: DeskSettings): Promise<GoldMarketResponse> {
  const sourceCache = await readSourceCache();
  const notes: string[] = [];

  const [navasan, bonbast, talavest] = await Promise.all([
    resolveSource("navasan", settings.enabledSources.navasan !== false, fetchNavasan, sourceCache),
    resolveSource("bonbast", settings.enabledSources.bonbast !== false, fetchBonbast, sourceCache),
    resolveSource("talavest", settings.enabledSources.talavest !== false, fetchTalavest, sourceCache)
  ]);

  await writeSourceCache(sourceCache);

  const quotes = [...navasan.quotes, ...bonbast.quotes, ...talavest.quotes].filter(quoteHasValidPrice);
  const usedStale = navasan.usedStale || bonbast.usedStale || talavest.usedStale;

  if (!quotes.length) {
    if (settings.enabledSources.navasan !== false && !navasan.quotes.length) {
      notes.push("نوسان: در دسترس نیست");
    }
    if (settings.enabledSources.bonbast !== false && !bonbast.quotes.length) {
      notes.push("بن‌بست: در دسترس نیست");
    }
    if (settings.enabledSources.talavest !== false && !talavest.quotes.length) {
      notes.push("Talavest: در دسترس نیست");
    }
  } else if (usedStale) {
    notes.push("برخی قیمت‌های طلا از آخرین به‌روزرسانی موفق نمایش داده می‌شوند");
  }

  return {
    quotes,
    sourceStatus: aggregateStatus(quotes),
    lastUpdated: latestTimestamp(quotes.map((quote) => quote.lastUpdated)),
    notes: notes.length ? notes : undefined,
    stale: usedStale || undefined
  };
}

export async function getGoldMarketPrices(settings: DeskSettings): Promise<GoldMarketResponse> {
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
          void recordGoldHistory(fresh.quotes);
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