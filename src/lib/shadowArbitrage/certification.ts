/**
 * Source certification registry for Shadow Arbitrage.
 *
 * LIVE_VERIFIED is only ever reached from a real public response whose
 * normalization was validated — never from a fixture, never from a headline
 * price standing in for depth, and never from an inferred field mapping.
 */

import { getSourceConfig } from "@/lib/shadowArbitrage/config";
import type {
  NormalizedSourceSnapshot,
  ShadowSourceId,
  SourceResponseMeta
} from "@/lib/shadowArbitrage/types";

export type CertificationStatus =
  | "LIVE_VERIFIED"
  | "LIVE_DEGRADED"
  | "REFERENCE_ONLY"
  | "UNSUPPORTED"
  | "PENDING_PROBE";

/** Static documentation for each source — the part that does not change per cycle. */
export type SourceCertificationBase = {
  sourceId: ShadowSourceId;
  sourceName: string;
  endpoint: string;
  documentationUrl: string | null;
  marketSymbol: string;
  marketModel: "ORDER_BOOK" | "OTC_QUOTE" | "REFERENCE";
  /** Unit as published by the venue, before our normalization. */
  priceUnit: "IRT" | "IRR" | "mixed";
  quantityUnit: string;
  /** How bid/ask map to user-buy / user-sell. */
  directionNote: string;
  depthNote: string;
  timestampNote: string;
  rateLimitNote: string;
  feeNote: string;
  /** Ceiling on how good this source's status may get, by design. */
  maxStatus: CertificationStatus;
  /** Known ambiguity or limitation — always shown, never suppressed. */
  limitations: string;
};

export type SourceCertification = SourceCertificationBase & {
  status: CertificationStatus;
  /** Why the status is what it is — exact reason when not LIVE_VERIFIED. */
  statusReason: string | null;
  observedPriceUnit: SourceResponseMeta["priceUnit"] | null;
  lastProbeAt: string | null;
  lastHttpStatus: number | null;
  lastLatencyMs: number | null;
  lastAttempts: number | null;
  lastRateLimited: boolean;
  lastError: string | null;
  lastErrorAt: string | null;
  depthAvailable: boolean | null;
  directionVerified: boolean | null;
  maxExecutableUsdt: number | null;
  exchangeTimestamp: string | null;
  /** First moment this source reached LIVE_VERIFIED and stayed reachable. */
  verifiedAt: string | null;
  feeStatus: string;
  feeValueBps: number | null;
  feeReferenceUrl: string | null;
  feeVerifiedAt: string | null;
  feeExplanation: string;
};

/**
 * Documented facts per source. Endpoint/shape/unit claims below were confirmed
 * against live public responses on 2026-07-29; anything unconfirmed says so.
 */
