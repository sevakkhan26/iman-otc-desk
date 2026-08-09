/**
 * Capital-aware position sizing for PAPER execution.
 *
 * finalSize = min(capital/balance limits, full slippage-bounded depth, order
 * cap, venue exposure, allocation share) then validated for positive risk-
 * adjusted net after both-leg fees and slippage. Analysis probes are fractions
 * of that max only. The fixed 5/10/20/25 ladder is never an execution cap.
 *
 * The decision flow, in order:
 *
 *   1. POLICIES — every required risk policy must be set and unexpired.
 *   2. EVIDENCE — healthy, fresh, two-sided books; confirmed fees/settlement.
 *   3. USABLE BALANCE — fee-inclusive capacity net of reservations this cycle.
 *   4. SAFE MAX — min of balance, full depth, order/venue/allocation caps.
 *   5. CANDIDATES — adaptive densified breakpoints (not percentage probes alone).
 *   6. EVALUATION — walk BOTH books (multi-level VWAP); inventory; edge floor.
 *   7. SELECTION — largest eligible (profitable) size; never force utilization.
 *   8. EXPLANATION — exact winning limiter and full persisted sizing audit.
 *
 * Two rules make the result trustworthy rather than merely plausible:
 *
 * NO INVENTED LIMITS. Every risk value comes from an administrator-approved
 * policy. A missing, expired or invalid policy produces `size = null`, status
 * `BLOCKED` and the exact policy key — never a "sensible default". A default
 * risk limit is a limit nobody reviewed, and it would make an unapproved system
 * look ready.
 *
 * NO EXTRAPOLATION. Every price comes from walking real levels. A quantity that
 * does not fill completely on both legs is not a smaller trade, it is a trade
 * the book cannot support, and it is rejected rather than shrunk.
 *
 * Pure module: no database, no network, no clock of its own. It computes and
 * explains; it never executes. Nothing here can place an order, move funds, or
 * touch a credential.
 */
