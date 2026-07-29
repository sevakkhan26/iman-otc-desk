import { BROWSER_UA } from "@/lib/http";
import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest, toIntegerToman } from "@/lib/shadowArbitrage/adapters/base";
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
 * Two consequences, both recorded rather than hidden:
 *  - the inversion is inferred from ordering, not documented by the venue;
 *  - the board carries junk levels, so an anchor band filter is required.
 * Certification therefore stays LIVE_DEGRADED even on a clean response.
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
    // Inversion is inferred from ordering, not published — do not claim verified.
    directionVerified: false,
    endpoint: res.endpoint,
    httpStatus: res.httpStatus,
    latencyMs: res.latencyMs + anchorLatency,
    attempts: res.attempts,
    rateLimited: res.rateLimited,
    normalizationNote:
      "نام فیلدها معکوس است (asks=خرید، bids=فروش) و استنباطی است؛ سطوح پرت با باند ±۸٪ حول مرجع حذف شدند",
    degradedReason:
      "تخته P2P با نام‌گذاری معکوس و سطوح پرت — نگاشت جهت مستند نشده، فقط تضعیف‌شده",
    diagnostics: {
      endpoint: "market.prices",
      invertedFields: true,
      anchor,
      preFilter,
      postFilter: { bids: bids.length, asks: asks.length }
    }
  };
}
