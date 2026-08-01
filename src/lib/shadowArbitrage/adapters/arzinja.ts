import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import {
  ProviderError,
  proveBookDirection,
  shadowRequest
} from "@/lib/shadowArbitrage/adapters/base";
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
 * Both reasons this source used to be capped at REFERENCE_ONLY have since been
 * settled with evidence rather than argument:
 *
 *  1. "undocumented host/path" — Arzinja's own API documentation page lists this
 *     P2P order book under its Public endpoints (no authentication, base URL
 *     `https://api-v2.arzinja.ir/api`), so the host and path are published, not
 *     discovered.
 *  2. "last_update has no stated timezone" — read as Tehran (+03:30) the field
 *     lands within seconds of real time, while reading it as UTC is off by
 *     exactly 3.5 hours. The offset is therefore determined, not assumed, and
 *     the field can drive staleness like any other venue's timestamp.
 *
 * Direction is proved per cycle by the no-crossing invariant, never trusted from
 * the field names.
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

  // The field names read as standard; this proves it on this cycle's numbers.
  const direction = proveBookDirection(bid.levels, ask.levels);

  /*
   * `last_update` carries no offset, so it is interpreted as Tehran and then
   * checked: a timestamp that does not land in a sane window around now is not
   * trusted for staleness, and the receipt time takes over instead.
   */
  const rawUpdate = typeof result.last_update === "string" ? result.last_update.trim() : null;
  const tehranMs = rawUpdate ? Date.parse(`${rawUpdate.replace(" ", "T")}+03:30`) : NaN;
  const skewMs = Number.isFinite(tehranMs) ? Date.now() - tehranMs : Number.NaN;
  const timestampTrusted = Number.isFinite(skewMs) && skewMs >= -60_000 && skewMs <= 15 * 60_000;
  const sourceTimestamp = timestampTrusted ? new Date(tehranMs).toISOString() : null;

  return {
    kind: "BOOK",
    bids: bid.levels,
    asks: ask.levels,
    bestBidToman: null,
    bestAskToman: null,
    maxUsdt: null,
    // Tehran offset determined empirically; dropped when the skew is implausible.
    sourceTimestamp,
    priceUnit: "IRT",
    depthAvailable: true,
    directionVerified: direction.verified,
    endpoint: res.endpoint,
    httpStatus: res.httpStatus,
    latencyMs: res.latencyMs,
    attempts: res.attempts,
    rateLimited: res.rateLimited,
    normalizationNote: `دفتر P2P از result.bids/result.asks (تومان)؛ ${direction.reason}؛ last_update به‌وقت تهران تفسیر و اعتبارسنجی شد${timestampTrusted ? "" : " و به‌دلیل انحراف غیرمنطقی کنار گذاشته شد"}`,
    degradedReason: direction.verified
      ? null
      : `جهت دفتر در این چرخه اثبات نشد: ${direction.reason}`,
    diagnostics: {
      endpoint: "trade/p2p/orderbook",
      symbol: result.symbol ?? "USDTIRT",
      bidLevels: bid.levels.length,
      askLevels: ask.levels.length,
      rejectedLevels: bid.rejected + ask.rejected,
      venueLastUpdateRaw: result.last_update ?? null,
      venueTimestampSkewMs: Number.isFinite(skewMs) ? Math.round(skewMs) : null,
      timestampTrusted,
      directionProof: direction,
      documentedRateLimit: "X-RateLimit-Limit: 100"
    }
  };
}