import { feeFromBps, mulPriceSizeToman } from "@/lib/shadowArbitrage/money";
import {
  microsToUsdt,
  settlementUsable,
  usdtToMicros,
  type SideSettlement,
  type VenueBalance
} from "@/lib/shadowArbitrage/paper/broker";
import { policyValueOrNull, type RiskPolicyKey, type RiskPolicyState } from "@/lib/shadowArbitrage/live/policy";
import {
  assessInventory,
  type InventoryAssessment,
  type InventoryModel
} from "@/lib/shadowArbitrage/paper/inventory";
import {
  BASELINE_FIXED_SIZES_USDT,
  BASELINE_POLICY,
  buildSmartCandidates,
  CANDIDATE_PERCENTS,
  CAPITAL_CAP_PERCENT,
  DEPTH_CAP_PERCENT,
  LEDGER_SIZE_QUANTUM_MICROS,
  MIN_EXECUTABLE_USDT_MICROS,
  slippageBoundedDepth,
  SMART_SIZING_POLICY,
  type SmartCandidateSet
} from "@/lib/shadowArbitrage/paper/smartCandidates";
import {
  PAPER_POLICY_MIN_KEY,
  PAPER_POLICY_MIN_USDT,
  PAPER_POLICY_MIN_USDT_MICROS,
  resolvePaperRouteFloor,
  type VenueExecutionLimit
} from "@/lib/shadowArbitrage/paper/venueExecutionLimits";
import {
  buyIrtCapacityMicros,
  executableLadder,
  orderedLevels,
  sellUsdtCapacityMicros,
  tomanCeilingMicros,
  totalDepthMicros,
  walkBook,
  type BookSide,
  type BookWalk,
  type QuoteCapacityInput
} from "@/lib/shadowArbitrage/paper/liquidity";
import type { BookLevel, NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";

export {
  BASELINE_FIXED_SIZES_USDT,
  BASELINE_POLICY,
  CANDIDATE_PERCENTS,
  CAPITAL_CAP_PERCENT,
  DEPTH_CAP_PERCENT,
  LEDGER_SIZE_QUANTUM_MICROS,
  MIN_EXECUTABLE_USDT_MICROS,
  SMART_SIZING_POLICY
};

export {
  PAPER_POLICY_MIN_KEY,
  PAPER_POLICY_MIN_USDT,
  PAPER_POLICY_MIN_USDT_MICROS
};

/**
 * The policies sizing cannot proceed without.
 *
 * Each one bounds the calculation somewhere: the order cap and the exposure cap
 * bound the size directly, the freshness budget decides whether the quote may be
 * used at all, the slippage ceiling decides both the acceptable buffer and which
 * book levels count as executable depth, the inventory band decides whether the
 * resulting position is one the desk is allowed to hold, and the edge floor
 * decides whether the result is worth executing.
 */
export const SIZING_REQUIRED_POLICIES: RiskPolicyKey[] = [
  "max_order_size_usdt",
  "max_venue_exposure_percent",
  "min_risk_adjusted_edge_percent",
  "max_quote_age_ms",
  "max_slippage_bps",
  "max_inventory_deviation_percent"
];

export type SizingConstraintKey =
  | "capital_cap"
  | "depth_cap"
  | "depth_evidence"
  | "buy_irt_balance"
  | "sell_usdt_balance"
  | "venue_allocation"
  | "policy_max_order_size"
  | "venue_concentration";

export const SIZING_CONSTRAINT_FA: Record<SizingConstraintKey, string> = {
  capital_cap: "سقف سرمایه/ظرفیت قابل استفادهٔ سمت محدودکننده (پس از کارمزد)",
  depth_cap: "عمق اجراپذیر هر پا در محدودهٔ لغزش مجاز (چندسطحی VWAP)",
  depth_evidence: "عمق اثبات‌شدهٔ دفتر در همین چرخه",
  buy_irt_balance: "موجودی تومانی صرافی خرید (با احتساب کارمزد)",
  sell_usdt_balance: "موجودی تتری صرافی فروش (با احتساب کارمزد)",
  venue_allocation: "سهم این صرافی در طرح سرمایه",
  policy_max_order_size: "سقف حجم هر سفارش (سیاست ریسک)",
  venue_concentration: "سقف تمرکز روی یک صرافی (سیاست ریسک)"
};

/** One cap, in integer USDT micros. `null` means the cap could not be measured. */
export type SizingConstraint = {
  key: SizingConstraintKey;
  labelFa: string;
  capUsdtMicros: number | null;
  /** Why this cap has the value it has, in one line. */
  detailFa: string;
};

export type SizingBlockerCode =
  | "missing_policy"
  | "expired_policy"
  | "stale_quote"
  | "no_depth_evidence"
  | "fee_unconfirmed"
  | "settlement_unconfirmed"
  | "no_balance_record"
  | "slippage_over_limit"
  | "size_floor"
  | "venue_min_unknown"
  | "edge_below_floor"
  | "not_net_positive"
  | "book_invalid"
  | "quote_only_no_order_book"
  | "depth_exhausted"
  | "inventory_unmeasurable"
  | "inventory_limit";

export const SIZING_BLOCKER_FA: Record<SizingBlockerCode, string> = {
  missing_policy: "سیاست ریسک تعیین نشده است",
  expired_policy: "اعتبار سیاست ریسک منقضی شده است",
  stale_quote: "دادهٔ بازار از بودجهٔ تازگی عبور کرده است",
  no_depth_evidence: "این چرخه هیچ عمق اجراپذیری برای هر دو سمت اثبات نکرد",
  fee_unconfirmed: "کارمزد تأییدشدهٔ یکی از دو سمت در دسترس نیست",
  settlement_unconfirmed: "نحوهٔ تسویهٔ کارمزد تأیید نشده است",
  no_balance_record: "برای یکی از دو صرافی موجودی مجازی ثبت نشده است",
  slippage_over_limit: "بافر لغزش مدل‌شده از سقف مجاز بیشتر است",
  size_floor: "ظرفیت قابل استفاده به حداقل سیاست کاغذی (paper_policy_min) یا حداقل تأییدشدهٔ صرافی نمی‌رسد",
  /**
   * Not used to block Paper. Kept for LIVE readiness reporting / older audits.
   * Unknown venue mins must block future live execution, not Paper simulation.
   */
  venue_min_unknown:
    "حداقل حجم/گام اجرا برای یکی از دو صرافی تأیید نشده است (فقط LIVE — شبیه‌سازی کاغذی با paper_policy_min ادامه می‌دهد)",
  edge_below_floor: "حاشیهٔ تعدیل‌شده از کف سیاست کمتر است",
  not_net_positive: "سود تعدیل‌شده اکیداً مثبت نیست",
  book_invalid: "دفتر سفارش قابل استفاده نیست",
  quote_only_no_order_book: "منبع نقل‌قول تک‌قیمتی است و دفتر سفارش ندارد",
  depth_exhausted: "عمق مشاهده‌شده برای هیچ حجم قابل قبولی کافی نیست",
  inventory_unmeasurable: "انحراف موجودی قابل اندازه‌گیری نیست",
  inventory_limit: "هیچ حجمی بدون عبور از باند موجودی ممکن نیست"
};

export type SizingBlocker = {
  code: SizingBlockerCode;
  /** The exact thing that is missing or wrong — a key, a number, a venue. */
  subject: string;
  detailFa: string;
};

/**
 * Why one candidate quantity is not the answer.
 *
 * These are the codes the ledger persists next to a fill, so an operator can
 * ask "why not bigger?" months later and get the same answer the engine gave.
 *
 * A stale source or an unconfirmed fee is deliberately NOT in this list. Those
 * are properties of the ROUTE, not of a quantity: they stop every candidate at
 * once and are already reported as `stale_quote` and `fee_unconfirmed` in
 * `SizingBlockerCode`. Giving them a second name here would mean the same fact
 * had two vocabularies, and a query filtering on one would silently miss the
 * other.
 */
export type CandidateRejectionCode =
  | "insufficient_balance"
  | "insufficient_depth"
  | "excessive_slippage"
  | "inventory_limit"
  | "lower_risk_adjusted_pnl"
  | "negative_marginal_profitability"
  | "not_net_positive"
  | "edge_below_floor"
  | "below_min_size";

export const CANDIDATE_REJECTION_FA: Record<CandidateRejectionCode, string> = {
  insufficient_balance: "موجودی آزاد برای این حجم کافی نیست",
  insufficient_depth: "عمق دفتر برای پر شدن کامل هر دو پا کافی نیست",
  excessive_slippage: "لغزش این حجم از سقف مجاز سیاست بیشتر است",
  inventory_limit: "این حجم موجودی یکی از دو صرافی را از باند مجاز خارج می‌کند",
  lower_risk_adjusted_pnl: "سود تعدیل‌شدهٔ کمتری نسبت به حجم انتخاب‌شده دارد",
  negative_marginal_profitability: "هر تتر اضافه در این حجم سود را کم می‌کند",
  not_net_positive: "سود تعدیل‌شده در این حجم مثبت نیست",
  edge_below_floor: "حاشیهٔ تعدیل‌شده در این حجم از کف سیاست کمتر است",
  below_min_size: "کمتر از paper_policy_min یا حداقل تأییدشدهٔ صرافی است"
};

/** Every figure the detail view shows, all integers unless noted. */
export type SizingEconomics = {
  capitalInvolvedToman: number;
  cashPnlIrtToman: number;
  /** Net change in total USDT holdings, in micros. Negative: fees consumed it. */
  inventoryDeltaUsdtMicros: number;
  sellFeeValueToman: number;
  economicNetPnlToman: number;
  slippageBufferToman: number;
  riskAdjustedPnlToman: number;
  /** riskAdjustedPnl ÷ capitalInvolved, in percent. */
  riskAdjustedEdgePercent: number;
  /** The same ratio in basis points — the unit the risk policies speak in. */
  riskAdjustedReturnBps: number;
};

export type SizingQuote = {
  /** Executable VWAP for the CHOSEN quantity, walked over the real book. */
  buyVwapToman: number;
  sellVwapToman: number;
  markPriceToman: number;
  buyAgeMs: number;
  sellAgeMs: number;
  /** The child-fill ladder each leg would consume. */
  buyWalk: BookWalk;
  sellWalk: BookWalk;
  /** Realized adverse VWAP deviation per leg, in bps. */
  buySlippageBps: number;
  sellSlippageBps: number;
};

/** One evaluated quantity on the route's profit curve. */
export type SizingCandidate = {
  sizeUsdtMicros: number;
  /** Which percentage rung produced it, when one did. Null for the ceiling. */
  percentOfUsable: number | null;
  buyVwapToman: number;
  sellVwapToman: number;
  riskAdjustedPnlToman: number;
  economicNetPnlToman: number;
  cashPnlIrtToman: number;
  sellFeeValueToman: number;
  inventoryDeltaUsdtMicros: number;
  riskAdjustedEdgePercent: number;
  riskAdjustedReturnBps: number;
  buyLevels: number;
  sellLevels: number;
  bookParticipationPercent: number;
  priceImpactPercent: number;
  /** Σ|deviation after| − Σ|deviation before|. Negative improves balance. */
  inventoryImpactPoints: number;
  eligible: boolean;
  /** Null exactly when `eligible` is true. */
  rejectionCode: CandidateRejectionCode | null;
  rejectionFa: string | null;
};

/** The old fixed ladder, priced on the same evidence. Never executable. */
export type BaselineRow = {
  sizeUsdt: number;
  fillable: boolean;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  riskAdjustedPnlToman: number | null;
  riskAdjustedReturnBps: number | null;
  reasonFa: string;
};

export type SizingBaseline = {
  policy: typeof BASELINE_POLICY;
  /** Always false. The baseline exists to be compared with, not executed. */
  executable: false;
  noteFa: string;
  rows: BaselineRow[];
  /** Best risk-adjusted PnL the fixed ladder could have produced. */
  bestRiskAdjustedPnlToman: number | null;
  bestSizeUsdt: number | null;
};

/** Why the chosen size won, and why the next one up did not. */
export type SizingSelection = {
  policy: typeof SMART_SIZING_POLICY;
  selectedSizeUsdtMicros: number;
  selectedPercentOfUsable: number | null;
  /** The rule that decided it, in one line. */
  reasonFa: string;
  /** Which tie-break, if any, actually separated the winner from a rival. */
  tieBreakFa: string | null;
  nextLarger: {
    sizeUsdtMicros: number;
    code: CandidateRejectionCode;
    detailFa: string;
    /** next.riskAdjustedPnl − selected.riskAdjustedPnl. Null when ineligible. */
    marginalPnlToman: number | null;
  } | null;
};

/**
 * Complete final sizing audit — persisted with the fill lifecycle so
 * refresh/restart cannot change the explanation.
 */
export type SizingAudit = {
  policy: typeof SMART_SIZING_POLICY;
  status: "SIZED" | "BLOCKED";
  /** All numeric hard limits considered (USDT micros unless noted). */
  limits: {
    capitalCapUsdtMicros: number | null;
    depthCapUsdtMicros: number | null;
    buyUsableUsdtMicros: number | null;
    sellUsableUsdtMicros: number | null;
    orderCapUsdtMicros: number | null;
    venueAllocationUsdtMicros: number | null;
    venueConcentrationUsdtMicros: number | null;
    /** Effective Paper floor: max(paper_policy_min, verified venue min). */
    minExecutableUsdtMicros: number;
    /** Admin-approved global Paper minimum (USDT micros). Label: paper_policy_min. */
    paperPolicyMinUsdtMicros: number;
    /**
     * Verified venue floor when both legs known; null if unknown.
     * Unknown does not block Paper — only future LIVE.
     */
    verifiedVenueMinUsdtMicros: number | null;
    /** Which floor bound the effective min: paper_policy_min | venue_min. */
    floorBinding: "paper_policy_min" | "venue_min";
    safeCeilingUsdtMicros: number | null;
  };
  safeCeilingUsdtMicros: number | null;
  finalSizeUsdtMicros: number | null;
  bindingConstraint: SizingConstraintKey | null;
  buyDepthUsdtMicros: number | null;
  sellDepthUsdtMicros: number | null;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  grossSpreadToman: number | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  predictedRiskAdjustedNetToman: number | null;
  riskAdjustedReturnBps: number | null;
  inventoryEffectPoints: number | null;
  rejectionReason: string | null;
  adaptive: {
    candidateCount: number;
    eligibleCount: number;
    executionPointCount: number | null;
    analysisPointCount: number | null;
  };
  selectionReasonFa: string | null;
};

export type SizingResult = {
  status: "SIZED" | "BLOCKED";
  /** The sizing policy in force. Recorded so a fill can never be misattributed. */
  policy: typeof SMART_SIZING_POLICY;
  /** Integer USDT micros. Null whenever status is BLOCKED. */
  sizeUsdtMicros: number | null;
  sizeUsdt: number | null;
  /** Which cap actually decided the ceiling. Null when blocked. */
  bindingConstraint: SizingConstraintKey | null;
  constraints: SizingConstraint[];
  /** The capital basis the candidate ladder was generated from. */
  capacity: {
    buyUsableMicros: number;
    sellUsableMicros: number;
    limitingUsableMicros: number;
    limitingSide: "buy" | "sell";
    limitingSourceId: string;
    capitalCapMicros: number;
    depthCapMicros: number;
    depthCapSide: "buy" | "sell";
    ceilingMicros: number;
    buyDepth: ReturnType<typeof slippageBoundedDepth>;
    sellDepth: ReturnType<typeof slippageBoundedDepth>;
    ladder: SmartCandidateSet["ladder"];
  } | null;
  /** What liquidity and balances alone would allow, before any risk policy. */
  liquidityMaxUsdtMicros: number | null;
  /** What the risk policies alone would allow, before liquidity. */
  policyMaxUsdtMicros: number | null;
  /**
   * The largest quantity every hard constraint permits — profitable or not.
   * Reported next to the chosen size so an operator can see when the optimum
   * is deliberately smaller than the maximum, which is the normal case once a
   * book is thin enough for VWAP to move against the trade.
   */
  maxFeasibleUsdtMicros: number | null;
  /** Every quantity evaluated, in ascending order. The profit curve. */
  candidates: SizingCandidate[];
  selection: SizingSelection | null;
  inventory: InventoryAssessment | null;
  baseline: SizingBaseline | null;
  quote: SizingQuote | null;
  economics: SizingEconomics | null;
  blockers: SizingBlocker[];
  /** Complete audit for lifecycle persistence (restart-stable). */
  audit: SizingAudit | null;
};

/**
 * Granularity the chosen size is floored to, in micros.
 *
 * The paper ledger stores size as `numeric(12,4)`, so a size carried to six
 * decimals would be written back rounded to four while the balances moved by
 * the unrounded amount — the ledger and the book would then disagree by a
 * fraction of a USDT on every fill, and reconciliation would drift. Flooring to
 * the ledger's own precision keeps the two exactly equal, and flooring rather
 * than rounding keeps the error on the safe side of every balance cap.
 */
export const SIZE_GRANULARITY_MICROS = 100;

/** Floor a size to the ledger's storable precision. */
export function quantizeSizeMicros(micros: number): number {
  return Math.floor(micros / SIZE_GRANULARITY_MICROS) * SIZE_GRANULARITY_MICROS;
}

export type SizingInput = {
  buySourceId: string;
  sellSourceId: string;
  buySnapshot: NormalizedSourceSnapshot | undefined;
  sellSnapshot: NormalizedSourceSnapshot | undefined;
  /** Admin-confirmed fees. Null on either side blocks. */
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buySettlement: SideSettlement;
  sellSettlement: SideSettlement;
  /**
   * Balances NET of anything already reserved this cycle.
   *
   * The caller passes the unreserved view, which is what stops two candidates
   * being sized against the same toman. Sizing itself holds nothing — it is
   * pure — but it must never be shown capacity that is already spoken for.
   */
  balances: VenueBalance[];
  /** The capital plan's toman-equivalent share for the buy venue. */
  buyVenueAllocationToman: number | null;
  /** Marked value of the whole virtual portfolio, for the concentration cap. */
  portfolioValueToman: number | null;
  /** Marked value the buy venue already holds, for the concentration cap. */
  buyVenueExposureToman: number | null;
  policies: RiskPolicyState[];
  /**
   * Latency and slippage allowance in bps, applied to the buy notional.
   *
   * Market impact is NOT in this buffer: walking the book already prices it,
   * because a bigger quantity gets a worse VWAP. The buffer covers what the
   * book cannot show — the delay between observing it and acting on it.
   */
  slippageBufferBps: number;
  /** Opening USDT shares and the deviation band. Unmeasurable inventory blocks. */
  inventoryModel: InventoryModel;
  /** Present only when the corresponding venue is an OTC dealer. */
  buyQuote?: QuoteCapacityInput;
  sellQuote?: QuoteCapacityInput;
  /**
   * Optional override map of verified venue execution limits.
   * When omitted, the process registry is used. Missing either leg does NOT
   * block Paper — effective floor falls back to paper_policy_min (5 USDT).
   * Unknown mins are recorded for LIVE readiness only.
   */
  venueExecutionLimits?: Map<string, VenueExecutionLimit>;
};

function blocker(code: SizingBlockerCode, subject: string, extraFa?: string): SizingBlocker {
  return {
    code,
    subject,
    detailFa: extraFa ? `${SIZING_BLOCKER_FA[code]} — ${extraFa}` : `${SIZING_BLOCKER_FA[code]}: ${subject}`
  };
}

function constraint(
  key: SizingConstraintKey,
  capUsdtMicros: number | null,
  detailFa: string
): SizingConstraint {
  return { key, labelFa: SIZING_CONSTRAINT_FA[key], capUsdtMicros, detailFa };
}

function usdtFa(micros: number): string {
  return (micros / 1_000_000).toFixed(4);
}

/**
 * The best price the buy side can offer, used only to turn a toman ceiling into
 * a quantity ceiling before the real walk happens.
 *
 * It is deliberately optimistic: a cap computed at the best price is never too
 * small, so no feasible quantity is excluded before it has been evaluated. The
 * walk that follows prices the quantity honestly, and the balance check after it
 * is the one that actually binds.
 */
function bestPriceToman(levels: BookLevel[] | null, side: BookSide): number | null {
  if (!levels?.length) return null;
  const ordered = orderedLevels(levels, side);
  return ordered.length ? ordered[0].priceToman : null;
}

/** Adverse deviation of a walk's VWAP from its own best price, in bps. */
function realizedSlippageBps(walk: BookWalk): number {
  if (walk.vwapToman === null || walk.bestPriceToman === null || walk.bestPriceToman <= 0) return 0;
  const raw = (Math.abs(walk.vwapToman - walk.bestPriceToman) / walk.bestPriceToman) * 10_000;
  return Math.round(raw * 100) / 100;
}

/** Signed balance movements one priced size would make, per venue. */
export type SizingDeltas = {
  buy: { sourceId: string; deltaIrtToman: number; deltaUsdtMicros: number };
  sell: { sourceId: string; deltaIrtToman: number; deltaUsdtMicros: number };
};

/**
 * Price a concrete size, reproducing the broker's leg arithmetic exactly.
 *
 * Kept separate from `planFill` on purpose: sizing has to evaluate candidate
 * sizes before committing to one, and it must not be able to move a balance
 * while doing so. The two agree by construction — same fee rules, same integer
 * rounding, same mark-price treatment — and a test pins them together.
 */
function priceAt(
  sizeUsdtMicros: number,
  quote: { buyVwapToman: number; sellVwapToman: number },
  buySourceId: string,
  sellSourceId: string,
  buyFeeBps: number,
  sellFeeBps: number,
  buySettlement: SideSettlement,
  sellSettlement: SideSettlement,
  markPriceToman: number,
  slippageBufferBps: number
): { economics: SizingEconomics; deltas: SizingDeltas } {
  const sizeUsdt = microsToUsdt(sizeUsdtMicros);
  const buyNotional = mulPriceSizeToman(quote.buyVwapToman, sizeUsdt);
  const sellNotional = mulPriceSizeToman(quote.sellVwapToman, sizeUsdt);

  let buyFeeToman = 0;
  let buyFeeUsdtMicros = 0;
  if (buySettlement.feeAsset === "IRT") buyFeeToman = feeFromBps(buyNotional, buyFeeBps);
  else buyFeeUsdtMicros = Math.round((sizeUsdtMicros * buyFeeBps) / 10_000);

  let sellFeeToman = 0;
  let sellFeeUsdtMicros = 0;
  if (sellSettlement.feeAsset === "USDT") {
    sellFeeUsdtMicros = Math.round((sizeUsdtMicros * sellFeeBps) / 10_000);
  } else if (sellSettlement.feeAsset === "IRT") {
    sellFeeToman = feeFromBps(sellNotional, sellFeeBps);
  }

  // Cash only — the USDT the fees consumed is invisible here, which is exactly
  // why it must not be the gate on its own.
  const cashPnlIrtToman = -(buyNotional + buyFeeToman) + (sellNotional - sellFeeToman);
  const feeUsdtMicrosTotal = buyFeeUsdtMicros + sellFeeUsdtMicros;
  const sellFeeValueToman = mulPriceSizeToman(markPriceToman, microsToUsdt(feeUsdtMicrosTotal));

  const economicNetPnlToman = cashPnlIrtToman - sellFeeValueToman;
  const slippageBufferToman = feeFromBps(buyNotional, slippageBufferBps);
  const riskAdjustedPnlToman = economicNetPnlToman - slippageBufferToman;
  const capitalInvolvedToman = buyNotional + buyFeeToman;

  // Same movements the broker's legs produce, so a candidate's inventory effect
  // is measured against exactly what a fill at that size would do.
  const deltas: SizingDeltas = {
    buy: {
      sourceId: buySourceId,
      deltaIrtToman: -(buyNotional + buyFeeToman),
      deltaUsdtMicros: sizeUsdtMicros - buyFeeUsdtMicros
    },
    sell: {
      sourceId: sellSourceId,
      deltaIrtToman: sellNotional - sellFeeToman,
      deltaUsdtMicros: -(sizeUsdtMicros + sellFeeUsdtMicros)
    }
  };

  return {
    economics: {
      capitalInvolvedToman,
      cashPnlIrtToman,
      inventoryDeltaUsdtMicros: deltas.buy.deltaUsdtMicros + deltas.sell.deltaUsdtMicros,
      sellFeeValueToman,
      economicNetPnlToman,
      slippageBufferToman,
      riskAdjustedPnlToman,
      riskAdjustedEdgePercent:
        capitalInvolvedToman > 0
          ? Math.round((riskAdjustedPnlToman / capitalInvolvedToman) * 1_000_000) / 10_000
          : 0,
      riskAdjustedReturnBps:
        capitalInvolvedToman > 0
          ? Math.round((riskAdjustedPnlToman / capitalInvolvedToman) * 10_000 * 100) / 100
          : 0
    },
    deltas
  };
}

function blocked(blockers: SizingBlocker[], constraints: SizingConstraint[] = []): SizingResult {
  const rejectionReason = blockers.map((b) => b.detailFa || b.code).join(" · ") || null;
  return {
    status: "BLOCKED",
    policy: SMART_SIZING_POLICY,
    sizeUsdtMicros: null,
    sizeUsdt: null,
    bindingConstraint: null,
    constraints,
    capacity: null,
    liquidityMaxUsdtMicros: null,
    policyMaxUsdtMicros: null,
    maxFeasibleUsdtMicros: null,
    candidates: [],
    selection: null,
    inventory: null,
    baseline: null,
    quote: null,
    economics: null,
    blockers,
    audit: {
      policy: SMART_SIZING_POLICY,
      status: "BLOCKED",
      limits: {
        capitalCapUsdtMicros: null,
        depthCapUsdtMicros: null,
        buyUsableUsdtMicros: null,
        sellUsableUsdtMicros: null,
        orderCapUsdtMicros: null,
        venueAllocationUsdtMicros: null,
        venueConcentrationUsdtMicros: null,
        minExecutableUsdtMicros: PAPER_POLICY_MIN_USDT_MICROS,
        paperPolicyMinUsdtMicros: PAPER_POLICY_MIN_USDT_MICROS,
        verifiedVenueMinUsdtMicros: null,
        floorBinding: PAPER_POLICY_MIN_KEY,
        safeCeilingUsdtMicros: null
      },
      safeCeilingUsdtMicros: null,
      finalSizeUsdtMicros: null,
      bindingConstraint: null,
      buyDepthUsdtMicros: null,
      sellDepthUsdtMicros: null,
      buyVwapToman: null,
      sellVwapToman: null,
      grossSpreadToman: null,
      buyFeeBps: null,
      sellFeeBps: null,
      predictedRiskAdjustedNetToman: null,
      riskAdjustedReturnBps: null,
      inventoryEffectPoints: null,
      rejectionReason,
      adaptive: {
        candidateCount: 0,
        eligibleCount: 0,
        executionPointCount: null,
        analysisPointCount: null
      },
      selectionReasonFa: null
    }
  };
}

function buildAudit(partial: {
  status: "SIZED" | "BLOCKED";
  sizeUsdtMicros: number | null;
  bindingConstraint: SizingConstraintKey | null;
  constraints: SizingConstraint[];
  capacity: SizingResult["capacity"];
  quote: SizingQuote | null;
  economics: SizingEconomics | null;
  inventory: InventoryAssessment | null;
  blockers: SizingBlocker[];
  selection: SizingSelection | null;
  candidates: SizingCandidate[];
  adaptiveMeta: SmartCandidateSet["adaptive"] | null;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  /** Effective Paper floor. Not ledger quantum. */
  minExecutableUsdtMicros?: number | null;
  paperPolicyMinUsdtMicros?: number | null;
  verifiedVenueMinUsdtMicros?: number | null;
  floorBinding?: "paper_policy_min" | "venue_min" | null;
}): SizingAudit {
  const capOf = (key: SizingConstraintKey) =>
    partial.constraints.find((c) => c.key === key)?.capUsdtMicros ?? null;
  const rejectionReason =
    partial.status === "BLOCKED"
      ? partial.blockers.map((b) => b.detailFa || b.code).join(" · ") || null
      : null;
  const grossSpreadToman =
    partial.quote && partial.sizeUsdtMicros
      ? Math.round(
          ((partial.quote.sellVwapToman - partial.quote.buyVwapToman) * partial.sizeUsdtMicros) /
            1_000_000
        )
      : null;
  return {
    policy: SMART_SIZING_POLICY,
    status: partial.status,
    limits: {
      capitalCapUsdtMicros: capOf("capital_cap"),
      depthCapUsdtMicros: capOf("depth_cap"),
      buyUsableUsdtMicros: capOf("buy_irt_balance"),
      sellUsableUsdtMicros: capOf("sell_usdt_balance"),
      orderCapUsdtMicros: capOf("policy_max_order_size"),
      venueAllocationUsdtMicros: capOf("venue_allocation"),
      venueConcentrationUsdtMicros: capOf("venue_concentration"),
      minExecutableUsdtMicros:
        partial.minExecutableUsdtMicros != null && partial.minExecutableUsdtMicros > 0
          ? partial.minExecutableUsdtMicros
          : PAPER_POLICY_MIN_USDT_MICROS,
      paperPolicyMinUsdtMicros:
        partial.paperPolicyMinUsdtMicros ?? PAPER_POLICY_MIN_USDT_MICROS,
      verifiedVenueMinUsdtMicros: partial.verifiedVenueMinUsdtMicros ?? null,
      floorBinding: partial.floorBinding ?? PAPER_POLICY_MIN_KEY,
      safeCeilingUsdtMicros: partial.capacity?.ceilingMicros ?? null
    },
    safeCeilingUsdtMicros: partial.capacity?.ceilingMicros ?? null,
    finalSizeUsdtMicros: partial.sizeUsdtMicros,
    bindingConstraint: partial.bindingConstraint,
    buyDepthUsdtMicros: partial.capacity?.buyDepth.depthMicros ?? null,
    sellDepthUsdtMicros: partial.capacity?.sellDepth.depthMicros ?? null,
    buyVwapToman: partial.quote?.buyVwapToman ?? null,
    sellVwapToman: partial.quote?.sellVwapToman ?? null,
    grossSpreadToman,
    buyFeeBps: partial.buyFeeBps,
    sellFeeBps: partial.sellFeeBps,
    predictedRiskAdjustedNetToman: partial.economics?.riskAdjustedPnlToman ?? null,
    riskAdjustedReturnBps: partial.economics?.riskAdjustedReturnBps ?? null,
    inventoryEffectPoints: partial.inventory?.measurable ? partial.inventory.impactPoints : null,
    rejectionReason,
    adaptive: {
      candidateCount: partial.candidates.length,
      eligibleCount: partial.candidates.filter((c) => c.eligible).length,
      executionPointCount: partial.adaptiveMeta?.executionPointCount ?? null,
      analysisPointCount: partial.adaptiveMeta?.analysisPointCount ?? null
    },
    selectionReasonFa: partial.selection?.reasonFa ?? null
  };
}

/**
 * Calculate the size for one route in one cycle.
 *
 * Deterministic: the same inputs always produce the same size, the same binding
 * constraint and the same reasons, in the same order. Nothing is sampled, no
 * clock is read, and no value is carried over from a previous cycle.
 */
export function computeRouteSize(input: SizingInput): SizingResult {
  const blockers: SizingBlocker[] = [];

  /* ── 1. risk policies — required, never defaulted ─────────────────────── */
  const policy: Partial<Record<RiskPolicyKey, number>> = {};
  for (const key of SIZING_REQUIRED_POLICIES) {
    const value = policyValueOrNull(input.policies, key);
    const state = input.policies.find((p) => p.definition.key === key);
    if (value === null) {
      blockers.push(
        blocker(
          state?.expired ? "expired_policy" : "missing_policy",
          key,
          `«${state?.definition.labelFa ?? key}» باید توسط مدیر تعیین شود؛ هیچ مقدار پیش‌فرضی جایگزین نمی‌شود.`
        )
      );
      continue;
    }
    policy[key] = value;
  }

  /* ── 2. evidence that must exist before anything is computed ──────────── */
  const buy = input.buySnapshot;
  const sell = input.sellSnapshot;
  if (!buy || !sell) {
    blockers.push(blocker("no_depth_evidence", !buy ? input.buySourceId : input.sellSourceId));
    return blocked(blockers);
  }
  if (input.buyFeeBps === null || input.sellFeeBps === null) {
    blockers.push(
      blocker("fee_unconfirmed", input.buyFeeBps === null ? input.buySourceId : input.sellSourceId)
    );
  }
  if (!settlementUsable(input.buySettlement) || !settlementUsable(input.sellSettlement)) {
    blockers.push(
      blocker(
        "settlement_unconfirmed",
        !settlementUsable(input.buySettlement) ? input.buySourceId : input.sellSourceId
      )
    );
  }

  const buyBalance = input.balances.find((b) => b.sourceId === input.buySourceId);
  const sellBalance = input.balances.find((b) => b.sourceId === input.sellSourceId);
  if (!buyBalance || !sellBalance) {
    blockers.push(blocker("no_balance_record", !buyBalance ? input.buySourceId : input.sellSourceId));
  }

  /* ── 2b. Paper floor = max(paper_policy_min, verified venue min) ─────────
   *
   * paper_policy_min (5 USDT) is the admin-approved global Paper minimum — not
   * an exchange limit. Verified venue mins raise the floor when known.
   * Unknown venue mins never block Paper; they flag LIVE readiness only.
   */
  const routeFloor = resolvePaperRouteFloor(
    input.buySourceId,
    input.sellSourceId,
    input.venueExecutionLimits ?? null
  );
  const minExecutableMicros = routeFloor.minMicros;
  const sizeStepMicros = routeFloor.stepMicros;

  /* ── 3. freshness, measured against the admin's own budget ────────────── */
  const maxAgeMs = policy.max_quote_age_ms;
  if (maxAgeMs !== undefined) {
    for (const [id, snap] of [
      [input.buySourceId, buy],
      [input.sellSourceId, sell]
    ] as const) {
      if (snap.stale || snap.ageMs > maxAgeMs) {
        blockers.push(
          blocker("stale_quote", id, `سن داده ${Math.round(snap.ageMs)} میلی‌ثانیه در برابر بودجهٔ ${maxAgeMs}`)
        );
      }
    }
  }

  /* ── 4. the modelled buffer must sit inside the admin's slippage ceiling ─ */
  const maxSlippageBps = policy.max_slippage_bps;
  if (maxSlippageBps !== undefined && input.slippageBufferBps > maxSlippageBps) {
    blockers.push(
      blocker("slippage_over_limit", `${input.slippageBufferBps}bps`, `سقف مجاز ${maxSlippageBps}bps`)
    );
  }

  /* ── 5. each leg needs an executable ladder ──────────────────────────────
   *
   * An order book supplies one directly; a dealer quote supplies a single
   * level at its published price and maximum. Requiring a real ladder used to
   * exclude every OTC dealer from every route even when its capacity was
   * measurable and published — that was an engine limitation, not a fact about
   * the venue.
   */
  const buyLadder = executableLadder({
    marketModel: buy.marketModel,
    bookBids: buy.bookBids,
    bookAsks: buy.bookAsks,
    side: "buy",
    quote: input.buyQuote
  });
  if (!buyLadder.ok) {
    blockers.push(
      blocker(
        buyLadder.reason === "quote_only_no_order_book" ? "quote_only_no_order_book" : "book_invalid",
        input.buySourceId,
        buyLadder.detailFa
      )
    );
  }
  const sellLadder = executableLadder({
    marketModel: sell.marketModel,
    bookBids: sell.bookBids,
    bookAsks: sell.bookAsks,
    side: "sell",
    quote: input.sellQuote
  });
  if (!sellLadder.ok) {
    blockers.push(
      blocker(
        sellLadder.reason === "quote_only_no_order_book" ? "quote_only_no_order_book" : "book_invalid",
        input.sellSourceId,
        sellLadder.detailFa
      )
    );
  }

  /*
   * A missing risk policy stops the trade, not the analysis.
   *
   * The administrator has to be able to see whether a venue can carry the
   * intended scale BEFORE choosing the limits that would constrain it —
   * otherwise the only way to inspect capacity is to approve a limit blind.
   * So an unset policy leaves the liquidity study running with that cap simply
   * absent, and the result is still BLOCKED with the exact key.
   */
  const policyBlockers = blockers.filter(
    (b) => b.code === "missing_policy" || b.code === "expired_policy"
  );
  const fatal = blockers.filter((b) => !policyBlockers.includes(b));

  if (fatal.length || !buyBalance || !sellBalance || !buyLadder.ok || !sellLadder.ok) {
    return blocked(blockers);
  }

  const buyFeeBps = input.buyFeeBps as number;
  const sellFeeBps = input.sellFeeBps as number;
  const buyAsks = buyLadder.levels;
  const sellBids = sellLadder.levels;
  const routeMinExecutableMicros = minExecutableMicros;
  const paperFloorMeta = {
    paperPolicyMinUsdtMicros: routeFloor.paperPolicyMinMicros,
    verifiedVenueMinUsdtMicros: routeFloor.verifiedVenueMinMicros,
    floorBinding: routeFloor.binding
  };

  /* ── 6. the capital basis ────────────────────────────────────────────────
   *
   * Toman ceilings become quantity ceilings at the BEST price, which is the
   * most permissive conversion. That is deliberate: a cap must never exclude a
   * quantity before it has been priced. The honest price comes from the walk,
   * and the balance re-check after it is what actually binds.
   */
  const bestBuy = bestPriceToman(buyAsks, "buy") as number;

  const buyUsableMicros = buyIrtCapacityMicros(
    buyBalance.irtToman,
    bestBuy,
    buyFeeBps,
    input.buySettlement.feeAsset
  );
  const sellUsableMicros = sellUsdtCapacityMicros(
    sellBalance.usdtMicros,
    sellFeeBps,
    input.sellSettlement.feeAsset
  );

  /*
   * Executable depth is measured inside the admin's slippage ceiling, not from
   * the whole ladder. Liquidity priced further from the top of book than the
   * policy allows is real, but it is not liquidity this desk may take, and
   * sizing against it would produce a cap the risk limits forbid.
   *
   * Without the policy the ceiling cannot be applied at all. Rather than assume
   * one, the study falls back to the full ladder and the result stays BLOCKED
   * on the missing key — the capacity is inspectable, the trade is not allowed.
   */
  const slippageCeilingBps = maxSlippageBps ?? Number.POSITIVE_INFINITY;
  const buyDepth = slippageBoundedDepth(buyAsks, "buy", slippageCeilingBps);
  const sellDepth = slippageBoundedDepth(sellBids, "sell", slippageCeilingBps);

  const allocationCap =
    input.buyVenueAllocationToman === null
      ? null
      : tomanCeilingMicros(input.buyVenueAllocationToman, bestBuy);

  const orderCap =
    policy.max_order_size_usdt === undefined
      ? null
      : usdtToMicros(policy.max_order_size_usdt);

  let concentrationCap: number | null = null;
  let concentrationDetail = "ارزش پرتفوی یا سهم فعلی این صرافی در دسترس نیست؛ این سقف اندازه‌گیری نشد.";
  if (policy.max_venue_exposure_percent === undefined) {
    concentrationDetail = "سیاست «سقف تمرکز روی یک صرافی» تعیین نشده است؛ این سقف اعمال نشد.";
  } else if (input.portfolioValueToman !== null && input.buyVenueExposureToman !== null) {
    const ceilingToman = Math.floor(
      (input.portfolioValueToman * (policy.max_venue_exposure_percent as number)) / 100
    );
    const headroomToman = ceilingToman - input.buyVenueExposureToman;
    concentrationCap = tomanCeilingMicros(Math.max(0, headroomToman), bestBuy);
    concentrationDetail = `سقف ${policy.max_venue_exposure_percent}٪ پرتفوی = ${ceilingToman.toLocaleString("en-US")} تومان، فضای باقی‌مانده ${Math.max(0, headroomToman).toLocaleString("en-US")} تومان`;
  }

  const extraCaps = [allocationCap, orderCap, concentrationCap].filter(
    (c): c is number => c !== null
  );

  const candidateSet = buildSmartCandidates({
    buyUsableMicros,
    sellUsableMicros,
    buySourceId: input.buySourceId,
    sellSourceId: input.sellSourceId,
    buyDepthMicros: buyDepth.depthMicros,
    sellDepthMicros: sellDepth.depthMicros,
    extraCapsMicros: extraCaps,
    // Step = max(venue steps, ledger quantum). Min = verified venue mins.
    granularityMicros: Math.max(sizeStepMicros, SIZE_GRANULARITY_MICROS),
    minMicros: routeMinExecutableMicros,
    // Book breakpoints densify the execution set so inventory-tight routes
    // still find a valid size below the coarse 10% analysis probe.
    buyLevels: buyAsks,
    sellLevels: sellBids
  });

  const percentFor = (micros: number): number | null =>
    candidateSet.ladder.find((l) => l.kept && l.quantizedMicros === micros)?.percent ?? null;

  const constraints: SizingConstraint[] = [
    constraint(
      "capital_cap",
      candidateSet.capitalCapMicros,
      `${CAPITAL_CAP_PERCENT}٪ از ${usdtFa(candidateSet.limitingUsableMicros)} تتر ظرفیت قابل استفادهٔ سمت ${
        candidateSet.limitingSide === "buy" ? "خرید" : "فروش"
      } (${candidateSet.limitingSourceId})`
    ),
    constraint(
      "depth_cap",
      candidateSet.depthCapMicros,
      `${DEPTH_CAP_PERCENT}٪ از عمق اجراپذیر پای ${candidateSet.depthCapSide === "buy" ? "خرید" : "فروش"} — ` +
        `خرید ${usdtFa(buyDepth.depthMicros)} تتر در ${buyDepth.levelsIncluded} سطح مجاز` +
        (buyDepth.levelsExcluded ? ` (${buyDepth.levelsExcluded} سطح خارج از سقف لغزش)` : "") +
        ` · فروش ${usdtFa(sellDepth.depthMicros)} تتر در ${sellDepth.levelsIncluded} سطح مجاز` +
        (sellDepth.levelsExcluded ? ` (${sellDepth.levelsExcluded} سطح خارج از سقف لغزش)` : "")
    ),
    constraint(
      "depth_evidence",
      Math.min(totalDepthMicros(buyAsks), totalDepthMicros(sellBids)),
      `کمینهٔ عمق کل دو دفتر: خرید ${usdtFa(totalDepthMicros(buyAsks))} تتر در ${buyAsks.length} سطح، فروش ${usdtFa(totalDepthMicros(sellBids))} تتر در ${sellBids.length} سطح`
    ),
    constraint(
      "buy_irt_balance",
      buyUsableMicros,
      `${buyBalance.irtToman.toLocaleString("en-US")} تومان آزاد با کارمزد ${buyFeeBps} bps در ${input.buySettlement.feeAsset}`
    ),
    constraint(
      "sell_usdt_balance",
      sellUsableMicros,
      `${microsToUsdt(sellBalance.usdtMicros)} تتر آزاد با کارمزد ${sellFeeBps} bps در ${input.sellSettlement.feeAsset}`
    ),
    constraint(
      "venue_allocation",
      allocationCap,
      input.buyVenueAllocationToman === null
        ? "سهم این صرافی در طرح سرمایه در دسترس نیست؛ این سقف اندازه‌گیری نشد."
        : `سهم طرح: ${input.buyVenueAllocationToman.toLocaleString("en-US")} تومان`
    ),
    constraint(
      "policy_max_order_size",
      orderCap,
      policy.max_order_size_usdt === undefined
        ? "سیاست «حداکثر حجم هر سفارش» تعیین نشده است؛ این سقف اعمال نشد."
        : `سیاست «حداکثر حجم هر سفارش» = ${policy.max_order_size_usdt} تتر`
    ),
    constraint("venue_concentration", concentrationCap, concentrationDetail)
  ];

  const liquidityKeys: SizingConstraintKey[] = [
    "capital_cap",
    "depth_cap",
    "depth_evidence",
    "buy_irt_balance",
    "sell_usdt_balance"
  ];
  const measured = constraints.filter((c) => c.capUsdtMicros !== null);
  const liquidityMax = Math.min(
    ...measured.filter((c) => liquidityKeys.includes(c.key)).map((c) => c.capUsdtMicros as number)
  );
  const policyCaps = measured.filter((c) => !liquidityKeys.includes(c.key));
  const policyMax = policyCaps.length
    ? Math.min(...policyCaps.map((c) => c.capUsdtMicros as number))
    : null;

  /*
   * The cap that produced the ceiling — reported only when the chosen size
   * actually reached it.
   *
   * A size below the ceiling was decided by the profit curve, not by a limit,
   * and naming a "binding constraint" there would be false: the desk could have
   * traded more and chose not to. Quantization means the size lands a few
   * micros under the raw cap, so the comparison is against the quantized
   * ceiling rather than the cap itself.
   */
  const tightest = measured.length
    ? measured.reduce((a, c) =>
        (c.capUsdtMicros as number) < (a.capUsdtMicros as number) ? c : a
      )
    : null;
  const quantizedCeiling = quantizeSizeMicros(candidateSet.ceilingMicros);
  const bindingFor = (q: number): SizingConstraintKey | null =>
    tightest && q >= quantizedCeiling ? tightest.key : null;

  const capacity: NonNullable<SizingResult["capacity"]> = {
    buyUsableMicros,
    sellUsableMicros,
    limitingUsableMicros: candidateSet.limitingUsableMicros,
    limitingSide: candidateSet.limitingSide,
    limitingSourceId: candidateSet.limitingSourceId,
    capitalCapMicros: candidateSet.capitalCapMicros,
    depthCapMicros: candidateSet.depthCapMicros,
    depthCapSide: candidateSet.depthCapSide,
    ceilingMicros: candidateSet.ceilingMicros,
    buyDepth,
    sellDepth,
    ladder: candidateSet.ladder
  };

  const partialBase = {
    policy: SMART_SIZING_POLICY,
    constraints,
    capacity,
    liquidityMaxUsdtMicros: Number.isFinite(liquidityMax) ? liquidityMax : null,
    policyMaxUsdtMicros: policyMax,
    maxFeasibleUsdtMicros: candidateSet.quantities.length
      ? candidateSet.quantities[candidateSet.quantities.length - 1]
      : null
  };

  /*
   * The fixed ladder, priced on exactly this evidence. Built even when the
   * smart engine blocks, because "the old sizing would not have traded either"
   * is itself a useful answer.
   */
  const baseline = buildBaseline({
    buyAsks,
    sellBids,
    buySourceId: input.buySourceId,
    sellSourceId: input.sellSourceId,
    buyFeeBps,
    sellFeeBps,
    buySettlement: input.buySettlement,
    sellSettlement: input.sellSettlement,
    slippageBufferBps: input.slippageBufferBps,
    buyIrtAvailable: buyBalance.irtToman,
    sellUsdtAvailable: sellBalance.usdtMicros
  });

  if (!candidateSet.quantities.length) {
    const floorBlockers: SizingBlocker[] = [
      ...policyBlockers,
      blocker(
        "size_floor",
        bindingFor(candidateSet.ceilingMicros) ?? "unknown",
        `سقف‌ها به ${usdtFa(candidateSet.ceilingMicros)} تتر می‌رسند که کمتر از کف Paper (${
          routeMinExecutableMicros / 1_000_000
        } تتر = max(paper_policy_min ${PAPER_POLICY_MIN_USDT}، حداقل تأییدشدهٔ صرافی)) است؛ محدودکننده: ${
          bindingFor(candidateSet.ceilingMicros)
            ? SIZING_CONSTRAINT_FA[bindingFor(candidateSet.ceilingMicros) as SizingConstraintKey]
            : "—"
        }`
      )
    ];
    return {
      ...partialBase,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: null,
      candidates: [],
      selection: null,
      inventory: null,
      baseline,
      quote: null,
      economics: null,
      blockers: floorBlockers,
      audit: buildAudit({
        status: "BLOCKED",
        sizeUsdtMicros: null,
        bindingConstraint: null,
        constraints,
        capacity,
        quote: null,
        economics: null,
        inventory: null,
        blockers: floorBlockers,
        selection: null,
        candidates: [],
        adaptiveMeta: candidateSet.adaptive,
        buyFeeBps,
        sellFeeBps,
        minExecutableUsdtMicros: routeMinExecutableMicros,
        ...paperFloorMeta
      })
    };
  }

  /* ── 7. evaluate every candidate ─────────────────────────────────────────
   *
   * Each quantity is walked on both books, settled exactly, and checked against
   * the inventory band. A candidate is either eligible or carries one exact
   * rejection code — never dropped silently.
   */
  const edgeFloorPercent = policy.min_risk_adjusted_edge_percent;

  type Evaluated = {
    q: number;
    buyWalk: BookWalk;
    sellWalk: BookWalk;
    econ: SizingEconomics;
    inventory: InventoryAssessment;
    eligible: boolean;
    code: CandidateRejectionCode | null;
    detailFa: string | null;
  };

  const evaluated: Evaluated[] = [];

  for (const q of candidateSet.quantities) {
    const buyWalk = walkBook(buyAsks, q, "buy");
    const sellWalk = walkBook(sellBids, q, "sell");

    const push = (
      econ: SizingEconomics,
      inventory: InventoryAssessment,
      code: CandidateRejectionCode | null,
      detailFa: string | null
    ) => {
      evaluated.push({
        q,
        buyWalk,
        sellWalk,
        econ,
        inventory,
        eligible: code === null,
        code,
        detailFa
      });
    };

    const emptyInventory: InventoryAssessment = {
      measurable: false,
      reason: "ok",
      reasonFa: "",
      before: [],
      after: [],
      impactPoints: 0,
      withinBand: false,
      breachedSourceId: null,
      breachDetailFa: null
    };
    const zeroEcon: SizingEconomics = {
      capitalInvolvedToman: 0,
      cashPnlIrtToman: 0,
      inventoryDeltaUsdtMicros: 0,
      sellFeeValueToman: 0,
      economicNetPnlToman: 0,
      slippageBufferToman: 0,
      riskAdjustedPnlToman: 0,
      riskAdjustedEdgePercent: 0,
      riskAdjustedReturnBps: 0
    };

    if (!buyWalk.complete || !sellWalk.complete || buyWalk.vwapToman === null || sellWalk.vwapToman === null) {
      const shortSide = !buyWalk.complete ? "خرید" : "فروش";
      const shortMicros = !buyWalk.complete ? buyWalk.unfilledMicros : sellWalk.unfilledMicros;
      push(
        zeroEcon,
        emptyInventory,
        "insufficient_depth",
        `پای ${shortSide} ${usdtFa(shortMicros)} تتر کم می‌آورد؛ فراتر از عمق مشاهده‌شده برون‌یابی نمی‌شود.`
      );
      continue;
    }

    /*
     * Defence in depth. The depth cap already keeps candidates inside the
     * slippage ceiling, so this guard should never fire in the normal path —
     * which is exactly why it is here: it is the check that would catch a
     * future caller who supplied a quantity the caps did not produce.
     */
    const buySlipBps = realizedSlippageBps(buyWalk);
    const sellSlipBps = realizedSlippageBps(sellWalk);
    if (maxSlippageBps !== undefined && Math.max(buySlipBps, sellSlipBps) > maxSlippageBps) {
      push(
        zeroEcon,
        emptyInventory,
        "excessive_slippage",
        `لغزش محقق‌شده خرید ${buySlipBps} bps و فروش ${sellSlipBps} bps در برابر سقف ${maxSlippageBps} bps`
      );
      continue;
    }

    // Re-check the balance caps at the WALKED price. The pre-walk caps used the
    // best price and are therefore permissive; this is the binding check.
    const irtNeeded =
      input.buySettlement.feeAsset === "IRT"
        ? buyWalk.notionalToman + feeFromBps(buyWalk.notionalToman, buyFeeBps)
        : buyWalk.notionalToman;
    if (irtNeeded > buyBalance.irtToman) {
      push(
        zeroEcon,
        emptyInventory,
        "insufficient_balance",
        `این حجم ${irtNeeded.toLocaleString("en-US")} تومان می‌خواهد و تنها ${buyBalance.irtToman.toLocaleString("en-US")} تومان آزاد است`
      );
      continue;
    }

    const priced = priceAt(
      q,
      { buyVwapToman: buyWalk.vwapToman, sellVwapToman: sellWalk.vwapToman },
      input.buySourceId,
      input.sellSourceId,
      buyFeeBps,
      sellFeeBps,
      input.buySettlement,
      input.sellSettlement,
      // Same rule the broker uses: the executable buy VWAP for this cycle is
      // the honest replacement cost of the USDT a sell-side fee consumes.
      buyWalk.vwapToman,
      input.slippageBufferBps
    );

    // The sell venue must hold quantity PLUS the USDT fee, not just quantity.
    const usdtNeeded = -priced.deltas.sell.deltaUsdtMicros;
    if (usdtNeeded > sellBalance.usdtMicros) {
      push(
        zeroEcon,
        emptyInventory,
        "insufficient_balance",
        `این حجم ${usdtFa(usdtNeeded)} تتر می‌خواهد و تنها ${usdtFa(sellBalance.usdtMicros)} تتر آزاد است`
      );
      continue;
    }

    const inventory = assessInventory({
      balances: input.balances,
      deltas: [priced.deltas.buy, priced.deltas.sell],
      model: input.inventoryModel
    });

    if (!inventory.measurable) {
      push(priced.economics, inventory, "inventory_limit", inventory.reasonFa);
      continue;
    }
    if (!inventory.withinBand) {
      push(
        priced.economics,
        inventory,
        "inventory_limit",
        inventory.breachDetailFa ?? CANDIDATE_REJECTION_FA.inventory_limit
      );
      continue;
    }
    if (priced.economics.riskAdjustedPnlToman <= 0) {
      push(
        priced.economics,
        inventory,
        "not_net_positive",
        `سود تعدیل‌شدهٔ ${priced.economics.riskAdjustedPnlToman.toLocaleString("en-US")} تومان اکیداً مثبت نیست`
      );
      continue;
    }
    if (
      edgeFloorPercent !== undefined &&
      priced.economics.riskAdjustedEdgePercent < edgeFloorPercent
    ) {
      push(
        priced.economics,
        inventory,
        "edge_below_floor",
        `حاشیهٔ ${priced.economics.riskAdjustedEdgePercent}٪ در برابر کف سیاست ${edgeFloorPercent}٪`
      );
      continue;
    }

    push(priced.economics, inventory, null, null);
  }

  const candidates: SizingCandidate[] = evaluated.map((e) => ({
    sizeUsdtMicros: e.q,
    percentOfUsable: percentFor(e.q),
    buyVwapToman: e.buyWalk.vwapToman ?? 0,
    sellVwapToman: e.sellWalk.vwapToman ?? 0,
    riskAdjustedPnlToman: e.econ.riskAdjustedPnlToman,
    economicNetPnlToman: e.econ.economicNetPnlToman,
    cashPnlIrtToman: e.econ.cashPnlIrtToman,
    sellFeeValueToman: e.econ.sellFeeValueToman,
    inventoryDeltaUsdtMicros: e.econ.inventoryDeltaUsdtMicros,
    riskAdjustedEdgePercent: e.econ.riskAdjustedEdgePercent,
    riskAdjustedReturnBps: e.econ.riskAdjustedReturnBps,
    buyLevels: e.buyWalk.fills.length,
    sellLevels: e.sellWalk.fills.length,
    bookParticipationPercent: Math.max(
      e.buyWalk.bookParticipationPercent,
      e.sellWalk.bookParticipationPercent
    ),
    priceImpactPercent: Math.max(e.buyWalk.priceImpactPercent, e.sellWalk.priceImpactPercent),
    inventoryImpactPoints: e.inventory.impactPoints,
    eligible: e.eligible,
    rejectionCode: e.code,
    rejectionFa: e.code ? (e.detailFa ?? CANDIDATE_REJECTION_FA[e.code]) : null
  }));

  const partial = { ...partialBase, candidates, baseline };

  const eligible = evaluated.filter((e) => e.eligible);

  if (!eligible.length) {
    /*
     * Nothing traded. Prefer inventory_limit when any fully-walked candidate
     * was refused only by the inventory band — the largest raw candidate can
     * fail balance recheck at the ceiling and would otherwise misreport as a
     * balance error while the real closed band is inventory.
     */
    const inventoryHit = [...evaluated].reverse().find((e) => e.code === "inventory_limit");
    const last = inventoryHit ?? evaluated[evaluated.length - 1];
    const code = last?.code ?? "insufficient_depth";
    const blockerCode: SizingBlockerCode =
      code === "inventory_limit"
        ? "inventory_limit"
        : code === "not_net_positive"
          ? "not_net_positive"
          : code === "edge_below_floor"
            ? "edge_below_floor"
            : code === "excessive_slippage"
              ? "slippage_over_limit"
              : code === "insufficient_balance"
                ? "depth_exhausted"
                : "depth_exhausted";
    const blockersOut: SizingBlocker[] = [
      ...policyBlockers,
      blocker(
        blockerCode,
        `${input.buySourceId}→${input.sellSourceId}`,
        `${evaluated.length} حجم نامزد (حل‌کنندهٔ تطبیقی) بررسی شد و هیچ‌کدام واجد شرایط نبود؛ نماینده (${usdtFa(
          last?.q ?? 0
        )} تتر): ${last?.detailFa ?? CANDIDATE_REJECTION_FA[code]}`
      )
    ];
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: last ? bindingFor(last.q) : null,
      selection: null,
      inventory: last?.inventory ?? null,
      quote: null,
      economics: last?.econ ?? null,
      blockers: blockersOut,
      audit: buildAudit({
        status: "BLOCKED",
        sizeUsdtMicros: null,
        bindingConstraint: last ? bindingFor(last.q) : null,
        constraints,
        capacity,
        quote: null,
        economics: last?.econ ?? null,
        inventory: last?.inventory ?? null,
        blockers: blockersOut,
        selection: null,
        candidates,
        adaptiveMeta: candidateSet.adaptive,
        buyFeeBps,
        sellFeeBps,
        minExecutableUsdtMicros: routeMinExecutableMicros,
        ...paperFloorMeta
      })
    };
  }

  /*
   * 8a. Final size = maximum safe size that is still economically profitable.
   *
   * Among eligible candidates (passed balance, full book walk, inventory,
   * positive risk-adjusted PnL, edge floor), pick the LARGEST size. Profit
   * ranking only breaks ties at equal size. Utilization targets never force a
   * larger size past safety or positive net edge.
   */
  const rank = (a: Evaluated, b: Evaluated) =>
    // 1. maximum safe size that cleared all gates;
    b.q - a.q ||
    // 2. better risk-adjusted profit at that size;
    b.econ.riskAdjustedPnlToman - a.econ.riskAdjustedPnlToman ||
    // 3. better return on capital;
    b.econ.riskAdjustedReturnBps - a.econ.riskAdjustedReturnBps ||
    // 4. lower inventory impact.
    a.inventory.impactPoints - b.inventory.impactPoints;

  const ordered = [...eligible].sort(rank);
  const best = ordered[0];

  const quote: SizingQuote = {
    buyVwapToman: best.buyWalk.vwapToman as number,
    sellVwapToman: best.sellWalk.vwapToman as number,
    markPriceToman: best.buyWalk.vwapToman as number,
    buyAgeMs: Math.round(buy.ageMs),
    sellAgeMs: Math.round(sell.ageMs),
    buyWalk: best.buyWalk,
    sellWalk: best.sellWalk,
    buySlippageBps: realizedSlippageBps(best.buyWalk),
    sellSlippageBps: realizedSlippageBps(best.sellWalk)
  };

  if (policyBlockers.length) {
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: bindingFor(best.q),
      selection: null,
      inventory: best.inventory,
      quote,
      economics: best.econ,
      blockers: policyBlockers,
      audit: buildAudit({
        status: "BLOCKED",
        sizeUsdtMicros: null,
        bindingConstraint: bindingFor(best.q),
        constraints,
        capacity,
        quote,
        economics: best.econ,
        inventory: best.inventory,
        blockers: policyBlockers,
        selection: null,
        candidates,
        adaptiveMeta: candidateSet.adaptive,
        buyFeeBps,
        sellFeeBps,
        minExecutableUsdtMicros: routeMinExecutableMicros,
        ...paperFloorMeta
      })
    };
  }

  /* ── 8b. why this size, and why not the next one up ─────────────────────── */
  const runnerUp = ordered[1] ?? null;
  let tieBreakFa: string | null = null;
  if (runnerUp && runnerUp.q === best.q) {
    if (runnerUp.econ.riskAdjustedPnlToman !== best.econ.riskAdjustedPnlToman) {
      tieBreakFa = `حجم برابر؛ سود تعدیل‌شدهٔ بالاتر تعیین‌کننده شد.`;
    } else if (runnerUp.econ.riskAdjustedReturnBps !== best.econ.riskAdjustedReturnBps) {
      tieBreakFa = `حجم و سود برابر؛ بازده تعدیل‌شدهٔ بالاتر تعیین‌کننده شد.`;
    } else if (runnerUp.inventory.impactPoints !== best.inventory.impactPoints) {
      tieBreakFa = `حجم/سود/بازده برابر؛ اثر بهتر بر موجودی تعیین‌کننده شد.`;
    }
  }

  const largerEvaluated = evaluated
    .filter((e) => e.q > best.q)
    .sort((a, b) => a.q - b.q)[0] ?? null;

  let nextLarger: SizingSelection["nextLarger"] = null;
  if (largerEvaluated) {
    if (!largerEvaluated.eligible) {
      nextLarger = {
        sizeUsdtMicros: largerEvaluated.q,
        code: largerEvaluated.code as CandidateRejectionCode,
        detailFa:
          largerEvaluated.detailFa ??
          CANDIDATE_REJECTION_FA[largerEvaluated.code as CandidateRejectionCode],
        marginalPnlToman: null
      };
    } else {
      const marginal =
        largerEvaluated.econ.riskAdjustedPnlToman - best.econ.riskAdjustedPnlToman;
      const code: CandidateRejectionCode =
        marginal < 0 ? "negative_marginal_profitability" : "lower_risk_adjusted_pnl";
      nextLarger = {
        sizeUsdtMicros: largerEvaluated.q,
        code,
        detailFa:
          marginal < 0
            ? `افزایش حجم از ${usdtFa(best.q)} به ${usdtFa(largerEvaluated.q)} تتر سود تعدیل‌شده را ${Math.abs(
                marginal
              ).toLocaleString("en-US")} تومان کاهش می‌دهد.`
            : `سود تعدیل‌شده برابر است؛ ${tieBreakFa ?? "حجم کوچک‌تر انتخاب شد."}`,
        marginalPnlToman: marginal
      };
    }
  }

  const selection: SizingSelection = {
    policy: SMART_SIZING_POLICY,
    selectedSizeUsdtMicros: best.q,
    selectedPercentOfUsable: percentFor(best.q),
    reasonFa:
      `حداکثر حجم امن و سودده (حل‌کنندهٔ تطبیقی): ${usdtFa(best.q)} تتر ` +
      `(${eligible.length} حجم واجد شرایط از ${evaluated.length} نامزد؛ ` +
      `سود تعدیل‌شده ${best.econ.riskAdjustedPnlToman.toLocaleString("en-US")} تومان / ${best.econ.riskAdjustedReturnBps} bps)؛ ` +
      `${
        bindingFor(best.q)
          ? `محدودکنندهٔ برنده: «${SIZING_CONSTRAINT_FA[bindingFor(best.q) as SizingConstraintKey]}»`
          : nextLarger?.code === "inventory_limit"
            ? `حجم زیر سقف ${usdtFa(quantizedCeiling)} تتر به‌خاطر باند موجودی`
            : `سقف محاسبه‌شده ${usdtFa(quantizedCeiling)} تتر — سودآوری این حجم را تأیید کرد`
      }؛ اثر موجودی ${best.inventory.impactPoints} واحد.`,
    tieBreakFa,
    nextLarger
  };

  return {
    ...partial,
    status: "SIZED",
    sizeUsdtMicros: best.q,
    sizeUsdt: microsToUsdt(best.q),
    bindingConstraint: bindingFor(best.q),
    selection,
    inventory: best.inventory,
    quote,
    economics: best.econ,
    blockers: [],
    audit: buildAudit({
      status: "SIZED",
      sizeUsdtMicros: best.q,
      bindingConstraint: bindingFor(best.q),
      constraints,
      capacity,
      quote,
      economics: best.econ,
      inventory: best.inventory,
      blockers: [],
      selection,
      candidates,
      adaptiveMeta: candidateSet.adaptive,
      buyFeeBps,
      sellFeeBps,
      minExecutableUsdtMicros: routeMinExecutableMicros,
      ...paperFloorMeta
    })
  };
}

