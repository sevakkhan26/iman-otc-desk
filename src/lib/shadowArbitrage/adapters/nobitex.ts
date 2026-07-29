import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest } from "@/lib/shadowArbitrage/adapters/base";
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";

const ENDPOINT = "https://apiv2.nobitex.ir/v3/orderbook/USDTIRT";

/**
 * Nobitex public order book, market USDTIRT.
 * Verified 2026-07-29: HTTP 200; `bids`/`asks` are `[price, amount]` string
 * pairs with price in RIAL ("1935890" = 193,589 toman) and amount in USDT;
 * `bids` descending, `asks` ascending; `lastUpdate` is epoch ms.
 *
 * The legacy v2 endpoint is deliberately NOT used as a fallback — its `asks`
 * ordering did not match v3 on probe, so the direction mapping is unconfirmed
 * and falling back to it could publish inverted prices.
 */
export async function fetchNobitexBook(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  const res = await shadowRequest<{
    status?: string;
    bids?: unknown[];
    asks?: unknown[];
    lastUpdate?: number;
  }>(ENDPOINT, { timeoutMs: cfg.timeoutMs, minSpacingMs: cfg.minRequestSpacingMs });

  const data = res.data;
  if (data.status && data.status !== "ok") {
    throw new ProviderError(`nobitex status=${data.status}`);
  }

  const bid = parseLevelsWithLoss(data.bids ?? [], "rial");
  const ask = parseLevelsWithLoss(data.asks ?? [], "rial");
  if (!bid.levels.length || !ask.levels.length) {
    throw new ProviderError("دفتر سفارش نوبیتکس خالی یا خارج از بازه است");
  }

  const sourceTimestamp =
    typeof data.lastUpdate === "number" && data.lastUpdate > 0
      ? new Date(data.lastUpdate).toISOString()
      : null;

  return {
    kind: "BOOK",
    bids: bid.levels,
    asks: ask.levels,
    bestBidToman: null,
    bestAskToman: null,
    maxUsdt: null,
    sourceTimestamp,
    priceUnit: "IRR",
    depthAvailable: true,
    directionVerified: true,
    endpoint: res.endpoint,
    httpStatus: res.httpStatus,
    latencyMs: res.latencyMs,
    attempts: res.attempts,
    rateLimited: res.rateLimited,
    normalizationNote: "قیمت ریالی ÷ ۱۰ → تومان؛ asks = خرید کاربر، bids = فروش کاربر",
    diagnostics: {
      endpoint: "v3/orderbook",
      bidLevels: bid.levels.length,
      askLevels: ask.levels.length,
      rejectedLevels: bid.rejected + ask.rejected,
      exchangeTimestamp: sourceTimestamp
    }
  };
}
