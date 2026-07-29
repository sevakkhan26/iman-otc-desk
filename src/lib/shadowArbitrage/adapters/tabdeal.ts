import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest } from "@/lib/shadowArbitrage/adapters/base";
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";

const ENDPOINT = "https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=50";

/**
 * Tabdeal depth, market symbol USDTIRT.
 * Verified 2026-07-29: HTTP 200; `bids`/`asks` are `[price, amount]` string
 * pairs, 50 levels each. Despite the IRT symbol the prices are TOMAN
 * ("193055.0000" while other venues quoted ≈193,000 toman), so the unit is
 * declared rather than sniffed — a rial reading would land outside the
 * plausibility band and is rejected, not silently rescaled.
 */
export async function fetchTabdealBook(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  const res = await shadowRequest<{ bids?: unknown[]; asks?: unknown[] }>(ENDPOINT, {
    timeoutMs: cfg.timeoutMs,
    minSpacingMs: cfg.minRequestSpacingMs
  });

  const bid = parseLevelsWithLoss(res.data.bids ?? [], "toman");
  const ask = parseLevelsWithLoss(res.data.asks ?? [], "toman");
  if (!bid.levels.length || !ask.levels.length) {
    throw new ProviderError("دفتر سفارش تبدیل خالی یا خارج از بازه است");
  }

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
    normalizationNote:
      "نماد USDTIRT اما قیمت‌ها تومانی هستند (تأیید مشاهده‌ای ۲۰۲۶-۰۷-۲۹)؛ بدون timestamp صرافی",
    diagnostics: {
      bidLevels: bid.levels.length,
      askLevels: ask.levels.length,
      rejectedLevels: bid.rejected + ask.rejected
    }
  };
}
