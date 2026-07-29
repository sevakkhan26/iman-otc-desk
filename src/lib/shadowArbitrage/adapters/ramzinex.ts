import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest, toIntegerToman } from "@/lib/shadowArbitrage/adapters/base";
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";

/** USDT/IRR pair id on Ramzinex. */
const PAIR = 11;
const BOOK = `https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/orderbooks/${PAIR}/buys_sells`;
const PAIR_INFO = `https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/pairs/${PAIR}`;

/**
 * Ramzinex public order book, pair 11 (USDT/IRR).
 * Verified 2026-07-29: `/orderbooks/11` returns HTTP 404; the working public
 * path is `/orderbooks/11/buys_sells`, which returns
 * `data.buys` / `data.sells` as tuples
 * `[price, amount, total, boolean, null, orderCount, epochMs]`
 * with price in RIAL (1935401 = 193,540 toman) and amount in USDT.
 *
 * The tuple's trailing epoch is a per-order placement time, not a book
 * snapshot time, so it is recorded as a diagnostic and NOT used as the
 * exchange timestamp for staleness.
 */
export async function fetchRamzinexBook(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  const res = await shadowRequest<{
    data?: { buys?: unknown[]; sells?: unknown[]; bids?: unknown[]; asks?: unknown[] };
  }>(BOOK, { timeoutMs: cfg.timeoutMs, minSpacingMs: cfg.minRequestSpacingMs });

  const book = res.data.data ?? {};
  const bid = parseLevelsWithLoss(book.buys ?? book.bids ?? [], "rial");
  const ask = parseLevelsWithLoss(book.sells ?? book.asks ?? [], "rial");

  if (bid.levels.length && ask.levels.length) {
    return {
      kind: "BOOK",
      bids: bid.levels,
      asks: ask.levels,
      bestBidToman: null,
      bestAskToman: null,
      maxUsdt: null,
      sourceTimestamp: null,
      priceUnit: "IRR",
      depthAvailable: true,
      directionVerified: true,
      endpoint: res.endpoint,
      httpStatus: res.httpStatus,
      latencyMs: res.latencyMs,
      attempts: res.attempts,
      rateLimited: res.rateLimited,
      normalizationNote:
        "buys = فروش کاربر، sells = خرید کاربر؛ قیمت ریالی ÷ ۱۰؛ timestamp سطح‌ها زمان ثبت سفارش است نه زمان snapshot",
      diagnostics: {
        endpoint: "orderbooks/11/buys_sells",
        bidLevels: bid.levels.length,
        askLevels: ask.levels.length,
        rejectedLevels: bid.rejected + ask.rejected
      }
    };
  }

  // Headline-only fallback: pair info publishes top of book without sizes.
  const info = await shadowRequest<{ data?: { buy?: unknown; sell?: unknown } }>(PAIR_INFO, {
    timeoutMs: cfg.timeoutMs,
    minSpacingMs: cfg.minRequestSpacingMs
  });
  const bestBid = toIntegerToman(info.data.data?.buy, "rial");
  const bestAsk = toIntegerToman(info.data.data?.sell, "rial");
  if (bestBid === null || bestAsk === null) {
    throw new ProviderError("رمزینکس: دفتر و اطلاعات جفت‌ارز هر دو نامعتبر بودند");
  }

  return {
    kind: "HEADLINE",
    bids: [],
    asks: [],
    bestBidToman: bestBid,
    bestAskToman: bestAsk,
    maxUsdt: null,
    sourceTimestamp: null,
    priceUnit: "IRR",
    depthAvailable: false,
    directionVerified: true,
    endpoint: info.endpoint,
    httpStatus: info.httpStatus,
    latencyMs: res.latencyMs + info.latencyMs,
    attempts: res.attempts + info.attempts,
    rateLimited: res.rateLimited || info.rateLimited,
    normalizationNote: "دفتر خالی بود؛ فقط بهترین buy/sell از pairs — بدون عمق",
    degradedReason: "عمق دفتر رمزینکس در این چرخه در دسترس نبود",
    diagnostics: { endpoint: "pairs/11", mode: "headline-only" }
  };
}