/**
 * Analysis-only fixed probe ladder (historical 5/10/20/25), never executable.
 */
function buildBaseline(input: {
  buyAsks: BookLevel[];
  sellBids: BookLevel[];
  buySourceId: string;
  sellSourceId: string;
  buyFeeBps: number;
  sellFeeBps: number;
  buySettlement: SideSettlement;
  sellSettlement: SideSettlement;
  slippageBufferBps: number;
  buyIrtAvailable: number;
  sellUsdtAvailable: number;
}): SizingBaseline {
  const rows: BaselineRow[] = [];
  let bestPnl: number | null = null;
  let bestSize: number | null = null;

  for (const sizeUsdt of BASELINE_FIXED_SIZES_USDT) {
    const q = usdtToMicros(sizeUsdt);
    const buyWalk = walkBook(input.buyAsks, q, "buy");
    const sellWalk = walkBook(input.sellBids, q, "sell");

    if (!buyWalk.complete || !sellWalk.complete || buyWalk.vwapToman === null || sellWalk.vwapToman === null) {
      rows.push({
        sizeUsdt,
        fillable: false,
        buyVwapToman: null,
        sellVwapToman: null,
        riskAdjustedPnlToman: null,
        riskAdjustedReturnBps: null,
        reasonFa: "عمق دفتر برای این حجم ثابت کافی نیست"
      });
      continue;
    }

    const priced = priceAt(
      q,
      { buyVwapToman: buyWalk.vwapToman, sellVwapToman: sellWalk.vwapToman },
      input.buySourceId,
      input.sellSourceId,
      input.buyFeeBps,
      input.sellFeeBps,
      input.buySettlement,
      input.sellSettlement,
      buyWalk.vwapToman,
      input.slippageBufferBps
    );

    const irtNeeded = -priced.deltas.buy.deltaIrtToman;
    const usdtNeeded = -priced.deltas.sell.deltaUsdtMicros;
    if (irtNeeded > input.buyIrtAvailable || usdtNeeded > input.sellUsdtAvailable) {
      rows.push({
        sizeUsdt,
        fillable: false,
        buyVwapToman: buyWalk.vwapToman,
        sellVwapToman: sellWalk.vwapToman,
        riskAdjustedPnlToman: null,
        riskAdjustedReturnBps: null,
        reasonFa: "موجودی آزاد برای این حجم ثابت کافی نیست"
      });
      continue;
    }

    rows.push({
      sizeUsdt,
      fillable: true,
      buyVwapToman: buyWalk.vwapToman,
      sellVwapToman: sellWalk.vwapToman,
      riskAdjustedPnlToman: priced.economics.riskAdjustedPnlToman,
      riskAdjustedReturnBps: priced.economics.riskAdjustedReturnBps,
      reasonFa: "مقایسه‌ای — این حجم اجرا نمی‌شود"
    });

    if (bestPnl === null || priced.economics.riskAdjustedPnlToman > bestPnl) {
      bestPnl = priced.economics.riskAdjustedPnlToman;
      bestSize = sizeUsdt;
    }
  }

  return {
    policy: BASELINE_POLICY,
    executable: false,
    noteFa:
      "نردبان ثابت ۵/۱۰/۲۰/۲۵ تتر فقط تحلیل است و هرگز سقف اجرا نیست؛ حجم نهایی از min(سرمایه، موجودی، عمق VWAP، سیاست) با سود خالص مثبت است.",
    rows,
    bestRiskAdjustedPnlToman: bestPnl,
    bestSizeUsdt: bestSize
  };
}