export const CERTIFICATION_BASE: Record<ShadowSourceId, SourceCertificationBase> = {
  nobitex: {
    sourceId: "nobitex",
    sourceName: "نوبیتکس",
    endpoint: "https://apiv2.nobitex.ir/v3/orderbook/USDTIRT",
    documentationUrl: "https://apidocs.nobitex.ir/",
    marketSymbol: "USDTIRT",
    marketModel: "ORDER_BOOK",
    priceUnit: "IRR",
    quantityUnit: "USDT",
    directionNote: "asks = خرید کاربر، bids = فروش کاربر (پس از ÷۱۰ ریال→تومان)",
    depthNote: "دفتر چندسطحی واقعی (≈۲۴ سطح در هر طرف) — VWAP اجراپذیر محاسبه می‌شود",
    timestampNote: "lastUpdate بر حسب میلی‌ثانیهٔ epoch — برای سنجش کهنگی استفاده می‌شود",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ فاصلهٔ ۱ ثانیه‌ای خودتحمیلی",
    feeNote: "۰٫۲۵٪ taker موقت — https://nobitex.ir/fees/",
    maxStatus: "LIVE_VERIFIED",
    limitations:
      "نسخهٔ v2 به‌عنوان fallback استفاده نمی‌شود چون ترتیب asks آن با v3 هم‌خوان نبود و جهت آن تأیید نشد."
  },
  wallex: {
    sourceId: "wallex",
    sourceName: "والکس",
    endpoint: "https://api.wallex.ir/v1/depth?symbol=USDTTMN&limit=50",
    documentationUrl: "https://api-docs.wallex.ir/",
    marketSymbol: "USDTTMN",
    marketModel: "ORDER_BOOK",
    priceUnit: "IRT",
    quantityUnit: "USDT",
    directionNote: "result.ask = خرید کاربر، result.bid = فروش کاربر (تومان)",
    depthNote: "دفتر چندسطحی {price, quantity, sum}؛ در صورت خالی بودن فقط سرصفحه و بدون عمق",
    timestampNote: "timestamp صرافی منتشر نمی‌شود — زمان دریافت سرور مبنا است",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ فاصلهٔ ۱ ثانیه‌ای خودتحمیلی",
    feeNote: "۰٫۳۵٪ taker محافظه‌کارانه و موقت",
    maxStatus: "LIVE_VERIFIED",
    limitations:
      "مسیر جایگزین markets فقط بهترین bid/ask دارد؛ در آن حالت هیچ حجمی اجراپذیر اعلام نمی‌شود."
  },
  tabdeal: {
    sourceId: "tabdeal",
    sourceName: "تبدیل",
    endpoint: "https://api1.tabdeal.org/r/api/v1/depth?symbol=USDTIRT&limit=50",
    documentationUrl: null,
    marketSymbol: "USDTIRT",
    marketModel: "ORDER_BOOK",
    priceUnit: "IRT",
    quantityUnit: "USDT",
    directionNote: "asks = خرید کاربر، bids = فروش کاربر",
    depthNote: "دفتر ۵۰ سطحی در هر طرف",
    timestampNote: "timestamp صرافی منتشر نمی‌شود — زمان دریافت سرور مبنا است",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ فاصلهٔ ۱ ثانیه‌ای خودتحمیلی",
    feeNote: "۰٫۳۵٪ taker موقت — مرجع عمومی تأییدشده ثبت نشده",
    maxStatus: "LIVE_VERIFIED",
    limitations:
      "نماد USDTIRT است اما قیمت‌ها تومانی هستند؛ واحد به‌صورت مشاهده‌ای تثبیت شده و با میانهٔ سایر منابع اعتبارسنجی می‌شود."
  },
  bitpin: {
    sourceId: "bitpin",
    sourceName: "بیت‌پین",
    endpoint: "https://api.bitpin.ir/api/v1/mth/orderbook/USDT_IRT/",
    documentationUrl: null,
    marketSymbol: "USDT_IRT",
    marketModel: "ORDER_BOOK",
    priceUnit: "IRT",
    quantityUnit: "USDT",
    directionNote: "asks = خرید کاربر، bids = فروش کاربر (تومان)",
    depthNote: "دفتر ۲۰ سطحی در هر طرف",
    timestampNote: "timestamp صرافی منتشر نمی‌شود — زمان دریافت سرور مبنا است",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ فاصلهٔ ۱ ثانیه‌ای خودتحمیلی",
    feeNote: "کارمزد تأییدنشده — نتایج «پتانسیل خام» هستند",
    maxStatus: "LIVE_VERIFIED",
    limitations: "میزبان جایگزین api.bitpin.org در صورت خطای میزبان اصلی آزمایش می‌شود."
  },
  abantether: {
    sourceId: "abantether",
    sourceName: "آبان‌تتر",
    endpoint: "https://api.abantether.com/api/v1/manager/otc/ticker",
    documentationUrl: null,
    marketSymbol: "USDTIRT",
    marketModel: "OTC_QUOTE",
    priceUnit: "IRT",
    quantityUnit: "USDT (خوانش استنباطی از buy_max/sell_max)",
    directionNote:
      "buy_price = پرداخت کاربر (ask)، sell_price = دریافت کاربر (bid)؛ شرط ask ≥ bid بررسی می‌شود و هرگز جابه‌جا نمی‌شود",
    depthNote: "نقل‌قول واحد OTC با حد اجرای منتشرشده (buy_max/sell_max = ۵۰٬۰۰۰)",
    timestampNote: "timestamp نقل‌قول منتشر نمی‌شود — زمان دریافت سرور مبنا است",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ فاصلهٔ ۱٫۵ ثانیه‌ای خودتحمیلی",
    feeNote: "کارمزد OTC معمولاً داخل اسپرد است — تأییدنشده",
    maxStatus: "LIVE_VERIFIED",
    limitations:
      "واحد buy_max/sell_max توسط صرافی مستند نشده؛ به‌عنوان مقدار USDT خوانده می‌شود چون در کل payload با قیمت واحد رابطهٔ معکوس دارد. بدون حساب احرازشده مسیرهای این منبع همیشه «نیاز به حساب» می‌مانند."
  },
  ramzinex: {
    sourceId: "ramzinex",
    sourceName: "رمزینکس",
    endpoint: "https://publicapi.ramzinex.com/exchange/api/v1.0/exchange/orderbooks/11/buys_sells",
    documentationUrl: "https://ramzinex.com/exchange/api/v1.0/",
    marketSymbol: "pair 11 (USDT/IRR)",
    marketModel: "ORDER_BOOK",
    priceUnit: "IRR",
    quantityUnit: "USDT",
    directionNote: "data.sells = خرید کاربر، data.buys = فروش کاربر (پس از ÷۱۰)",
    depthNote: "دفتر چندسطحی به شکل tuple [price, amount, total, bool, null, count, epochMs]",
    timestampNote:
      "epoch انتهای هر tuple زمان ثبت همان سفارش است نه زمان snapshot؛ برای کهنگی استفاده نمی‌شود",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ فاصلهٔ ۱٫۵ ثانیه‌ای خودتحمیلی",
    feeNote: "کارمزد تأییدنشده — نتایج «پتانسیل خام» هستند",
    maxStatus: "LIVE_VERIFIED",
    limitations:
      "مسیر /orderbooks/11 با HTTP 404 پاسخ می‌دهد؛ مسیر صحیح /orderbooks/11/buys_sells است. ممکن است در برخی خروجی‌های شبکه به پروکسی نیاز باشد."
  },
  tetherland: {
    sourceId: "tetherland",
    sourceName: "تترلند",
    endpoint: "https://market.tetherland.com/prices",
    documentationUrl: null,
    marketSymbol: "USDTTMN",
    marketModel: "ORDER_BOOK",
    priceUnit: "IRT",
    quantityUnit: "USDT",
    directionNote:
      "نام فیلدها معکوس است (asks=خرید، bids=فروش) و این نگاشت در هر چرخه با ناوردای عدم‌تقاطع اثبات می‌شود: خوانش معکوس بدون تقاطع است و خوانش تحت‌اللفظی متقاطع می‌شود",
    depthNote: "تخته پیشنهاد P2P؛ سطوح پرت (تا ۵۰٫۵ میلیون تومان) با باند ±۸٪ حول مرجع حذف می‌شوند",
    timestampNote: "timestamp منتشر نمی‌شود — زمان دریافت سرور مبنا است",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ نیازمند هدرهای مرورگرمانند",
    feeNote: "کارمزد taker از پنل حساب تأیید شده است (تأیید مدیر، تصویر پنل)",
    /*
     * The ceiling used to sit at LIVE_DEGRADED because the field inversion was
     * assumed. It is now proved on every cycle by the no-crossing invariant, and
     * a cycle that cannot prove it degrades itself — so the cap is no longer
     * warranted. Outlier levels are still filtered deterministically.
     */
    maxStatus: "LIVE_VERIFIED",
    limitations:
      "نگاشت جهت در هر چرخه اثبات می‌شود؛ اگر صرافی قرارداد خود را تغییر دهد، همان چرخه جهت را تأییدنشده گزارش و منبع را تضعیف می‌کند. سطوح پرت P2P همچنان فیلتر می‌شوند."
  },
  bit24: {
    sourceId: "bit24",
    sourceName: "بیت۲۴",
    endpoint: "https://pro.bit24.cash/api/v3/markets/USDT-IRT/order-books",
    documentationUrl: null,
    marketSymbol: "USDT-IRT",
    marketModel: "ORDER_BOOK",
    priceUnit: "IRT",
    quantityUnit: "USDT",
    directionNote: "sell_orders = خرید کاربر، buy_orders = فروش کاربر (تومان)",
    depthNote: "دفتر چندسطحی {price, amount, cumulative_amount, total}",
    timestampNote: "timestamp منتشر نمی‌شود — زمان دریافت سرور مبنا است",
    rateLimitNote: "هدر محدودیت نرخ منتشر نمی‌شود؛ فاصلهٔ ۱٫۵ ثانیه‌ای خودتحمیلی",
    feeNote: "کارمزد تأییدنشده — نتایج «پتانسیل خام» هستند",
    maxStatus: "LIVE_VERIFIED",
    limitations: "ممکن است WAF برخی IPهای خروجی را محدود کند."
  },
  arzinja: {
    sourceId: "arzinja",
    sourceName: "ارزینجا",
    endpoint: "https://api-v2.arzinja.ir/api/v1/trade/p2p/orderbook?pair=USDTIRT",
    documentationUrl: null,
    marketSymbol: "USDTIRT (P2P)",
    /*
     * ORDER_BOOK, matching what the adapter actually walks and what
     * `config.ts` already declared.
     *
     * While this read REFERENCE the venue was not being certified LESS
     * strictly — it was being certified less COMPLETELY: the depth gate below
     * is keyed on the model, so `base.marketModel === "ORDER_BOOK" &&
     * !meta.depthAvailable` never ran for Arzinja and a cycle that returned
     * only a header price would still have been called LIVE_VERIFIED. Naming
     * the model correctly subjects it to the same executable-depth proof as
     * the other seven books; it grants nothing.
     */
    marketModel: "ORDER_BOOK",
    priceUnit: "IRT",
    quantityUnit: "USDT",
    directionNote:
      "result.bids/result.asks استاندارد است و در هر چرخه با ناوردای عدم‌تقاطع اثبات می‌شود (بهترین خرید < بهترین فروش)",
    depthNote: "دفتر P2P چندسطحی در result.bids/result.asks — ۲۰ سطح در هر سمت",
    timestampNote:
      "result.last_update به‌وقت تهران (+۰۳:۳۰) است — با نمونه‌برداری زنده اثبات شد (انحراف چند ثانیه، در حالی که خواندن UTC دقیقاً ۳٫۵ ساعت خطا دارد) و مبنای کهنگی قرار می‌گیرد؛ انحراف غیرمنطقی آن را کنار می‌گذارد",
    rateLimitNote: "تنها منبعی که محدودیت نرخ منتشر می‌کند: X-RateLimit-Limit: 100",
    feeNote: "کارمزد taker از پنل حساب تأیید شده است (تأیید مدیر، تصویر پنل)",
    /*
     * The REFERENCE_ONLY cap existed because the host and P2P path were not
     * documented as an official public API. Arzinja's own API documentation page
     * lists this order book under its Public (no-authentication) endpoints with
     * base URL https://api-v2.arzinja.ir/api, so that reason no longer holds.
     */
    maxStatus: "LIVE_VERIFIED",
    limitations:
      "مسیر دفتر سفارش P2P در صفحهٔ مستندات API خود ارزینجا ذیل اندپوینت‌های عمومی (بدون احراز هویت) منتشر شده است. جهت، واحد قیمت، عمق و تازگی در هر چرخه اعتبارسنجی می‌شوند و شکست هر کدام منبع را تضعیف می‌کند."
  }
};

