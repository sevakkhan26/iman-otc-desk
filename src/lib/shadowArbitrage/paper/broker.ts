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

/** Which asset a fee is actually settled in. */
export type FeeAsset = "IRT" | "USDT" | "UNKNOWN";

/**
 * How the fee moves relative to the leg.
 *  ADD_TO_DEBIT        — the fee increases what this side pays.
 *  DEDUCT_FROM_CREDIT  — the fee reduces what this side receives.
 *  UNKNOWN             — not established; execution is blocked, never guessed.
 */
export type FeeDebitMode = "ADD_TO_DEBIT" | "DEDUCT_FROM_CREDIT" | "UNKNOWN";

/** How one venue settles the fee on one side of a trade. */
export type SideSettlement = {
  feeAsset: FeeAsset;
  debitMode: FeeDebitMode;
  /** Only ADMIN_CONFIRMED settlement may execute. */
  provenance: "ADMIN_CONFIRMED" | "UNKNOWN";
};

export type VenueSettlement = {
  buy: SideSettlement;
  sell: SideSettlement;
};

const UNKNOWN_SIDE: SideSettlement = {
  feeAsset: "UNKNOWN",
  debitMode: "UNKNOWN",
  provenance: "UNKNOWN"
};

const UNKNOWN_VENUE: VenueSettlement = { buy: UNKNOWN_SIDE, sell: UNKNOWN_SIDE };

/**
 * Admin-confirmed settlement for the venues the desk holds accounts on.
 *
 * Buying USDT with IRT settles the fee in IRT on top of the cost, and the full
 * purchased quantity arrives. Selling USDT for IRT settles the fee in USDT on
 * top of the quantity sold, and the full proceeds arrive. The two sides are
 * therefore NOT the same currency, which is why settlement is stored per venue
 * and per side rather than as one global fee currency.
 */
