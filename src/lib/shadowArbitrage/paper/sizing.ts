/**
 * Phase 8C-3 — deterministic dynamic sizing for PAPER execution.
 *
 * The fixed 5/10/20/25 USDT ladder is a DIAGNOSTIC PROBE of the order book, not
 * a trade size. This module turns the evidence a cycle actually produced into
 * one calculated size per route, and reports every constraint it considered so
 * the number can be argued with rather than trusted.
 *
 * The size is the minimum of six caps, each measured from real evidence:
 *
 *   1. depth      — the deepest probe this cycle proved fillable on BOTH legs;
 *   2. buy IRT    — toman on the buy venue, INCLUDING the buy fee;
 *   3. sell USDT  — USDT on the sell venue, INCLUDING the sell fee;
 *   4. allocation — the capital plan's share for the buy venue;
 *   5. order cap  — the `max_order_size_usdt` risk policy;
 *   6. exposure   — `max_venue_exposure_percent` of the portfolio, minus what
 *                   the buy venue already holds.
 *
 * Two rules make the result trustworthy rather than merely plausible:
 *
 * NO INVENTED LIMITS. Every risk value comes from an administrator-approved
 * policy. A missing, expired or invalid policy produces `size = null`, status
 * `BLOCKED` and the exact policy key — never a "sensible default". A default
 * risk limit is a limit nobody reviewed, and it would make an unapproved system
 * look ready.
 *
 * CONSERVATIVE PRICING. The persisted snapshot carries executable VWAPs only at
 * the probe sizes, so a chosen size S is priced at the VWAP of the probe P that
 * proved it, where S ≤ P. VWAP degrades monotonically with size: filling less
 * than P walks fewer levels, so the true buy VWAP is ≤ P's and the true sell
 * VWAP is ≥ P's. Pricing S at P's quotes therefore UNDERSTATES the profit. The
 * error is always in the safe direction, and it is reported, not hidden.
 *
 * Pure module: no database, no network, no clock of its own — `nowMs` is passed
 * in. It computes and explains; it never executes. Nothing here can place an
 * order, move funds, or touch a credential.
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
  buyIrtCapacityMicros,
  candidateQuantities,
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

/**
 * The policies sizing cannot proceed without.
 *
 * Each one bounds the calculation somewhere: the order cap and the exposure cap
 * bound the size directly, the freshness budget decides whether the quote may be
 * used at all, the slippage ceiling decides whether the modelled buffer is
 * acceptable, and the edge floor decides whether the result is worth executing.
 */
export const SIZING_REQUIRED_POLICIES: RiskPolicyKey[] = [
  "max_order_size_usdt",
  "max_venue_exposure_percent",
  "min_risk_adjusted_edge_percent",
  "max_quote_age_ms",
  "max_slippage_bps"
];

export type SizingConstraintKey =
  | "depth_evidence"
  | "buy_irt_balance"
  | "sell_usdt_balance"
  | "venue_allocation"
  | "policy_max_order_size"
  | "venue_concentration";

