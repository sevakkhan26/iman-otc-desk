import { fetchJson, outboundFetch, ProviderError } from "@/lib/http";
import {
  SHADOW_BACKOFF_BASE_MS,
  SHADOW_BACKOFF_MAX_MS,
  SHADOW_MAX_ATTEMPTS,
  SHADOW_RATE_LIMIT_BACKOFF_MS,
  SHADOW_STALE_MS,
  SHADOW_TRADE_SIZES,
  type ShadowSourceConfig
} from "@/lib/shadowArbitrage/config";
import { toIntegerToman } from "@/lib/shadowArbitrage/money";
import type {
  BlockedReasonCode,
  BookLevel,
  NormalizedSourceSnapshot,
  SizeExecutable,
  SourceResponseMeta
} from "@/lib/shadowArbitrage/types";
import { executableVwap, sumDepth } from "@/lib/shadowArbitrage/vwap";

export const SHADOW_UA = "TraderBot/OTCDesk-Shadow/1.0";

/**
 * What an adapter reports back. Three shapes, deliberately distinct:
 *  - BOOK      real multi-level order book we can walk for VWAP
 *  - HEADLINE  only a best bid/ask was available — NOT sizeable
 *  - OTC_QUOTE dealer quote with a published maximum quantity
 *
 * `depthAvailable` is never asserted from a headline price, and no adapter may
 * invent level sizes to make a quote look sizeable.
 */
export type AdapterKind = "BOOK" | "HEADLINE" | "OTC_QUOTE";

export type AdapterResult = {
  kind: AdapterKind;
  bids: BookLevel[];
  asks: BookLevel[];
  /** Best prices; for OTC_QUOTE these are the dealer's bid/ask quotes. */
  bestBidToman: number | null;
  bestAskToman: number | null;
  /** Published maximum executable quantity in USDT (OTC only). */
  maxUsdt: number | null;
  sourceTimestamp: string | null;
  priceUnit: "IRT" | "IRR" | "ambiguous";
  /** True only when a walkable multi-level book was parsed. */
  depthAvailable: boolean;
  /** False when the field→direction mapping could not be confirmed. */
  directionVerified: boolean;
  endpoint: string;
  httpStatus: number | null;
  latencyMs: number;
  attempts: number;
  rateLimited: boolean;
  /** Explains any inversion, filtering or inference applied. */
  normalizationNote: string | null;
  /** Extra reasons this source cannot back an executable claim. */
  blockedReasons?: BlockedReasonCode[];
  degradedReason?: string | null;
  diagnostics?: Record<string, unknown>;
};

/** Transport failure carrying everything certification needs to stay honest. */
export class ShadowSourceError extends Error {
  readonly httpStatus: number | null;
  readonly latencyMs: number;
  readonly attempts: number;
  readonly rateLimited: boolean;
  readonly timedOut: boolean;
  readonly endpoint: string;

  constructor(
    message: string,
    detail: {
      endpoint: string;
      httpStatus?: number | null;
      latencyMs?: number;
      attempts?: number;
      rateLimited?: boolean;
      timedOut?: boolean;
    }
  ) {
    super(message);
    this.name = "ShadowSourceError";
    this.endpoint = detail.endpoint;
    this.httpStatus = detail.httpStatus ?? null;
    this.latencyMs = detail.latencyMs ?? 0;
    this.attempts = detail.attempts ?? 1;
    this.rateLimited = detail.rateLimited ?? false;
    this.timedOut = detail.timedOut ?? false;
  }
}

export type ShadowResponse<T> = {
  data: T;
  endpoint: string;
  httpStatus: number | null;
  latencyMs: number;
  attempts: number;
  rateLimited: boolean;
};

/** Last request time per host, so we honour our own minimum spacing. */
const lastHostRequestAt = new Map<string, number>();

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Carries the real HTTP status so rate limiting can be reported honestly. */
class HttpStatusError extends ProviderError {
  readonly status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.name = "HttpStatusError";
    this.status = status;
  }
}

function statusFromError(error: unknown): number | null {
  if (error instanceof HttpStatusError) return error.status;
  const msg = error instanceof Error ? error.message : String(error);
  const m = /HTTP (\d{3})/.exec(msg);
  return m ? Number(m[1]) : null;
}

