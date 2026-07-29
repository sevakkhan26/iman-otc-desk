import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest, toIntegerToman } from "@/lib/shadowArbitrage/adapters/base";
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";

const DEPTH = "https://api.wallex.ir/v1/depth?symbol=USDTTMN&limit=50";
const MARKETS = "https://api.wallex.ir/v1/markets";

/**
 * Wallex depth, market USDTTMN.
 * Verified 2026-07-29: HTTP 200; `result.ask` / `result.bid` are objects
 * `{price, quantity, sum}` with price in TOMAN and quantity in USDT.
 *
 * The markets ticker is kept only as a HEADLINE fallback — it exposes
 * `stats.bidPrice` / `stats.askPrice` and no sizes, so it can never be treated
 * as depth (no invented level amounts).
 */
export async function fetchWallexBook(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  const res = await shadowRequest<{
    result?: { bid?: unknown[]; ask?: unknown[]; bids?: unknown[]; asks?: unknown[] };
    success?: boolean;
  }>(DEPTH, { timeoutMs: cfg.timeoutMs, minSpacingMs: cfg.minRequestSpacingMs });

  const bidRaw = res.data.result?.bid ?? res.data.result?.bids ?? [];
  const askRaw = res.data.result?.ask ?? res.data.result?.asks ?? [];
  const bid = parseLevelsWithLoss(bidRaw, "toman");
  const ask = parseLevelsWithLoss(askRaw, "toman");

  if (bid.levels.length && ask.levels.length) {
    return {
      kind: "BOOK",
      bids: bid.levels,
      asks: ask.levels,
      bestBidToman: null,
      bestAskToman: null,
      maxUsdt: null,
      sourceTimestamp: null,
      priceUnit: "IRT",
      depthAvailable: true,
      directionVerified: true,
      endpoint: res.endpoint,
      httpStatus: res.httpStatus,
      latencyMs: res.latencyMs,
      attempts: res.attempts,
      rateLimited: res.rateLimited,
      normalizationNote: "قیمت تومانی؛ ask = خرید کاربر، bid = فروش کاربر؛ بدون timestamp صرافی",
      diagnostics: {
        endpoint: "v1/depth",
        bidLevels: bid.levels.length,
        askLevels: ask.levels.length,
        rejectedLevels: bid.rejected + ask.rejected
      }
    };
  }

  // Headline-only fallback: no sizes are published, so no depth is claimed.
  const tick = await shadowRequest<{
    result?: { symbols?: Record<string, { stats?: { bidPrice?: string; askPrice?: string } }> };
  }>(MARKETS, { timeoutMs: cfg.timeoutMs, minSpacingMs: cfg.minRequestSpacingMs });

  const st = tick.data.result?.symbols?.USDTTMN?.stats;
  const bestBid = toIntegerToman(st?.bidPrice);
  const bestAsk = toIntegerToman(st?.askPrice);
  if (bestBid === null || bestAsk === null) {
    throw new ProviderError("دفتر و تیکر والکس هر دو نامعتبر بودند");
  }

  return {
    kind: "HEADLINE",
    bids: [],
    asks: [],
    bestBidToman: bestBid,
    bestAskToman: bestAsk,
    maxUsdt: null,
    sourceTimestamp: null,
    priceUnit: "IRT",
    depthAvailable: false,
    directionVerified: true,
    endpoint: tick.endpoint,
    httpStatus: tick.httpStatus,
    latencyMs: res.latencyMs + tick.latencyMs,
    attempts: res.attempts + tick.attempts,
    rateLimited: res.rateLimited || tick.rateLimited,
    normalizationNote: "depth خالی بود؛ فقط بهترین bid/ask از markets — بدون عمق",
    degradedReason: "عمق دفتر والکس در این چرخه در دسترس نبود",
    diagnostics: { endpoint: "v1/markets", mode: "headline-only" }
  };
}