export const SIZING_CONSTRAINT_FA: Record<SizingConstraintKey, string> = {
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
  | "edge_below_floor"
  | "not_net_positive"
  | "book_invalid"
  | "quote_only_no_order_book"
  | "depth_exhausted";

export const SIZING_BLOCKER_FA: Record<SizingBlockerCode, string> = {
  missing_policy: "سیاست ریسک تعیین نشده است",
  expired_policy: "اعتبار سیاست ریسک منقضی شده است",
  stale_quote: "دادهٔ بازار از بودجهٔ تازگی عبور کرده است",
  no_depth_evidence: "این چرخه هیچ عمق اجراپذیری برای هر دو سمت اثبات نکرد",
  fee_unconfirmed: "کارمزد تأییدشدهٔ یکی از دو سمت در دسترس نیست",
  settlement_unconfirmed: "نحوهٔ تسویهٔ کارمزد تأیید نشده است",
  no_balance_record: "برای یکی از دو صرافی موجودی مجازی ثبت نشده است",
  slippage_over_limit: "بافر لغزش مدل‌شده از سقف مجاز بیشتر است",
  size_floor: "حجم محاسبه‌شده به حداقل قابل معامله نمی‌رسد",
  edge_below_floor: "حاشیهٔ تعدیل‌شده از کف سیاست کمتر است",
  not_net_positive: "سود تعدیل‌شده اکیداً مثبت نیست",
  book_invalid: "دفتر سفارش قابل استفاده نیست",
  quote_only_no_order_book: "منبع نقل‌قول تک‌قیمتی است و دفتر سفارش ندارد",
  depth_exhausted: "عمق مشاهده‌شده برای هیچ حجم قابل قبولی کافی نیست"
};

export type SizingBlocker = {
  code: SizingBlockerCode;
  /** The exact thing that is missing or wrong — a key, a number, a venue. */
  subject: string;
  detailFa: string;
};

/** Every figure the detail view shows, all integers. */
export type SizingEconomics = {
  capitalInvolvedToman: number;
  cashPnlIrtToman: number;
  sellFeeValueToman: number;
  economicNetPnlToman: number;
  slippageBufferToman: number;
  riskAdjustedPnlToman: number;
  /** riskAdjustedPnl ÷ capitalInvolved, in percent. */
  riskAdjustedEdgePercent: number;
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
};

/** One evaluated quantity on the route's profit curve. */
export type SizingCandidate = {
  sizeUsdtMicros: number;
  buyVwapToman: number;
  sellVwapToman: number;
  riskAdjustedPnlToman: number;
  economicNetPnlToman: number;
  riskAdjustedEdgePercent: number;
  buyLevels: number;
  sellLevels: number;
  bookParticipationPercent: number;
  priceImpactPercent: number;
};

export type SizingResult = {
  status: "SIZED" | "BLOCKED";
  /** Integer USDT micros. Null whenever status is BLOCKED. */
  sizeUsdtMicros: number | null;
  sizeUsdt: number | null;
  /** Which cap actually decided the size. Null when blocked. */
  bindingConstraint: SizingConstraintKey | null;
  constraints: SizingConstraint[];
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
  quote: SizingQuote | null;
  economics: SizingEconomics | null;
  blockers: SizingBlocker[];
};

/** Smallest size worth simulating: one whole USDT, in micros. */
export const MIN_TRADEABLE_USDT_MICROS = 1_000_000;

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
  /** Present only when the corresponding venue is an OTC dealer. */
  buyQuote?: QuoteCapacityInput;
  sellQuote?: QuoteCapacityInput;
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
  buyFeeBps: number,
  sellFeeBps: number,
  buySettlement: SideSettlement,
  sellSettlement: SideSettlement,
  markPriceToman: number,
  slippageBufferBps: number
): SizingEconomics {
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

  return {
    capitalInvolvedToman,
    cashPnlIrtToman,
    sellFeeValueToman,
    economicNetPnlToman,
    slippageBufferToman,
    riskAdjustedPnlToman,
    riskAdjustedEdgePercent:
      capitalInvolvedToman > 0
        ? Math.round((riskAdjustedPnlToman / capitalInvolvedToman) * 1_000_000) / 10_000
        : 0
  };
}