/**
 * One request attempt.
 *
 * The primary path is outboundFetch, which keeps the project's proxy rules and
 * — unlike fetchJson — exposes the real status code, so a 429 is reported as a
 * rate limit instead of being masked by fetchJson's resolved-IP retry. If the
 * transport itself fails (DNS poisoning, reset), we fall back to fetchJson to
 * inherit its DoH / fallback-IP hardening; a success there has no status to
 * report beyond "it worked".
 */
async function attemptOnce<T>(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>
): Promise<{ data: T; httpStatus: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await outboundFetch(url, {
      cache: "no-store",
      headers,
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new HttpStatusError(response.status);
    if (!text.trim()) throw new ProviderError("پاسخ خالی بود");
    try {
      return { data: JSON.parse(text) as T, httpStatus: response.status };
    } catch {
      throw new ProviderError("پاسخ JSON نامعتبر بود");
    }
  } catch (error) {
    if (error instanceof HttpStatusError || error instanceof ProviderError) throw error;
    // Transport-level failure — retry through the hardened client.
    const data = await fetchJson<T>(url, timeoutMs, { headers });
    return { data, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}

function isTimeout(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /timeout|تمام شد|AbortError|aborted/i.test(msg);
}

function backoffFor(attempt: number, rateLimited: boolean): number {
  const base = Math.min(SHADOW_BACKOFF_MAX_MS, SHADOW_BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return rateLimited ? base + SHADOW_RATE_LIMIT_BACKOFF_MS : base;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Public GET with per-source timeout, retry/backoff, rate-limit awareness and
 * latency/status capture. Read-only: no auth headers are ever attached.
 */
export async function shadowRequest<T>(
  url: string,
  opts: {
    timeoutMs: number;
    headers?: Record<string, string>;
    maxAttempts?: number;
    minSpacingMs?: number;
  }
): Promise<ShadowResponse<T>> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? SHADOW_MAX_ATTEMPTS);
  const host = hostOf(url);
  const started = Date.now();
  let attempts = 0;
  let sawRateLimit = false;
  let lastStatus: number | null = null;
  let lastError: unknown = new ProviderError("no attempt made");

  while (attempts < maxAttempts) {
    // Self-imposed spacing — we never hammer a public endpoint.
    const spacing = opts.minSpacingMs ?? 0;
    if (spacing > 0) {
      const prev = lastHostRequestAt.get(host);
      if (prev !== undefined) {
        const wait = spacing - (Date.now() - prev);
        if (wait > 0) await sleep(wait);
      }
    }
    lastHostRequestAt.set(host, Date.now());

    attempts += 1;
    const t0 = Date.now();
    try {
      const { data, httpStatus } = await attemptOnce<T>(url, opts.timeoutMs, {
        "user-agent": SHADOW_UA,
        accept: "application/json",
        ...opts.headers
      });
      return {
        data,
        endpoint: url,
        httpStatus: httpStatus ?? 200,
        latencyMs: Date.now() - t0,
        attempts,
        rateLimited: sawRateLimit
      };
    } catch (error) {
      lastError = error;
      lastStatus = statusFromError(error);
      const rateLimited = lastStatus === 429 || lastStatus === 418;
      if (rateLimited) sawRateLimit = true;

      // 4xx other than 429 will not change on retry.
      const permanent =
        lastStatus !== null && lastStatus >= 400 && lastStatus < 500 && !rateLimited;
      if (permanent || attempts >= maxAttempts) break;
      await sleep(backoffFor(attempts, rateLimited));
    }
  }

  throw new ShadowSourceError(lastError instanceof Error ? lastError.message : String(lastError), {
    endpoint: url,
    httpStatus: lastStatus,
    latencyMs: Date.now() - started,
    attempts,
    rateLimited: sawRateLimit,
    timedOut: isTimeout(lastError)
  });
}

/** Helper for call sites that only need the parsed body. */
export async function shadowFetchJson<T>(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>
): Promise<T> {
  const res = await shadowRequest<T>(url, { timeoutMs, headers });
  return res.data;
}

export function emptySizes(): SizeExecutable[] {
  return SHADOW_TRADE_SIZES.map((sizeUsdt) => ({
    sizeUsdt,
    userBuyVwapToman: null,
    userSellVwapToman: null,
    buyFillable: false,
    sellFillable: false,
    buyFilledUsdt: 0,
    sellFilledUsdt: 0
  }));
}

/**
 * Levels persisted with a snapshot: sorted the way they will be walked, with
 * unusable rows dropped and a hard cap so one venue's very deep book cannot
 * bloat every cached cycle. The cap is far beyond any size this desk can fund.
 */
export const MAX_PERSISTED_BOOK_LEVELS = 60;

export function cappedLevels(levels: BookLevel[], side: "buy" | "sell"): BookLevel[] {
  return [...levels]
    .filter((l) => Number.isFinite(l.priceToman) && Number.isFinite(l.amountUsdt))
    .filter((l) => l.priceToman > 0 && l.amountUsdt > 0)
    .sort((a, b) => (side === "buy" ? a.priceToman - b.priceToman : b.priceToman - a.priceToman))
    .slice(0, MAX_PERSISTED_BOOK_LEVELS);
}

export function sizesFromBook(bids: BookLevel[], asks: BookLevel[]): SizeExecutable[] {
  return SHADOW_TRADE_SIZES.map((sizeUsdt) => {
    const buy = executableVwap(asks, sizeUsdt, "buy");
    const sell = executableVwap(bids, sizeUsdt, "sell");
    return {
      sizeUsdt,
      userBuyVwapToman: buy.fillable ? buy.vwapToman : null,
      userSellVwapToman: sell.fillable ? sell.vwapToman : null,
      buyFillable: buy.fillable,
      sellFillable: sell.fillable,
      buyFilledUsdt: buy.filledUsdt,
      sellFilledUsdt: sell.filledUsdt
    };
  });
}

/**
 * OTC dealer quote: one price for any size up to the published maximum.
 * When the maximum is unknown we refuse to claim fillability.
 */
export function sizesFromQuote(
  userBuyToman: number,
  userSellToman: number,
  maxUsdt: number | null
): SizeExecutable[] {
  return SHADOW_TRADE_SIZES.map((sizeUsdt) => {
    const ok = maxUsdt !== null && sizeUsdt <= maxUsdt + 1e-9;
    return {
      sizeUsdt,
      userBuyVwapToman: ok ? userBuyToman : null,
      userSellVwapToman: ok ? userSellToman : null,
      buyFillable: ok,
      sellFillable: ok,
      buyFilledUsdt: ok ? sizeUsdt : 0,
      sellFilledUsdt: ok ? sizeUsdt : 0
    };
  });
}

function metaFrom(result: AdapterResult, directionVerified: boolean): SourceResponseMeta {
  return {
    endpoint: result.endpoint,
    httpStatus: result.httpStatus,
    latencyMs: result.latencyMs,
    attempts: result.attempts,
    rateLimited: result.rateLimited,
    timedOut: false,
    depthAvailable: result.depthAvailable,
    directionVerified,
    priceUnit: result.priceUnit,
    normalizationNote: result.normalizationNote
  };
}

/**
 * Normalize any adapter result into a snapshot.
 * Health and blocked reasons are derived from what was actually proven:
 * a headline price never yields fillable sizes, and a crossed or
 * unresolvable book never yields a verified direction.
 */
/**
 * Prove which array is which side of the book, instead of trusting the names.
 *
 * A real order book never crosses: every buy offer sits below every sell offer.
 * So given two candidate arrays, at most one assignment can be uncrossed, and
 * when exactly one is, the mapping is *proved* rather than inferred — a venue
 * that swaps its field names cannot fool it, and a venue that changes its
 * convention later fails the check instead of silently inverting the market.
 *
 * Returns `verified: false` when the evidence is ambiguous (both readings cross,
 * or both are uncrossed because the two clusters overlap), which keeps the
 * source degraded rather than guessing.
 */
export function proveBookDirection(
  candidateBids: BookLevel[],
  candidateAsks: BookLevel[]
): { verified: boolean; crossedUnderStated: boolean; reason: string } {
  if (!candidateBids.length || !candidateAsks.length) {
    return { verified: false, crossedUnderStated: false, reason: "یکی از دو سمت دفتر خالی است" };
  }
  const bestBid = Math.max(...candidateBids.map((l) => l.priceToman));
  const bestAsk = Math.min(...candidateAsks.map((l) => l.priceToman));
  // The mirror reading: what the book would look like with the arrays swapped.
  const mirrorBestBid = Math.max(...candidateAsks.map((l) => l.priceToman));
  const mirrorBestAsk = Math.min(...candidateBids.map((l) => l.priceToman));

  const uncrossed = bestBid < bestAsk;
  const mirrorUncrossed = mirrorBestBid < mirrorBestAsk;

  if (uncrossed && !mirrorUncrossed) {
    return {
      verified: true,
      crossedUnderStated: false,
      reason: `جهت اثبات شد: بهترین خرید ${bestBid} < بهترین فروش ${bestAsk}، و خواندن معکوس متقاطع می‌شود`
    };
  }
  if (!uncrossed && mirrorUncrossed) {
    return {
      verified: false,
      crossedUnderStated: true,
      reason: `این نگاشت متقاطع است (${bestBid} ≥ ${bestAsk})؛ خواندن معکوس سازگار است`
    };
  }
  return {
    verified: false,
    crossedUnderStated: !uncrossed,
    reason: "هر دو خوانش مبهم‌اند — جهت اثبات نشد"
  };
}

export function snapshotFromResult(
  cfg: ShadowSourceConfig,
  result: AdapterResult,
  receivedAt: string
): NormalizedSourceSnapshot {
  const blocked = new Set<BlockedReasonCode>(result.blockedReasons ?? []);
  const notes: string[] = [];
  if (result.degradedReason) notes.push(result.degradedReason);

  const bestBid =
    result.bestBidToman ??
    (result.bids.length ? Math.max(...result.bids.map((l) => l.priceToman)) : null);
  const bestAsk =
    result.bestAskToman ??
    (result.asks.length ? Math.min(...result.asks.map((l) => l.priceToman)) : null);

  // Direction: never silently swap a crossed book.
  let directionVerified = result.directionVerified;
  if (bestBid !== null && bestAsk !== null && bestBid > bestAsk) {
    directionVerified = false;
    notes.push(`دفتر متقاطع: bid=${bestBid} > ask=${bestAsk} — جهت تأیید نشد`);
  }
  if (!directionVerified) blocked.add("quote_direction_unverified");

  if (result.priceUnit === "ambiguous") {
    blocked.add("units_ambiguous");
    notes.push("واحد قیمت (ریال/تومان) قطعی نشد");
  }
  if (result.rateLimited) {
    blocked.add("rate_limited");
    notes.push("پاسخ محدودیت نرخ در این چرخه دریافت شد");
  }

  const walkable = result.kind === "BOOK" && result.depthAvailable;

  let sizes: SizeExecutable[];
  if (result.kind === "BOOK" && result.depthAvailable) {
    sizes = sizesFromBook(result.bids, result.asks);
  } else if (result.kind === "OTC_QUOTE" && bestAsk !== null && bestBid !== null) {
    sizes = sizesFromQuote(bestAsk, bestBid, result.maxUsdt);
    if (result.maxUsdt === null) {
      blocked.add("quote_max_unverified");
      notes.push("حد اجرای منتشرشده‌ای برای این نقل‌قول یافت نشد");
    }
  } else {
    // HEADLINE, or a book we could not walk — no sizing claim is made.
    sizes = emptySizes();
    blocked.add("depth_unverified");
    notes.push("فقط قیمت سرصفحه در دسترس بود — عمق برای حجم درخواستی تأیید نشد");
  }

  const hasPrices = bestBid !== null && bestAsk !== null;
  const sourceMs = result.sourceTimestamp ? Date.parse(result.sourceTimestamp) : NaN;
  const ageMs = Number.isFinite(sourceMs) ? Math.max(0, Date.parse(receivedAt) - sourceMs) : 0;
  const stale = ageMs > SHADOW_STALE_MS;
  if (stale) notes.push(`دادهٔ منبع ${Math.round(ageMs / 1000)} ثانیه قدیمی است`);

  const depthBid = result.depthAvailable ? sumDepth(result.bids) : null;
  const depthAsk = result.depthAvailable ? sumDepth(result.asks) : null;
  const maxExecutable =
    result.kind === "OTC_QUOTE"
      ? result.maxUsdt
      : depthBid !== null && depthAsk !== null
        ? Math.min(depthBid, depthAsk)
        : null;

  const health: NormalizedSourceSnapshot["health"] = !hasPrices
    ? "unavailable"
    : blocked.size > 0 || stale
      ? "degraded"
      : "healthy";

  return {
    sourceId: cfg.id,
    sourceName: cfg.nameFa,
    marketModel: cfg.marketModel,
    accountStatus: cfg.accountStatus,
    eligibilityBase: cfg.eligibilityBase,
    bestBidToman: bestBid,
    bestAskToman: bestAsk,
    userBuyPriceToman: bestAsk,
    userSellPriceToman: bestBid,
    sizeExecutables: sizes,
    // The walkable book, capped and canonically ordered. Only a real book is
    // carried: an OTC quote has no levels to walk and must not pretend to.
    bookBids: walkable ? cappedLevels(result.bids, "sell") : null,
    bookAsks: walkable ? cappedLevels(result.asks, "buy") : null,
    depthUsdtBid: depthBid,
    depthUsdtAsk: depthAsk,
    maxExecutableUsdt: maxExecutable,
    marketFeeBps: cfg.feeBps,
    feeStatus: cfg.feeStatus,
    feeLabel: cfg.feeLabel,
    feeReferenceUrl: cfg.feeReferenceUrl,
    feeVerifiedAt: cfg.feeVerifiedAt,
    sourceTimestamp: result.sourceTimestamp,
    receivedAt,
    ageMs,
    health,
    errorReason: hasPrices ? null : "قیمت خرید/فروش قابل استخراج نبود",
    degradedReason: notes.length ? notes.join(" · ") : null,
    stale,
    meta: metaFrom(result, directionVerified),
    sourceBlockedReasons: [...blocked],
    diagnostics: result.diagnostics
  };
}

export function unavailableSnapshot(
  cfg: ShadowSourceConfig,
  receivedAt: string,
  message: string,
  meta?: Partial<SourceResponseMeta>
): NormalizedSourceSnapshot {
  const blocked: BlockedReasonCode[] = ["source_unhealthy", "market_data_missing"];
  if (meta?.rateLimited) blocked.push("rate_limited");
  return {
    sourceId: cfg.id,
    sourceName: cfg.nameFa,
    marketModel: cfg.marketModel,
    accountStatus: cfg.accountStatus,
    eligibilityBase: cfg.eligibilityBase,
    bestBidToman: null,
    bestAskToman: null,
    userBuyPriceToman: null,
    userSellPriceToman: null,
    sizeExecutables: emptySizes(),
    bookBids: null,
    bookAsks: null,
    depthUsdtBid: null,
    depthUsdtAsk: null,
    maxExecutableUsdt: null,
    marketFeeBps: cfg.feeBps,
    feeStatus: cfg.feeStatus,
    feeLabel: cfg.feeLabel,
    feeReferenceUrl: cfg.feeReferenceUrl,
    feeVerifiedAt: cfg.feeVerifiedAt,
    sourceTimestamp: null,
    receivedAt,
    ageMs: 0,
    health: "unavailable",
    errorReason: message,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: meta?.endpoint ?? null,
      httpStatus: meta?.httpStatus ?? null,
      latencyMs: meta?.latencyMs ?? null,
      attempts: meta?.attempts ?? 0,
      rateLimited: meta?.rateLimited ?? false,
      timedOut: meta?.timedOut ?? false,
      depthAvailable: false,
      directionVerified: false,
      priceUnit: meta?.priceUnit ?? "ambiguous",
      normalizationNote: meta?.normalizationNote ?? null
    },
    sourceBlockedReasons: blocked
  };
}

/** Reject a top of book that is outside the plausible USDT/IRT band. */
export function assertBidAsk(bid: number | null, ask: number | null): void {
  if (bid === null && ask === null) throw new ProviderError("قیمت خرید/فروش موجود نیست");
  const ref = bid ?? ask;
  if (ref !== null && toIntegerToman(ref) === null) {
    throw new ProviderError("قیمت خارج از بازه معقول");
  }
}

export { toIntegerToman, ProviderError };
