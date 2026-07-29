import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest } from "@/lib/shadowArbitrage/adapters/base";
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";

const ENDPOINT = "https://api-v2.arzinja.ir/api/v1/trade/p2p/orderbook?pair=USDTIRT";

/**
 * Arzinja P2P order book — REFERENCE_ONLY by mandate.
 *
 * Verified 2026-07-29: HTTP 200 with a parseable body at `result.bids` /
 * `result.asks` (`[price, amount]` string pairs, TOMAN, bids descending from
 * 193,001, asks ascending from 194,790) plus `result.last_update`
 * ("2026-07-29 23:40:39", timezone not stated) and rate-limit headers
 * `X-RateLimit-Limit: 100`.
 *
 * The previous implementation read `data.bids`, which does not exist, so it
 * always fell through to a market-list endpoint and failed. The path is fixed
 * here, but the source stays REFERENCE_ONLY: one successful probe against an
 * undocumented `api-v2` P2P host is not a verified stable official market-data
 * API, and `last_update` has no stated timezone so it cannot drive staleness.
 */
export async function fetchArzinjaReference(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  const res = await shadowRequest<{
    code?: number;
    success?: boolean;
    result?: { symbol?: string; bids?: unknown[]; asks?: unknown[]; last_update?: string };
  }>(ENDPOINT, {
    timeoutMs: cfg.timeoutMs,
    minSpacingMs: cfg.minRequestSpacingMs,
    headers: { origin: "https://arzinja.ir", referer: "https://arzinja.ir/tether" }
  });

  const result = res.data.result;
  if (res.data.success === false || !result) {
    throw new ProviderError("ارزینجا: پاسخ عمومی معتبر نبود");
  }

  const bid = parseLevelsWithLoss(result.bids ?? [], "toman");
  const ask = parseLevelsWithLoss(result.asks ?? [], "toman");
  if (!bid.levels.length || !ask.levels.length) {
    throw new ProviderError("ارزینجا: دفتر P2P خالی یا خارج از بازه است");
  }

  return {
    kind: "BOOK",
    bids: bid.levels,
    asks: ask.levels,
    bestBidToman: null,
    bestAskToman: null,
    maxUsdt: null,
    // last_update has no stated timezone — not trusted for staleness.
    sourceTimestamp: null,
    priceUnit: "IRT",
    depthAvailable: true,
    directionVerified: false,
    endpoint: res.endpoint,
    httpStatus: res.httpStatus,
    latencyMs: res.latencyMs,
    attempts: res.attempts,
    rateLimited: res.rateLimited,
    normalizationNote:
      "دفتر P2P از result.bids/result.asks (تومان)؛ last_update بدون منطقهٔ زمانی است و برای کهنگی استفاده نمی‌شود",
    degradedReason: "منبع فقط مرجع — API عمومی رسمی و پایدار تأیید نشده است",
    diagnostics: {
      endpoint: "trade/p2p/orderbook",
      symbol: result.symbol ?? "USDTIRT",
      bidLevels: bid.levels.length,
      askLevels: ask.levels.length,
      rejectedLevels: bid.rejected + ask.rejected,
      venueLastUpdateRaw: result.last_update ?? null,
      documentedRateLimit: "X-RateLimit-Limit: 100"
    }
  };
}
