/**
 * Phase 6 — paper broker.
 *
 * A pure accounting module. It has no network client, no exchange adapter, no
 * credential handling and no code path that could place a real order or move
 * real funds: it only takes virtual balances plus an already-collected order
 * book snapshot and returns the balances that would result.
 *
 * Deliberately importable-safe: this file must never import an adapter, an HTTP
 * client, or anything under `@/lib/shadowArbitrage/adapters`. A structural test
 * enforces that.
 *
 * Money rules:
 *  - toman is integer;
 *  - USDT is integer micros (1 USDT = 1_000_000 micros), never a float balance;
 *  - a fill is all-or-nothing: both legs are computed first, and if either one
 *    fails nothing is applied;
 *  - fees leave the portfolio, which is a real cost. Nothing else does, so no
 *    phantom money can appear.
 *
 * OMPFinex is not a Shadow venue and cannot appear here.
 */
import { feeFromBps, mulPriceSizeToman } from "@/lib/shadowArbitrage/money";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

/** 1 USDT expressed in the integer unit used for every virtual balance. */
export const USDT_MICROS = 1_000_000;

export function usdtToMicros(units: number): number {
  return Math.round(units * USDT_MICROS);
}
export function microsToUsdt(micros: number): number {
  return Math.round(micros) / USDT_MICROS;
}

/**
 * Which currency a venue's taker fee is actually charged in.
 *  QUOTE_IRT — a percentage of the toman notional.
 *  BASE_USDT — a percentage of the USDT amount.
 *  UNKNOWN   — not established; execution is blocked rather than guessed.
 */
export type FeeBasis = "QUOTE_IRT" | "BASE_USDT" | "UNKNOWN";

/**
 * Fee basis per venue.
 *
 * The three venues the desk holds accounts on charge the taker fee against the
 * toman notional, which is the same convention the Phase 2 economics already
 * use. Every venue without a verified account has no established basis and
 * stays UNKNOWN — a venue can have a published fee number and still not have a
 * confirmed basis, and in that case the engine must refuse to execute.
 */
export const PAPER_FEE_BASIS: Record<ShadowSourceId, FeeBasis> = {
  nobitex: "QUOTE_IRT",
  wallex: "QUOTE_IRT",
  tabdeal: "QUOTE_IRT",
  bitpin: "UNKNOWN",
  abantether: "UNKNOWN",
  ramzinex: "UNKNOWN",
  tetherland: "UNKNOWN",
  bit24: "UNKNOWN",
  arzinja: "UNKNOWN"
};

export function feeBasisFor(sourceId: ShadowSourceId): FeeBasis {
  return PAPER_FEE_BASIS[sourceId] ?? "UNKNOWN";
}

/** Virtual holdings on one venue. Integer only. */
export type VenueBalance = {
  sourceId: ShadowSourceId;
  irtToman: number;
  usdtMicros: number;
};

export type PaperRejectionCode =
  | "same_venue"
  | "venue_not_executable"
  | "fee_unknown"
  | "fee_basis_unknown"
  | "stale_market_data"
  | "insufficient_depth"
  | "not_net_positive"
  | "insufficient_irt"
  | "insufficient_usdt"
  | "negative_balance_guard"
  | "no_balance_record";

export const PAPER_REJECTION_FA: Record<PaperRejectionCode, string> = {
  same_venue: "خرید و فروش روی یک صرافی",
  venue_not_executable: "صرافی اجراپذیر نیست (حساب یا کارمزد)",
  fee_unknown: "کارمزد تأییدنشده",
  fee_basis_unknown: "واحد کارمزد نامشخص است",
  stale_market_data: "دادهٔ بازار کهنه است",
  insufficient_depth: "عمق دفتر برای این حجم کافی نیست",
  not_net_positive: "سود خالص پس از کارمزد و بافر مثبت نیست",
  insufficient_irt: "موجودی تومانی صرافی خرید کافی نیست",
  insufficient_usdt: "موجودی تتری صرافی فروش کافی نیست",
  negative_balance_guard: "این معامله موجودی را منفی می‌کرد",
  no_balance_record: "برای این صرافی موجودی مجازی ثبت نشده است"
};

/** What one simulated leg would do to a venue's balances. */
export type LegPlan = {
  sourceId: ShadowSourceId;
  side: "BUY" | "SELL";
  vwapToman: number;
  sizeUsdt: number;
  notionalToman: number;
  feeBasis: FeeBasis;
  feeBps: number;
  feeToman: number;
  feeUsdtMicros: number;
  /** Signed deltas applied to this venue if the whole fill commits. */
  deltaIrtToman: number;
  deltaUsdtMicros: number;
};