const STATUS_RANK: Record<CertificationStatus, number> = {
  UNSUPPORTED: 0,
  PENDING_PROBE: 1,
  REFERENCE_ONLY: 2,
  LIVE_DEGRADED: 3,
  LIVE_VERIFIED: 4
};

/** Never let a source exceed the ceiling its documentation justifies. */
function capStatus(id: ShadowSourceId, candidate: CertificationStatus): CertificationStatus {
  const ceiling = CERTIFICATION_BASE[id].maxStatus;
  return STATUS_RANK[candidate] > STATUS_RANK[ceiling] ? ceiling : candidate;
}

/** In-memory last probe results (also persisted by the collector). */
const runtimeCert = new Map<ShadowSourceId, SourceCertification>();

function emptyCert(id: ShadowSourceId): SourceCertification {
  const base = CERTIFICATION_BASE[id];
  const cfg = getSourceConfig(id);
  return {
    ...base,
    status: base.maxStatus === "REFERENCE_ONLY" ? "REFERENCE_ONLY" : "PENDING_PROBE",
    statusReason: "هنوز probe زنده‌ای ثبت نشده است",
    observedPriceUnit: null,
    lastProbeAt: null,
    lastHttpStatus: null,
    lastLatencyMs: null,
    lastAttempts: null,
    lastRateLimited: false,
    lastError: null,
    lastErrorAt: null,
    depthAvailable: null,
    directionVerified: null,
    maxExecutableUsdt: null,
    exchangeTimestamp: null,
    verifiedAt: null,
    feeStatus: cfg.feeStatus,
    feeValueBps: cfg.feeBps,
    feeReferenceUrl: cfg.feeReferenceUrl,
    feeVerifiedAt: cfg.feeVerifiedAt,
    feeExplanation: cfg.feeExplanation
  };
}