export type RouteSizing = { routeKey: string; buySourceId: string; sellSourceId: string; sizing: SizingResult };

/**
 * Size every ordered pair of execution-eligible venues.
 *
 * The read-only surfaces need the same answer the engine reached, for routes
 * the engine may not have reached at all — an operator asking "what would trade
 * right now, and why not" must get the calculation, not silence. Same pure
 * function, same inputs, so the number the screen shows is the number the
 * engine would use on the next cycle with the same evidence.
 */
export function computeAllRouteSizes(input: {
  venueIds: readonly string[];
  snapshotById: Map<string, NormalizedSourceSnapshot>;
  feeBpsById: Map<string, number | null>;
  settlementFor: (sourceId: string, side: "buy" | "sell") => SideSettlement;
  balances: VenueBalance[];
  allocationTomanBySource: Map<string, number>;
  portfolioValueToman: number | null;
  exposureTomanBySource: Map<string, number>;
  policies: RiskPolicyState[];
  slippageBufferBps: number;
  inventoryModel: InventoryModel;
  /** Per-venue dealer quotes. Absent for order-book venues. */
  quoteBySource?: Map<string, QuoteCapacityInput>;
}): RouteSizing[] {
  const out: RouteSizing[] = [];
  for (const buySourceId of input.venueIds) {
    for (const sellSourceId of input.venueIds) {
      if (buySourceId === sellSourceId) continue;
      out.push({
        routeKey: `${buySourceId}->${sellSourceId}`,
        buySourceId,
        sellSourceId,
        sizing: computeRouteSize({
          buySourceId,
          sellSourceId,
          buySnapshot: input.snapshotById.get(buySourceId),
          sellSnapshot: input.snapshotById.get(sellSourceId),
          buyFeeBps: input.feeBpsById.get(buySourceId) ?? null,
          sellFeeBps: input.feeBpsById.get(sellSourceId) ?? null,
          buySettlement: input.settlementFor(buySourceId, "buy"),
          sellSettlement: input.settlementFor(sellSourceId, "sell"),
          balances: input.balances,
          buyVenueAllocationToman: input.allocationTomanBySource.get(buySourceId) ?? null,
          portfolioValueToman: input.portfolioValueToman,
          buyVenueExposureToman: input.exposureTomanBySource.get(buySourceId) ?? null,
          policies: input.policies,
          slippageBufferBps: input.slippageBufferBps,
          inventoryModel: input.inventoryModel,
          buyQuote: input.quoteBySource?.get(buySourceId),
          sellQuote: input.quoteBySource?.get(sellSourceId)
        })
      });
    }
  }
  // Sorted by route key so the payload is byte-stable between identical reads.
  return out.sort((a, b) => a.routeKey.localeCompare(b.routeKey));
}

/**
 * Deterministic ranking of sized routes.
 *
 * Risk-adjusted profit first, then return in bps, then inventory impact, then
 * size, then the route key — so a cycle that re-runs on identical inputs applies
 * the same fills in the same order. No field in the sort is a clock, a random
 * value or an array position.
 */
export function rankSizedRoutes<T extends { routeKey: string; sizing: SizingResult }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ap = a.sizing.economics?.riskAdjustedPnlToman ?? 0;
    const bp = b.sizing.economics?.riskAdjustedPnlToman ?? 0;
    if (bp !== ap) return bp - ap;
    const ar = a.sizing.economics?.riskAdjustedReturnBps ?? 0;
    const br = b.sizing.economics?.riskAdjustedReturnBps ?? 0;
    if (br !== ar) return br - ar;
    const ai = a.sizing.inventory?.impactPoints ?? 0;
    const bi = b.sizing.inventory?.impactPoints ?? 0;
    if (ai !== bi) return ai - bi;
    const as = a.sizing.sizeUsdtMicros ?? 0;
    const bs = b.sizing.sizeUsdtMicros ?? 0;
    if (bs !== as) return bs - as;
    return a.routeKey.localeCompare(b.routeKey);
  });
}