export type FillInputs = {
  buySourceId: ShadowSourceId;
  sellSourceId: ShadowSourceId;
  sizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buyFeeBasis: FeeBasis;
  sellFeeBasis: FeeBasis;
  /** Reported conservatism, not a cash movement. */
  slippageBufferToman: number;
};

export type FillRejection = {
  ok: false;
  code: PaperRejectionCode;
  reasonFa: string;
  /** Present for inventory rejections: what a rebalance would have to move. */
  requiredRebalance: {
    sourceId: ShadowSourceId;
    irtTomanShort: number;
    usdtMicrosShort: number;
  } | null;
};

export type FillPlan = {
  ok: true;
  buyLeg: LegPlan;
  sellLeg: LegPlan;
  grossSpreadToman: number;
  totalFeeToman: number;
  totalFeeUsdtMicros: number;
  slippageBufferToman: number;
  /** Cash result of the round trip: toman in minus toman out. */
  netPnlToman: number;
  /** Net after subtracting the reported (non-cash) slippage buffer. */
  netPnlAfterBufferToman: number;
  /** USDT the round trip left behind on the buy venue, in micros. */
  usdtDriftMicros: number;
};

function reject(
  code: PaperRejectionCode,
  requiredRebalance: FillRejection["requiredRebalance"] = null
): FillRejection {
  return { ok: false, code, reasonFa: PAPER_REJECTION_FA[code], requiredRebalance };
}

/**
 * Buy leg: pay toman, receive USDT.
 * QUOTE_IRT adds the fee to what is paid; BASE_USDT takes it out of what arrives.
 */
function planBuyLeg(
  sourceId: ShadowSourceId,
  vwapToman: number,
  sizeUsdt: number,
  feeBps: number,
  feeBasis: FeeBasis
): LegPlan {
  const notionalToman = mulPriceSizeToman(vwapToman, sizeUsdt);
  const sizeMicros = usdtToMicros(sizeUsdt);
  let feeToman = 0;
  let feeUsdtMicros = 0;
  let deltaIrtToman: number;
  let deltaUsdtMicros: number;

  if (feeBasis === "BASE_USDT") {
    feeUsdtMicros = Math.round((sizeMicros * feeBps) / 10_000);
    deltaIrtToman = -notionalToman;
    deltaUsdtMicros = sizeMicros - feeUsdtMicros;
  } else {
    feeToman = feeFromBps(notionalToman, feeBps);
    deltaIrtToman = -(notionalToman + feeToman);
    deltaUsdtMicros = sizeMicros;
  }

  return {
    sourceId,
    side: "BUY",
    vwapToman,
    sizeUsdt,
    notionalToman,
    feeBasis,
    feeBps,
    feeToman,
    feeUsdtMicros,
    deltaIrtToman,
    deltaUsdtMicros
  };
}

/**
 * Sell leg: pay USDT, receive toman.
 * QUOTE_IRT takes the fee out of the proceeds; BASE_USDT adds it to what is sold.
 */
function planSellLeg(
  sourceId: ShadowSourceId,
  vwapToman: number,
  sizeUsdt: number,
  feeBps: number,
  feeBasis: FeeBasis
): LegPlan {
  const notionalToman = mulPriceSizeToman(vwapToman, sizeUsdt);
  const sizeMicros = usdtToMicros(sizeUsdt);
  let feeToman = 0;
  let feeUsdtMicros = 0;
  let deltaIrtToman: number;
  let deltaUsdtMicros: number;

  if (feeBasis === "BASE_USDT") {
    feeUsdtMicros = Math.round((sizeMicros * feeBps) / 10_000);
    deltaUsdtMicros = -(sizeMicros + feeUsdtMicros);
    deltaIrtToman = notionalToman;
  } else {
    feeToman = feeFromBps(notionalToman, feeBps);
    deltaUsdtMicros = -sizeMicros;
    deltaIrtToman = notionalToman - feeToman;
  }

  return {
    sourceId,
    side: "SELL",
    vwapToman,
    sizeUsdt,
    notionalToman,
    feeBasis,
    feeBps,
    feeToman,
    feeUsdtMicros,
    deltaIrtToman,
    deltaUsdtMicros
  };
}

/**
 * Price both legs and decide whether the round trip is worth simulating.
 * Returns a plan or a rejection; it never touches balances.
 */