export function getCertification(id: ShadowSourceId): SourceCertification {
  return runtimeCert.get(id) ?? emptyCert(id);
}

export function setCertification(cert: SourceCertification): void {
  runtimeCert.set(cert.sourceId, cert);
}

export function listCertifications(): SourceCertification[] {
  return (Object.keys(CERTIFICATION_BASE) as ShadowSourceId[]).map(getCertification);
}

/** Test seam — clears the in-process cache. */
export function resetCertifications(): void {
  runtimeCert.clear();
}

/**
 * Derive certification from one live snapshot plus the previous record.
 *
 * Rules:
 *  - unreachable → UNSUPPORTED if never verified, otherwise LIVE_DEGRADED
 *    (a source that used to work is degraded, not unsupported);
 *  - reachable but normalization not fully validated → LIVE_DEGRADED with the
 *    exact reason;
 *  - reachable and validated → LIVE_VERIFIED, capped by the documented ceiling.
 */
export function certifyFromSnapshot(
  snapshot: NormalizedSourceSnapshot,
  previous: SourceCertification = getCertification(snapshot.sourceId)
): SourceCertification {
  const id = snapshot.sourceId;
  const base = CERTIFICATION_BASE[id];
  const cfg = getSourceConfig(id);
  const meta = snapshot.meta;

  let status: CertificationStatus;
  let reason: string | null = null;

  if (snapshot.health === "unavailable") {
    status = previous.verifiedAt ? "LIVE_DEGRADED" : "UNSUPPORTED";
    reason =
      snapshot.errorReason ??
      (previous.verifiedAt
        ? "منبع در این چرخه پاسخ نداد (قبلاً تأیید شده بود)"
        : "هیچ پاسخ عمومی موفقی از این منبع ثبت نشده است");
  } else if (snapshot.userBuyPriceToman == null || snapshot.userSellPriceToman == null) {
    status = "LIVE_DEGRADED";
    reason = "پاسخ دریافت شد اما قیمت خرید/فروش قابل استخراج نبود";
  } else if (!meta.directionVerified) {
    status = "LIVE_DEGRADED";
    reason = "جهت خرید/فروش کاربر تأیید نشد";
  } else if (meta.priceUnit === "ambiguous") {
    status = "LIVE_DEGRADED";
    reason = "واحد قیمت (ریال/تومان) قطعی نشد";
  } else if (base.marketModel === "ORDER_BOOK" && !meta.depthAvailable) {
    status = "LIVE_DEGRADED";
    reason = "عمق دفتر در این چرخه در دسترس نبود (فقط قیمت سرصفحه)";
  } else if (base.marketModel === "OTC_QUOTE" && snapshot.maxExecutableUsdt == null) {
    status = "LIVE_DEGRADED";
    reason = "حد اجرای نقل‌قول OTC منتشر نشده بود";
  } else if (meta.rateLimited) {
    status = "LIVE_DEGRADED";
    reason = "پاسخ محدودیت نرخ در این چرخه دریافت شد";
  } else if (snapshot.stale) {
    status = "LIVE_DEGRADED";
    reason = "دادهٔ منبع از بودجهٔ تازگی عبور کرده بود";
  } else {
    status = "LIVE_VERIFIED";
  }

  const capped = capStatus(id, status);
  if (capped !== status) {
    reason = base.limitations;
  }

  const errored = snapshot.health === "unavailable" || Boolean(snapshot.errorReason);

  return {
    ...base,
    status: capped,
    statusReason: reason,
    observedPriceUnit: meta.priceUnit,
    lastProbeAt: snapshot.receivedAt,
    lastHttpStatus: meta.httpStatus,
    lastLatencyMs: meta.latencyMs,
    lastAttempts: meta.attempts,
    lastRateLimited: meta.rateLimited,
    lastError: snapshot.errorReason ?? previous.lastError,
    lastErrorAt: errored ? snapshot.receivedAt : previous.lastErrorAt,
    depthAvailable: meta.depthAvailable,
    directionVerified: meta.directionVerified,
    maxExecutableUsdt: snapshot.maxExecutableUsdt,
    exchangeTimestamp: snapshot.sourceTimestamp,
    verifiedAt: capped === "LIVE_VERIFIED" ? (previous.verifiedAt ?? snapshot.receivedAt) : previous.verifiedAt,
    feeStatus: cfg.feeStatus,
    feeValueBps: cfg.feeBps,
    feeReferenceUrl: cfg.feeReferenceUrl,
    feeVerifiedAt: cfg.feeVerifiedAt,
    feeExplanation: cfg.feeExplanation
  };
}

/** True when this source may back an "executable now" claim. */
export function isCertifiedExecutable(status: CertificationStatus): boolean {
  return status === "LIVE_VERIFIED";
}
