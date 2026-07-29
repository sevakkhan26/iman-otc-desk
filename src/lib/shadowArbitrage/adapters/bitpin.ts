import { BROWSER_UA } from "@/lib/http";
import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ShadowSourceError, shadowRequest } from "@/lib/shadowArbitrage/adapters/base";
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";

const URLS = [
  "https://api.bitpin.ir/api/v1/mth/orderbook/USDT_IRT/",
  "https://api.bitpin.org/api/v1/mth/orderbook/USDT_IRT/"
];

/**
 * Bitpin public order book, market USDT_IRT.
 * Verified 2026-07-29: HTTP 200 on the .ir host; `asks`/`bids` are
 * `[price, amount]` string pairs (20 levels each), price in TOMAN
 * ("193984"), amount in USDT. No exchange timestamp is published.
 */
export async function fetchBitpinBook(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  let lastError: unknown = null;

  for (const url of URLS) {
    try {
      const res = await shadowRequest<{ bids?: unknown[]; asks?: unknown[] }>(url, {
        timeoutMs: cfg.timeoutMs,
        minSpacingMs: cfg.minRequestSpacingMs,
        headers: { "user-agent": BROWSER_UA }
      });
      const bid = parseLevelsWithLoss(res.data.bids ?? [], "toman");
      const ask = parseLevelsWithLoss(res.data.asks ?? [], "toman");
      if (!bid.levels.length || !ask.levels.length) {
        lastError = new ShadowSourceError("دفتر سفارش بیت‌پین خالی است", {
          endpoint: url,
          httpStatus: res.httpStatus,
          latencyMs: res.latencyMs,
          attempts: res.attempts
        });
        continue;
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
        normalizationNote: "قیمت تومانی؛ asks = خرید کاربر، bids = فروش کاربر؛ بدون timestamp صرافی",
        diagnostics: {
          host: new URL(url).host,
          bidLevels: bid.levels.length,
          askLevels: ask.levels.length,
          rejectedLevels: bid.rejected + ask.rejected
        }
      };
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new ShadowSourceError("بیت‌پین: هیچ میزبانی پاسخ نداد", { endpoint: URLS[0]! });
}
