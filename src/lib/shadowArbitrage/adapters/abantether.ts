import type { ShadowSourceConfig } from "@/lib/shadowArbitrage/config";
import type { AdapterResult } from "@/lib/shadowArbitrage/adapters/base";
import { ProviderError, shadowRequest, toIntegerToman } from "@/lib/shadowArbitrage/adapters/base";
import { parseNum } from "@/lib/shadowArbitrage/money";

const ENDPOINT = "https://api.abantether.com/api/v1/manager/otc/ticker";

/**
 * AbanTether OTC dealer quotes.
 * Verified 2026-07-29: HTTP 200; `data.markets.USDTIRT` =
 * `{symbol:"USDT", buy_price:"194488", sell_price:"193078",
 *   buy_max:"50000.00", sell_max:"50000.00", active:true}`.
 *
 * Direction: `buy_price` > `sell_price` on every market in the payload, which
 * matches user-perspective naming — buy_price is what the user PAYS (ask) and
 * sell_price is what the user RECEIVES (bid). The pair is never reordered; if
 * the invariant breaks, direction is reported unverified instead.
 *
 * Limitation recorded in certification: `buy_max`/`sell_max` are read as asset
 * quantity (USDT). They scale inversely with unit price across the payload
 * (MORI 200, ELSA 500, EURI 2000, USDT 50000), which fits a per-asset quantity
 * cap rather than a toman cap, but the unit is not documented by the venue.
 */
export async function fetchAbanTetherQuote(cfg: ShadowSourceConfig): Promise<AdapterResult> {
  const res = await shadowRequest<{
    data?: {
      markets?: Record<
        string,
        {
          symbol?: string;
          buy_price?: string | number;
          sell_price?: string | number;
          buy_max?: string | number;
          sell_max?: string | number;
          active?: boolean;
        }
      >;
    };
  }>(ENDPOINT, { timeoutMs: cfg.timeoutMs, minSpacingMs: cfg.minRequestSpacingMs });

  const markets = res.data.data?.markets ?? {};
  const row = markets.USDTIRT ?? markets.USDTTMN ?? markets.USDT;
  if (!row) throw new ProviderError("بازار USDT در تیکر OTC آبان‌تتر یافت نشد");
  if (row.active === false) throw new ProviderError("بازار USDT آبان‌تتر غیرفعال است");

  const userBuy = toIntegerToman(row.buy_price, "toman");
  const userSell = toIntegerToman(row.sell_price, "toman");
  if (userBuy === null || userSell === null) {
    throw new ProviderError("نقل‌قول OTC آبان‌تتر خارج از بازه معقول است");
  }

  // Invariant check only — no swapping. A dealer never sells below its own bid.
  const directionVerified = userBuy >= userSell;

  const buyMax = parseNum(row.buy_max);
  const sellMax = parseNum(row.sell_max);
  const maxUsdt =
    buyMax !== null && sellMax !== null && buyMax > 0 && sellMax > 0
      ? Math.min(buyMax, sellMax)
      : (buyMax ?? sellMax ?? null);

  return {
    kind: "OTC_QUOTE",
    bids: [],
    asks: [],
    bestBidToman: userSell,
    bestAskToman: userBuy,
    maxUsdt: maxUsdt !== null && maxUsdt > 0 ? maxUsdt : null,
    sourceTimestamp: null,
    priceUnit: "IRT",
    depthAvailable: false,
    directionVerified,
    endpoint: res.endpoint,
    httpStatus: res.httpStatus,
    latencyMs: res.latencyMs,
    attempts: res.attempts,
    rateLimited: res.rateLimited,
    normalizationNote:
      "buy_price = پرداخت کاربر (ask)، sell_price = دریافت کاربر (bid)؛ حد اجرا از buy_max/sell_max به‌عنوان مقدار USDT خوانده شده (واحد مستند نشده)",
    degradedReason: directionVerified
      ? null
      : "نقض شرط ask ≥ bid در نقل‌قول OTC — جهت تأیید نشد",
    diagnostics: {
      marketKey: markets.USDTIRT ? "USDTIRT" : markets.USDTTMN ? "USDTTMN" : "USDT",
      buyMax,
      sellMax,
      quoteSpreadPercent:
        userBuy > 0 ? Math.round(((userBuy - userSell) / userBuy) * 1_000_000) / 10_000 : null
    }
  };
}