const CONFIRMED_MIXED: VenueSettlement = {
  buy: { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" },
  sell: { feeAsset: "USDT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" }
};

/**
 * Settlement per venue. A venue without a verified account has no confirmed
 * settlement on either side and can never execute.
 */
export const PAPER_FEE_SETTLEMENT: Record<ShadowSourceId, VenueSettlement> = {
  nobitex: CONFIRMED_MIXED,
  wallex: CONFIRMED_MIXED,
  tabdeal: CONFIRMED_MIXED,
  bitpin: UNKNOWN_VENUE,
  abantether: UNKNOWN_VENUE,
  ramzinex: UNKNOWN_VENUE,
  tetherland: UNKNOWN_VENUE,
  bit24: UNKNOWN_VENUE,
  arzinja: UNKNOWN_VENUE
};

/** Settlement for one side of one venue. UNKNOWN when never confirmed. */
export function settlementFor(sourceId: ShadowSourceId, side: "buy" | "sell"): SideSettlement {
  return (PAPER_FEE_SETTLEMENT[sourceId] ?? UNKNOWN_VENUE)[side];
}

export function settlementUsable(s: SideSettlement): boolean {
  return s.provenance === "ADMIN_CONFIRMED" && s.feeAsset !== "UNKNOWN" && s.debitMode !== "UNKNOWN";
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
  | "fee_settlement_unknown"
  | "fee_settlement_unsupported"
  | "stale_market_data"
  | "insufficient_depth"
  | "not_net_positive"
  | "insufficient_irt"
  | "insufficient_usdt"
  | "negative_balance_guard"
  | "no_balance_record"
  | "mark_price_unavailable";

export const PAPER_REJECTION_FA: Record<PaperRejectionCode, string> = {
  same_venue: "خرید و فروش روی یک صرافی",
  venue_not_executable: "صرافی اجراپذیر نیست (حساب یا کارمزد)",
  fee_unknown: "کارمزد تأییدنشده",
  fee_settlement_unknown: "نحوهٔ تسویهٔ کارمزد (دارایی و سمت) تأیید نشده است",
  fee_settlement_unsupported: "ترکیب دارایی و نحوهٔ کسر کارمزد برای این سمت معنا ندارد",
  stale_market_data: "دادهٔ بازار کهنه است",
  insufficient_depth: "عمق دفتر برای این حجم کافی نیست",
  not_net_positive: "سود خالص پس از کارمزد و بافر مثبت نیست",
  insufficient_irt: "موجودی تومانی صرافی خرید کافی نیست",
  insufficient_usdt: "موجودی تتری صرافی فروش کافی نیست",
  negative_balance_guard: "این معامله موجودی را منفی می‌کرد",
  no_balance_record: "برای این صرافی موجودی مجازی ثبت نشده است",
  mark_price_unavailable: "قیمت مرجع تتر در همین چرخه در دسترس یا تازه نیست"
};

/** What one simulated leg would do to a venue's balances. */
export type LegPlan = {
  sourceId: ShadowSourceId;
  side: "BUY" | "SELL";
  vwapToman: number;
  sizeUsdt: number;
  notionalToman: number;
  settlement: SideSettlement;
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
  buySettlement: SideSettlement;
  sellSettlement: SideSettlement;
  /**
   * Same-cycle deterministic mark / replacement price for USDT, in toman.
   *
   * Documented rule: it is the executable buy VWAP for this size on the buy
   * venue in THIS cycle — literally what the desk paid to acquire USDT moments
   * ago, so it is the honest replacement cost of the USDT the sell fee consumed.
   * Null when the cycle cannot supply it; the fill is then blocked rather than
   * priced against a guess.
   */
  markPriceToman: number | null;
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
  /** Mark price actually used to value the USDT fee. */
  markPriceToman: number;
  /**
   * Cash movement only: sell proceeds − buy cost − buy fee in IRT.
   * This is NOT economic profit — the USDT fee is invisible to it.
   */
  cashPnlIrtToman: number;
  /** Change in total USDT holdings, in micros. Negative: the sell fee. */
  inventoryDeltaUsdtMicros: number;
  /** Toman value of the USDT fee at the mark price. */
  sellFeeValueToman: number;
  /** cashPnlIrt − sellFeeValueToman. The real result of the round trip. */
  economicNetPnlToman: number;
  /** economicNetPnl − slippage/risk buffer. The execution gate uses this. */
  riskAdjustedPnlToman: number;
};

function reject(
  code: PaperRejectionCode,
  requiredRebalance: FillRejection["requiredRebalance"] = null
): FillRejection {
  return { ok: false, code, reasonFa: PAPER_REJECTION_FA[code], requiredRebalance };
}

/**
 * Is this settlement coherent for the side it is applied to?
 *
 * A fee can only be ADDED to the debit when it is denominated in the asset that
 * side actually pays; otherwise it has to come out of the credit. Anything else
 * is not a settlement rule the broker will guess at.
 */
export function settlementCoherent(s: SideSettlement, side: "buy" | "sell"): boolean {
  const debitAsset = side === "buy" ? "IRT" : "USDT";
  return s.debitMode === "ADD_TO_DEBIT" ? s.feeAsset === debitAsset : s.feeAsset !== debitAsset;
}

/**
 * Buy leg: pay toman, receive USDT.
 *
 * Confirmed rule: the fee settles in IRT and is added to the debit, so the IRT
 * debit is cost + fee and the FULL purchased quantity is credited.
 */
function planBuyLeg(
  sourceId: ShadowSourceId,
  vwapToman: number,
  sizeUsdt: number,
  feeBps: number,
  settlement: SideSettlement
): LegPlan {
  const notionalToman = mulPriceSizeToman(vwapToman, sizeUsdt);
  const sizeMicros = usdtToMicros(sizeUsdt);
  let feeToman = 0;
  let feeUsdtMicros = 0;
  let deltaIrtToman: number;
  let deltaUsdtMicros: number;

  if (settlement.feeAsset === "IRT") {
    feeToman = feeFromBps(notionalToman, feeBps);
    deltaIrtToman = -(notionalToman + feeToman);
    deltaUsdtMicros = sizeMicros;
  } else {
    // USDT fee on a buy can only come out of what arrives.
    feeUsdtMicros = Math.round((sizeMicros * feeBps) / 10_000);
    deltaIrtToman = -notionalToman;
    deltaUsdtMicros = sizeMicros - feeUsdtMicros;
  }

  return {
    sourceId,
    side: "BUY",
    vwapToman,
    sizeUsdt,
    notionalToman,
    settlement,
    feeBps,
    feeToman,
    feeUsdtMicros,
    deltaIrtToman,
    deltaUsdtMicros
  };
}

/**
 * Sell leg: pay USDT, receive toman.
 *
 * Under the confirmed rule the fee settles in USDT and is ADDED to the debit —
 * the venue takes quantity plus fee — and the full IRT proceeds are credited.
 * The venue must therefore hold quantity + fee, not just quantity.
 */
function planSellLeg(
  sourceId: ShadowSourceId,
  vwapToman: number,
  sizeUsdt: number,
  feeBps: number,
  settlement: SideSettlement
): LegPlan {
  const notionalToman = mulPriceSizeToman(vwapToman, sizeUsdt);
  const sizeMicros = usdtToMicros(sizeUsdt);
  let feeToman = 0;
  let feeUsdtMicros = 0;
  let deltaIrtToman = notionalToman;
  let deltaUsdtMicros = -sizeMicros;

  if (settlement.feeAsset === "USDT") {
    feeUsdtMicros = Math.round((sizeMicros * feeBps) / 10_000);
    deltaUsdtMicros = -(sizeMicros + feeUsdtMicros);
  } else if (settlement.feeAsset === "IRT") {
    feeToman = feeFromBps(notionalToman, feeBps);
    deltaIrtToman = notionalToman - feeToman;
  }

  return {
    sourceId,
    side: "SELL",
    vwapToman,
    sizeUsdt,
    notionalToman,
    settlement,
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
  // Settlement must be admin-confirmed on BOTH sides; unknown venues are blocked.
  if (!settlementUsable(input.buySettlement) || !settlementUsable(input.sellSettlement)) {
    return reject("fee_settlement_unknown");
  }
  if (
    !settlementCoherent(input.buySettlement, "buy") ||
    !settlementCoherent(input.sellSettlement, "sell")
  ) {
    return reject("fee_settlement_unsupported");
  }
  // A missing or non-positive mark price means the USDT fee cannot be valued.
  if (input.markPriceToman === null || !Number.isFinite(input.markPriceToman) || input.markPriceToman <= 0) {
    return reject("mark_price_unavailable");
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
    input.buySettlement
  );
  const sellLeg = planSellLeg(
    input.sellSourceId,
    input.sellVwapToman,
    input.sizeUsdt,
    input.sellFeeBps,
    input.sellSettlement
  );

  const grossSpreadToman = sellLeg.notionalToman - buyLeg.notionalToman;

  // Cash only. The USDT the sell fee consumed never appears in this number,
  // which is exactly why it must not be the execution gate on its own.
  const cashPnlIrtToman = buyLeg.deltaIrtToman + sellLeg.deltaIrtToman;
  const inventoryDeltaUsdtMicros = buyLeg.deltaUsdtMicros + sellLeg.deltaUsdtMicros;

  const markPriceToman = Math.round(input.markPriceToman);
  const totalFeeUsdtMicros = buyLeg.feeUsdtMicros + sellLeg.feeUsdtMicros;
  const sellFeeValueToman = mulPriceSizeToman(markPriceToman, microsToUsdt(totalFeeUsdtMicros));

  const economicNetPnlToman = cashPnlIrtToman - sellFeeValueToman;
  const slippageBufferToman = Math.max(0, Math.round(input.slippageBufferToman));
  const riskAdjustedPnlToman = economicNetPnlToman - slippageBufferToman;

  // The gate is risk-adjusted economic profit, never cash PnL.
  if (riskAdjustedPnlToman <= 0) return reject("not_net_positive");

  return {
    ok: true,
    buyLeg,
    sellLeg,
    grossSpreadToman,
    totalFeeToman: buyLeg.feeToman + sellLeg.feeToman,
    totalFeeUsdtMicros,
    slippageBufferToman,
    markPriceToman,
    cashPnlIrtToman,
    inventoryDeltaUsdtMicros,
    sellFeeValueToman,
    economicNetPnlToman,
    riskAdjustedPnlToman
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

/**
 * Independent reconciliation of the two ledgers.
 *
 * The assets do not net against each other, so each is checked on its own:
 *  - IRT: the change equals the gross spread minus the buy-side IRT fee, which
 *    is exactly the sum of the fills' net PnL;
 *  - USDT: the change equals minus the sell-side USDT fee, because the buy
 *    credits the full quantity and the sell debits quantity plus fee.
 */
export function reconcilePaperLedgers(
  before: VenueBalance[],
  after: VenueBalance[],
  plans: FillPlan[]
): {
  irtBalanced: boolean;
  usdtBalanced: boolean;
  irtDelta: number;
  usdtMicrosDelta: number;
  expectedIrtDelta: number;
  expectedUsdtMicrosDelta: number;
} {
  const sumIrt = (b: VenueBalance[]) => b.reduce((s, x) => s + x.irtToman, 0);
  const sumUsdt = (b: VenueBalance[]) => b.reduce((s, x) => s + x.usdtMicros, 0);

  const irtDelta = sumIrt(after) - sumIrt(before);
  const usdtMicrosDelta = sumUsdt(after) - sumUsdt(before);

  const expectedIrtDelta = plans.reduce((s, p) => s + p.cashPnlIrtToman, 0);
  const expectedUsdtMicrosDelta = plans.reduce((s, p) => s + p.inventoryDeltaUsdtMicros, 0);

  return {
    irtBalanced: irtDelta === expectedIrtDelta,
    usdtBalanced: usdtMicrosDelta === expectedUsdtMicrosDelta,
    irtDelta,
    usdtMicrosDelta,
    expectedIrtDelta,
    expectedUsdtMicrosDelta
  };
}