function blocked(blockers: SizingBlocker[], constraints: SizingConstraint[] = []): SizingResult {
  return {
    status: "BLOCKED",
    sizeUsdtMicros: null,
    sizeUsdt: null,
    bindingConstraint: null,
    constraints,
    liquidityMaxUsdtMicros: null,
    policyMaxUsdtMicros: null,
    maxFeasibleUsdtMicros: null,
    candidates: [],
    quote: null,
    economics: null,
    blockers
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

  /* ── 6. the caps ─────────────────────────────────────────────────────────
   *
   * Toman ceilings become quantity ceilings at the BEST price, which is the
   * most permissive conversion. That is deliberate: a cap must never exclude a
   * quantity before it has been priced. The honest price comes from the walk,
   * and the balance re-check after it is what actually binds.
   */
  const bestBuy = bestPriceToman(buyAsks, "buy") as number;
  const depthCap = Math.min(totalDepthMicros(buyAsks), totalDepthMicros(sellBids));
  const irtCap = buyIrtCapacityMicros(
    buyBalance.irtToman,
    bestBuy,
    buyFeeBps,
    input.buySettlement.feeAsset
  );
  const usdtCap = sellUsdtCapacityMicros(
    sellBalance.usdtMicros,
    sellFeeBps,
    input.sellSettlement.feeAsset
  );

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

  const constraints: SizingConstraint[] = [
    constraint(
      "depth_evidence",
      depthCap,
      `کمینهٔ عمق مشاهده‌شدهٔ دو دفتر: خرید ${(totalDepthMicros(buyAsks) / 1_000_000).toFixed(2)} تتر در ${buyAsks.length} سطح، فروش ${(totalDepthMicros(sellBids) / 1_000_000).toFixed(2)} تتر در ${sellBids.length} سطح`
    ),
    constraint(
      "buy_irt_balance",
      irtCap,
      `${buyBalance.irtToman.toLocaleString("en-US")} تومان با کارمزد ${buyFeeBps} bps در ${input.buySettlement.feeAsset}`
    ),
    constraint(
      "sell_usdt_balance",
      usdtCap,
      `${microsToUsdt(sellBalance.usdtMicros)} تتر با کارمزد ${sellFeeBps} bps در ${input.sellSettlement.feeAsset}`
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

  /* ── 7. evaluate the real breakpoints ────────────────────────────────────
   *
   * Profit as a function of quantity is piecewise linear between book levels,
   * so its maximum sits on a breakpoint or on a cap — never strictly between
   * two of them. Evaluating exactly that set is an exact search, not a sample.
   */
  const quantities = candidateQuantities({
    buyAsks,
    sellBids,
    capsMicros: measured.map((c) => c.capUsdtMicros as number),
    minMicros: MIN_TRADEABLE_USDT_MICROS,
    granularityMicros: SIZE_GRANULARITY_MICROS
  });

  const capCeiling = Math.min(...measured.map((c) => c.capUsdtMicros as number));
  const bindingFor = (q: number): SizingConstraintKey | null => {
    for (const c of measured) if ((c.capUsdtMicros as number) <= q) return c.key;
    return null;
  };

  const partialBase = {
    constraints,
    liquidityMaxUsdtMicros: Number.isFinite(liquidityMax) ? liquidityMax : null,
    policyMaxUsdtMicros: policyMax,
    maxFeasibleUsdtMicros: quantities.length ? quantities[quantities.length - 1] : null
  };

  if (!quantities.length) {
    return {
      ...partialBase,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: null,
      candidates: [],
      quote: null,
      economics: null,
      blockers: [
        blocker(
          "size_floor",
          bindingFor(capCeiling) ?? "unknown",
          `سقف‌ها به ${(capCeiling / 1_000_000).toFixed(6)} تتر می‌رسند که کمتر از حداقل ۱ تتر است؛ محدودکننده: ${
            bindingFor(capCeiling) ? SIZING_CONSTRAINT_FA[bindingFor(capCeiling) as SizingConstraintKey] : "—"
          }`
        )
      ]
    };
  }

  /*
   * Walk both books at every candidate. A quantity is only real when BOTH legs
   * fill completely — a short fill is not a smaller trade, it is a trade the
   * book cannot support, and extrapolating past the last level is exactly what
   * this phase forbids.
   */
  const evaluated: Array<{ q: number; buyWalk: BookWalk; sellWalk: BookWalk; econ: SizingEconomics }> = [];
  const candidates: SizingCandidate[] = [];

  for (const q of quantities) {
    const buyWalk = walkBook(buyAsks, q, "buy");
    const sellWalk = walkBook(sellBids, q, "sell");
    if (!buyWalk.complete || !sellWalk.complete) continue;
    if (buyWalk.vwapToman === null || sellWalk.vwapToman === null) continue;

    // Re-check the balance caps at the WALKED price. The pre-walk caps used the
    // best price and are therefore permissive; this is the binding check.
    const irtNeeded =
      input.buySettlement.feeAsset === "IRT"
        ? buyWalk.notionalToman + feeFromBps(buyWalk.notionalToman, buyFeeBps)
        : buyWalk.notionalToman;
    if (irtNeeded > buyBalance.irtToman) continue;

    const econ = priceAt(
      q,
      { buyVwapToman: buyWalk.vwapToman, sellVwapToman: sellWalk.vwapToman },
      buyFeeBps,
      sellFeeBps,
      input.buySettlement,
      input.sellSettlement,
      // Same rule the broker uses: the executable buy VWAP for this cycle is
      // the honest replacement cost of the USDT a sell-side fee consumes.
      buyWalk.vwapToman,
      input.slippageBufferBps
    );

    evaluated.push({ q, buyWalk, sellWalk, econ });
    candidates.push({
      sizeUsdtMicros: q,
      buyVwapToman: buyWalk.vwapToman,
      sellVwapToman: sellWalk.vwapToman,
      riskAdjustedPnlToman: econ.riskAdjustedPnlToman,
      economicNetPnlToman: econ.economicNetPnlToman,
      riskAdjustedEdgePercent: econ.riskAdjustedEdgePercent,
      buyLevels: buyWalk.fills.length,
      sellLevels: sellWalk.fills.length,
      bookParticipationPercent: Math.max(
        buyWalk.bookParticipationPercent,
        sellWalk.bookParticipationPercent
      ),
      priceImpactPercent: Math.max(buyWalk.priceImpactPercent, sellWalk.priceImpactPercent)
    });
  }

  const partial = { ...partialBase, candidates };

  if (!evaluated.length) {
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: null,
      quote: null,
      economics: null,
      blockers: [
        blocker(
          "depth_exhausted",
          `${input.buySourceId}→${input.sellSourceId}`,
          "هیچ حجم نامزدی روی هر دو دفتر به‌طور کامل پر نشد؛ فراتر از عمق مشاهده‌شده برون‌یابی نمی‌شود."
        )
      ]
    };
  }

  /*
   * 8a. Risk policies gate approval, not analysis. Everything above — caps,
   * breakpoints, walks, the whole profit curve — is already computed and is
   * returned with the block, so capacity stays inspectable while the limits
   * are still being decided.
   */
  if (policyBlockers.length) {
    const study = [...evaluated].sort(
      (a, b) => b.econ.riskAdjustedPnlToman - a.econ.riskAdjustedPnlToman || a.q - b.q
    )[0];
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: bindingFor(study.q),
      quote: {
        buyVwapToman: study.buyWalk.vwapToman as number,
        sellVwapToman: study.sellWalk.vwapToman as number,
        markPriceToman: study.buyWalk.vwapToman as number,
        buyAgeMs: Math.round(buy.ageMs),
        sellAgeMs: Math.round(sell.ageMs),
        buyWalk: study.buyWalk,
        sellWalk: study.sellWalk
      },
      economics: study.econ,
      blockers: policyBlockers
    };
  }

  /*
   * 8b. The optimum — the quantity that MAXIMISES risk-adjusted profit, which is
   * not the largest one. Past a point each extra USDT is bought higher and sold
   * lower, and total profit falls even though the trade is bigger. Ties break
   * toward the SMALLER quantity: same profit for less capital and less market
   * footprint is strictly better.
   */
  const best = [...evaluated].sort(
    (a, b) =>
      b.econ.riskAdjustedPnlToman - a.econ.riskAdjustedPnlToman ||
      b.econ.riskAdjustedEdgePercent - a.econ.riskAdjustedEdgePercent ||
      a.q - b.q
  )[0];

  const quote: SizingQuote = {
    buyVwapToman: best.buyWalk.vwapToman as number,
    sellVwapToman: best.sellWalk.vwapToman as number,
    markPriceToman: best.buyWalk.vwapToman as number,
    buyAgeMs: Math.round(buy.ageMs),
    sellAgeMs: Math.round(sell.ageMs),
    buyWalk: best.buyWalk,
    sellWalk: best.sellWalk
  };

  if (best.econ.riskAdjustedPnlToman <= 0) {
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: bindingFor(best.q),
      quote,
      economics: best.econ,
      blockers: [
        blocker(
          "not_net_positive",
          `${best.econ.riskAdjustedPnlToman}`,
          `بهترین حجم ممکن (${(best.q / 1_000_000).toFixed(4)} تتر) سود تعدیل‌شدهٔ ${best.econ.riskAdjustedPnlToman.toLocaleString("en-US")} تومان می‌دهد و باید اکیداً مثبت باشد`
        )
      ]
    };
  }

  const edgeFloor = policy.min_risk_adjusted_edge_percent as number;
  if (best.econ.riskAdjustedEdgePercent < edgeFloor) {
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: bindingFor(best.q),
      quote,
      economics: best.econ,
      blockers: [
        blocker(
          "edge_below_floor",
          `${best.econ.riskAdjustedEdgePercent}%`,
          `حاشیهٔ تعدیل‌شده ${best.econ.riskAdjustedEdgePercent}٪ در برابر کف سیاست ${edgeFloor}٪`
        )
      ]
    };
  }

  return {
    ...partial,
    status: "SIZED",
    sizeUsdtMicros: best.q,
    sizeUsdt: microsToUsdt(best.q),
    bindingConstraint: bindingFor(best.q),
    quote,
    economics: best.econ,
    blockers: []
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
 * Risk-adjusted profit first, then edge, then size, then the route key — so a
 * cycle that re-runs on identical inputs applies the same fills in the same
 * order. No field in the sort is a clock, a random value or an array position.
 */
export function rankSizedRoutes<T extends { routeKey: string; sizing: SizingResult }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    const ap = a.sizing.economics?.riskAdjustedPnlToman ?? 0;
    const bp = b.sizing.economics?.riskAdjustedPnlToman ?? 0;
    if (bp !== ap) return bp - ap;
    const ae = a.sizing.economics?.riskAdjustedEdgePercent ?? 0;
    const be = b.sizing.economics?.riskAdjustedEdgePercent ?? 0;
    if (be !== ae) return be - ae;
    const as = a.sizing.sizeUsdtMicros ?? 0;
    const bs = b.sizing.sizeUsdtMicros ?? 0;
    if (bs !== as) return bs - as;
    return a.routeKey.localeCompare(b.routeKey);
  });
}