export function planFill(input: FillInputs): FillPlan | FillRejection {
  if (input.buySourceId === input.sellSourceId) return reject("same_venue");
  if (input.buyFeeBps === null || input.sellFeeBps === null) return reject("fee_unknown");
  if (input.buyFeeBasis === "UNKNOWN" || input.sellFeeBasis === "UNKNOWN") {
    return reject("fee_basis_unknown");
  }
  if (
    !Number.isFinite(input.buyVwapToman) ||
    !Number.isFinite(input.sellVwapToman) ||
    input.buyVwapToman <= 0 ||
    input.sellVwapToman <= 0 ||
    input.sizeUsdt <= 0
  ) {
    return reject("insufficient_depth");
  }

  const buyLeg = planBuyLeg(
    input.buySourceId,
    input.buyVwapToman,
    input.sizeUsdt,
    input.buyFeeBps,
    input.buyFeeBasis
  );
  const sellLeg = planSellLeg(
    input.sellSourceId,
    input.sellVwapToman,
    input.sizeUsdt,
    input.sellFeeBps,
    input.sellFeeBasis
  );

  const grossSpreadToman = sellLeg.notionalToman - buyLeg.notionalToman;
  const netPnlToman = buyLeg.deltaIrtToman + sellLeg.deltaIrtToman;
  const slippageBufferToman = Math.max(0, Math.round(input.slippageBufferToman));
  const netPnlAfterBufferToman = netPnlToman - slippageBufferToman;

  if (netPnlAfterBufferToman <= 0) return reject("not_net_positive");

  return {
    ok: true,
    buyLeg,
    sellLeg,
    grossSpreadToman,
    totalFeeToman: buyLeg.feeToman + sellLeg.feeToman,
    totalFeeUsdtMicros: buyLeg.feeUsdtMicros + sellLeg.feeUsdtMicros,
    slippageBufferToman,
    netPnlToman,
    netPnlAfterBufferToman,
    usdtDriftMicros: buyLeg.deltaUsdtMicros + sellLeg.deltaUsdtMicros
  };
}

export type AppliedFill = {
  ok: true;
  plan: FillPlan;
  /** Only the two venues the fill touches, with their post-fill balances. */
  balancesAfter: VenueBalance[];
};

/**
 * Apply a plan to the virtual book, all-or-nothing.
 *
 * Both legs are checked against real balances before anything is written. If
 * either would go negative, the function returns a rejection and the caller's
 * balances are left completely unchanged — the input array is never mutated.
 */
export function applyFill(
  plan: FillPlan,
  balances: VenueBalance[]
): AppliedFill | FillRejection {
  const buy = balances.find((b) => b.sourceId === plan.buyLeg.sourceId);
  const sell = balances.find((b) => b.sourceId === plan.sellLeg.sourceId);
  if (!buy || !sell) return reject("no_balance_record");

  const buyIrtAfter = buy.irtToman + plan.buyLeg.deltaIrtToman;
  const sellUsdtAfter = sell.usdtMicros + plan.sellLeg.deltaUsdtMicros;

  if (buyIrtAfter < 0) {
    return reject("insufficient_irt", {
      sourceId: buy.sourceId,
      irtTomanShort: -buyIrtAfter,
      usdtMicrosShort: 0
    });
  }
  if (sellUsdtAfter < 0) {
    return reject("insufficient_usdt", {
      sourceId: sell.sourceId,
      irtTomanShort: 0,
      usdtMicrosShort: -sellUsdtAfter
    });
  }

  // Copy first: a rejection below must leave the caller's book untouched.
  const nextBuy: VenueBalance = {
    sourceId: buy.sourceId,
    irtToman: buyIrtAfter,
    usdtMicros: buy.usdtMicros + plan.buyLeg.deltaUsdtMicros
  };
  const nextSell: VenueBalance = {
    sourceId: sell.sourceId,
    irtToman: sell.irtToman + plan.sellLeg.deltaIrtToman,
    usdtMicros: sellUsdtAfter
  };

  // Final guard — no balance may end negative on either axis.
  for (const b of [nextBuy, nextSell]) {
    if (b.irtToman < 0 || b.usdtMicros < 0) return reject("negative_balance_guard");
  }

  return { ok: true, plan, balancesAfter: [nextBuy, nextSell] };
}

/** Total virtual portfolio value, for conservation checks and drift reporting. */
export function portfolioValueToman(balances: VenueBalance[], valuationPriceToman: number): number {
  return balances.reduce(
    (sum, b) => sum + b.irtToman + mulPriceSizeToman(valuationPriceToman, microsToUsdt(b.usdtMicros)),
    0
  );
}
