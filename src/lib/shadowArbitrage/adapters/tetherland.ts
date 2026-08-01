import { BROWSER_UA } from "@/lib/http";
import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import {
  ProviderError,
  proveBookDirection,
  shadowRequest,
  toIntegerToman
} from "@/lib/shadowArbitrage/adapters/base";
import type { BookLevel } from "@/lib/shadowArbitrage/types";
import { parseNum } from "@/lib/shadowArbitrage/money";

const HEADERS = {
  "user-agent": BROWSER_UA,
  accept: "application/json",
  origin: "https://tetherland.com",
  referer: "https://tetherland.com/"
};

const BOARD = "https://market.tetherland.com/prices";
const CURRENCIES = "https://api.tetherland.com/currencies";

/**
 * Tetherland P2P offer board, market USDTTMN.
 * Verified 2026-07-29: HTTP 200; `data.markets.USDTTMN` has `asks` and `bids`
 * arrays of `{price, amount}` in TOMAN — but the names are inverted relative to
 * standard usage, matching the note already carried by the main project's
 * domestic adapter:
 *
 *   field `asks` → descending 190,010 … 187,001  = real BIDS  (buy offers)
 *   field `bids` → contains 50,501,202 / 6,691,000 / 2,000,000 = real ASKS
 *                  (sell offers) with extreme outlier levels
 *
 * The inversion used to be an assumption, which is why this source was capped
 * at LIVE_DEGRADED. It is now PROVED on every cycle instead: a real book never
 * crosses, so the inverted reading is accepted only when it is uncrossed AND the
 * literal reading would cross. If a cycle cannot prove that — because the venue
 * changed its convention, or the two clusters overlap — the direction is
 * reported unverified and the source degrades itself, rather than quietly
 * inverting the market.
 *
 * The board still carries junk P2P levels, so the anchor band filter remains.
 */
export async function fetchTetherlandBook(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  // Reference mid used only to reject outlier P2P levels — never published as a price.
  let anchor: number | null = null;
  let anchorLatency = 0;
  try {
    const ref = await shadowRequest<{
      data?: { currencies?: { USDT?: { price?: number; buy_price?: number; sell_price?: number } } };
    }>(CURRENCIES, {
      timeoutMs: Math.min(cfg.timeoutMs, 6_000),
      headers: HEADERS,
      maxAttempts: 1,
      minSpacingMs: cfg.minRequestSpacingMs
    });
    anchorLatency = ref.latencyMs;
    const usdt = ref.data.data?.currencies?.USDT;
    anchor =
      toIntegerToman(usdt?.price) ??
      toIntegerToman(usdt?.buy_price) ??
      toIntegerToman(usdt?.sell_price);
  } catch {
    /* anchor is optional — absence only widens what we accept */
  }

  const res = await shadowRequest<{
    data?: {
      markets?: {
        USDTTMN?: {
          bids?: Array<{ price?: number; amount?: number }>;
          asks?: Array<{ price?: number; amount?: number }>;
        };
      };
    };
  }>(BOARD, { timeoutMs: cfg.timeoutMs, headers: HEADERS, minSpacingMs: cfg.minRequestSpacingMs });

  const market = res.data.data?.markets?.USDTTMN;
  const toLevels = (rows: Array<{ price?: number; amount?: number }> | undefined): BookLevel[] => {
    const out: BookLevel[] = [];
    for (const row of rows ?? []) {
      const p = toIntegerToman(row.price);
      const a = parseNum(row.amount);
      if (p === null || a === null || a <= 0) continue;
      out.push({ priceToman: p, amountUsdt: a });
    }
    return out;
  };

  // Documented inversion: the field named `asks` holds bids and vice versa.
  let bids = toLevels(market?.asks);
  let asks = toLevels(market?.bids);
  const preFilter = { bids: bids.length, asks: asks.length };

  if (anchor) {
    const band = (lv: BookLevel[]) =>
      lv.filter((l) => Math.abs(l.priceToman - anchor!) / anchor! <= 0.08);
    const b2 = band(bids);
    const a2 = band(asks);
    if (b2.length && a2.length) {
      bids = b2;
      asks = a2;
    }
  }

  if (!bids.length || !asks.length) {
    throw new ProviderError("تترلند: تخته P2P پس از فیلتر پرت خالی شد");
  }

  /*
   * Prove the inversion on this cycle's own numbers. `bids`/`asks` above already
   * hold the inverted reading, so this asks: is that reading uncrossed while the
   * literal one crosses? Only then is the mapping evidence rather than habit.
   */
  const direction = proveBookDirection(bids, asks);

  return {
    kind: "BOOK",
    bids,
    asks,
    bestBidToman: null,
    bestAskToman: null,
    maxUsdt: null,
    sourceTimestamp: null,
    priceUnit: "IRT",
    depthAvailable: true,
    // Verified per cycle by the no-crossing invariant, never assumed.
    directionVerified: direction.verified,
    endpoint: res.endpoint,
    httpStatus: res.httpStatus,
    latencyMs: res.latencyMs + anchorLatency,
    attempts: res.attempts,
    rateLimited: res.rateLimited,
    normalizationNote: `نام فیلدها معکوس است (asks=خرید، bids=فروش) و در همین چرخه اثبات شد؛ ${direction.reason}؛ سطوح پرت با باند ±۸٪ حول مرجع حذف شدند`,
    degradedReason: direction.verified
      ? null
      : `جهت دفتر در این چرخه اثبات نشد: ${direction.reason}`,
    diagnostics: {
      endpoint: "market.prices",
      invertedFields: true,
      directionProof: direction,
      anchor,
      preFilter,
      postFilter: { bids: bids.length, asks: asks.length }
    }
  };
}
