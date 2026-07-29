import { BROWSER_UA } from "@/lib/http";
import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest } from "@/lib/shadowArbitrage/adapters/base";
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";

const ENDPOINT = "https://pro.bit24.cash/api/v3/markets/USDT-IRT/order-books";

/**
 * Bit24 public order book, market USDT-IRT.
 * Verified 2026-07-29: HTTP 200; `data.buy_orders` descending (193,751 top) and
 * `data.sell_orders` ascending (194,000 top), each
 * `{price, amount, cumulative_amount, total}` with price in TOMAN and amount in
 * USDT. `total` confirms the unit: 193751 × 1.146 ≈ 222,038. No exchange
 * timestamp is published.
 */
export async function fetchBit24Book(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  const res = await shadowRequest<{
    success?: boolean;
    status_code?: number;
    error?: unknown;
    data?: { buy_orders?: unknown[]; sell_orders?: unknown[] };
  }>(ENDPOINT, {
    timeoutMs: cfg.timeoutMs,
    minSpacingMs: cfg.minRequestSpacingMs,
    headers: {
      "user-agent": BROWSER_UA,
      origin: "https://bit24.cash",
      referer: "https://bit24.cash/trade/usdt_irt/"
    }
  });

  if (res.data.success === false) {
    throw new ProviderError(`بیت۲۴: پاسخ ناموفق (${String(res.data.error ?? "unknown")})`);
  }

  const bid = parseLevelsWithLoss(res.data.data?.buy_orders ?? [], "toman");
  const ask = parseLevelsWithLoss(res.data.data?.sell_orders ?? [], "toman");
  if (!bid.levels.length || !ask.levels.length) {
    throw new ProviderError("دفتر سفارش بیت۲۴ خالی یا خارج از بازه است");
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
      "buy_orders = فروش کاربر، sell_orders = خرید کاربر؛ قیمت تومانی؛ بدون timestamp صرافی",
    diagnostics: {
      shape: "buy_orders/sell_orders",
      bidLevels: bid.levels.length,
      askLevels: ask.levels.length,
      rejectedLevels: bid.rejected + ask.rejected
    }
  };
}
