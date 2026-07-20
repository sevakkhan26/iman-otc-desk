/**
 * Build the public Tether prices payload from the canonical market snapshot.
 * Does not fetch providers — only maps an existing TetherMarket snapshot.
 *
 * Desk DomesticQuote convention (verified against Nobitex bestBuy/bestSell, book bids/asks):
 * - buyPrice  = exchange bid  = price at which the user SELL USDT to the exchange
 * - sellPrice = exchange ask  = price at which the user BUY  USDT from the exchange
 */
import type { DomesticQuote, SourceStatus, TetherMarketResponse } from "@/lib/types";

export const TETHER_PRICES_SCHEMA_VERSION = "1.0" as const;

export type TetherPriceExchangeStatus = "active" | "degraded" | "disconnected";

export type TetherPriceExchange = {
  id: string;
  name: string;
  /** Toman (IRT integer): user buys USDT from the exchange (ask). */
  userBuyPrice: number | null;
  /** Toman (IRT integer): user sells USDT to the exchange (bid). */
  userSellPrice: number | null;
  midPrice: number | null;
  status: TetherPriceExchangeStatus;
  updatedAt: string | null;
  error: string | null;
};

export type TetherPricesResponse = {
  schemaVersion: typeof TETHER_PRICES_SCHEMA_VERSION;
  generatedAt: string;
  serverNow: string;
  timezone: "Asia/Tehran";
  unit: "IRT";
  isStale: boolean;
  summary: {
    median: number | null;
    bestUserBuy: { exchange: string; price: number } | null;
    bestUserSell: { exchange: string; price: number } | null;
  };
  exchanges: TetherPriceExchange[];
};

function toIrtInt(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value);
}

/** Sanitize provider errors — drop stack/URLs/tokens, keep short message. */
export function sanitizeProviderError(message: string | null | undefined): string | null {
  if (!message) return null;
  let s = String(message).replace(/\s+/g, " ").trim();
  // strip likely secrets / long tokens
  s = s.replace(/otc_live_[A-Za-z0-9_-]+/g, "[redacted]");
  s = s.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
  s = s.replace(/https?:\/\/\S+/gi, "[url]");
  if (s.length > 160) s = `${s.slice(0, 157)}...`;
  return s || null;
}

export function mapSourceStatus(status: SourceStatus): TetherPriceExchangeStatus {
  if (status === "available") return "active";
  if (status === "degraded") return "degraded";
  return "disconnected";
}

/**
 * Map desk quote → user-facing buy/sell.
 * userBuyPrice  = sellPrice (ask)
 * userSellPrice = buyPrice  (bid)
 */
export function mapQuoteToExchange(q: DomesticQuote): TetherPriceExchange {
  const status = mapSourceStatus(q.sourceStatus);
  const disconnected = status === "disconnected";

  const userBuyPrice = disconnected ? null : toIrtInt(q.sellPrice);
  const userSellPrice = disconnected ? null : toIrtInt(q.buyPrice);

  let midPrice: number | null = null;
  if (userBuyPrice !== null && userSellPrice !== null) {
    midPrice = Math.round((userBuyPrice + userSellPrice) / 2);
  } else if (!disconnected) {
    midPrice = toIrtInt(q.midPrice);
  }

  return {
    id: q.exchangeId,
    name: q.exchangeName,
    userBuyPrice,
    userSellPrice,
    midPrice,
    status,
    updatedAt: disconnected ? null : q.lastUpdated,
    error: disconnected || q.errorMessage ? sanitizeProviderError(q.errorMessage ?? null) : null
  };
}

export function computeBestUserPrices(exchanges: TetherPriceExchange[]): {
  bestUserBuy: { exchange: string; price: number } | null;
  bestUserSell: { exchange: string; price: number } | null;
} {
  let bestUserBuy: { exchange: string; price: number } | null = null;
  let bestUserSell: { exchange: string; price: number } | null = null;

  for (const ex of exchanges) {
    if (ex.status === "disconnected") continue;
    if (ex.userBuyPrice !== null && Number.isFinite(ex.userBuyPrice) && ex.userBuyPrice > 0) {
      if (!bestUserBuy || ex.userBuyPrice < bestUserBuy.price) {
        bestUserBuy = { exchange: ex.name, price: ex.userBuyPrice };
      }
    }
    if (ex.userSellPrice !== null && Number.isFinite(ex.userSellPrice) && ex.userSellPrice > 0) {
      if (!bestUserSell || ex.userSellPrice > bestUserSell.price) {
        bestUserSell = { exchange: ex.name, price: ex.userSellPrice };
      }
    }
  }

  return { bestUserBuy, bestUserSell };
}

/**
 * Pure mapper from an already-loaded snapshot. No network I/O.
 */
export function buildTetherPricesResponse(
  snapshot: TetherMarketResponse,
  options?: { serverNow?: string }
): TetherPricesResponse {
  const serverNow = options?.serverNow ?? snapshot.serverNow ?? new Date().toISOString();
  const generatedAt = snapshot.generatedAt ?? snapshot.summary.lastUpdated ?? serverNow;
  const exchanges = snapshot.exchanges.map(mapQuoteToExchange);
  const { bestUserBuy, bestUserSell } = computeBestUserPrices(exchanges);

  return {
    schemaVersion: TETHER_PRICES_SCHEMA_VERSION,
    generatedAt,
    serverNow,
    timezone: "Asia/Tehran",
    unit: "IRT",
    isStale: Boolean(snapshot.isStale),
    summary: {
      median: toIrtInt(snapshot.summary.median),
      bestUserBuy,
      bestUserSell
    },
    exchanges
  };
}
