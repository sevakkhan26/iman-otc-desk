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
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";

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
  | "not_net_positive";

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
  not_net_positive: "سود تعدیل‌شده اکیداً مثبت نیست"
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
  /** The probe size whose VWAPs priced this fill. Always ≥ the chosen size. */
  probeSizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number;
  markPriceToman: number;
  buyAgeMs: number;
  sellAgeMs: number;
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
  /** Buffer the upstream economics already computed for this route. */
  slippageBufferBps: number;
  /** Probe ladder, largest usable entry wins. Passed in, never assumed. */
  probeSizesUsdt: readonly number[];
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
 * The deepest probe this cycle proved fillable on both legs.
 *
 * Walked largest-first so the answer is the most depth the evidence supports,
 * and the returned VWAPs belong to that probe — which is what makes pricing a
 * smaller size against them conservative rather than optimistic.
 */
function deepestProvenProbe(
  buy: NormalizedSourceSnapshot,
  sell: NormalizedSourceSnapshot,
  probeSizesUsdt: readonly number[]
): { sizeUsdt: number; buyVwapToman: number; sellVwapToman: number } | null {
  const ladder = [...probeSizesUsdt].sort((a, b) => b - a);
  for (const size of ladder) {
    const b = buy.sizeExecutables.find((x) => x.sizeUsdt === size);
    const s = sell.sizeExecutables.find((x) => x.sizeUsdt === size);
    if (!b?.buyFillable || b.userBuyVwapToman === null || b.userBuyVwapToman <= 0) continue;
    if (!s?.sellFillable || s.userSellVwapToman === null || s.userSellVwapToman <= 0) continue;
    return {
      sizeUsdt: size,
      buyVwapToman: Math.round(b.userBuyVwapToman),
      sellVwapToman: Math.round(s.userSellVwapToman)
    };
  }
  return null;
}

/**
 * Largest size the buy venue's toman can fund, in micros.
 *
 * Mirrors the broker exactly: when the buy fee settles in IRT it is ADDED to
 * the debit, so the venue must cover notional + fee; when it settles in USDT it
 * comes out of what arrives, so only the notional is funded from toman.
 */
function buyIrtCapMicros(
  irtToman: number,
  buyVwapToman: number,
  buyFeeBps: number,
  settlement: SideSettlement
): number {
  if (irtToman <= 0 || buyVwapToman <= 0) return 0;
  const perUsdt = settlement.feeAsset === "IRT" ? buyVwapToman * (1 + buyFeeBps / 10_000) : buyVwapToman;
  if (perUsdt <= 0) return 0;
  return Math.floor((irtToman / perUsdt) * 1_000_000);
}

/**
 * Largest size the sell venue's USDT can deliver, in micros.
 *
 * When the sell fee settles in USDT the venue is debited quantity PLUS fee, so
 * the balance must cover size × (1 + fee) — the fee-inclusive form. When it
 * settles in IRT the balance only has to cover the quantity itself.
 */
function sellUsdtCapMicros(
  usdtMicros: number,
  sellFeeBps: number,
  settlement: SideSettlement
): number {
  if (usdtMicros <= 0) return 0;
  if (settlement.feeAsset !== "USDT") return usdtMicros;
  return Math.floor(usdtMicros / (1 + sellFeeBps / 10_000));
}

/** Toman ceiling converted to a size cap at a given price, in micros. */
function tomanCapToMicros(capToman: number, priceToman: number): number {
  if (capToman <= 0 || priceToman <= 0) return 0;
  return Math.floor((capToman / priceToman) * 1_000_000);
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

  /* ── 5. depth evidence ────────────────────────────────────────────────── */
  const probe = deepestProvenProbe(buy, sell, input.probeSizesUsdt);
  if (!probe) {
    blockers.push(blocker("no_depth_evidence", `${input.buySourceId}→${input.sellSourceId}`));
  }

  if (blockers.length || !probe || !buyBalance || !sellBalance) {
    return blocked(blockers);
  }

  const buyFeeBps = input.buyFeeBps as number;
  const sellFeeBps = input.sellFeeBps as number;

  /* ── 6. the six caps ──────────────────────────────────────────────────── */
  const depthCap = usdtToMicros(probe.sizeUsdt);
  const irtCap = buyIrtCapMicros(buyBalance.irtToman, probe.buyVwapToman, buyFeeBps, input.buySettlement);
  const usdtCap = sellUsdtCapMicros(sellBalance.usdtMicros, sellFeeBps, input.sellSettlement);

  const allocationCap =
    input.buyVenueAllocationToman === null
      ? null
      : tomanCapToMicros(input.buyVenueAllocationToman, probe.buyVwapToman);

  const orderCap = usdtToMicros(policy.max_order_size_usdt as number);

  // Concentration: how much more the buy venue may hold before it breaches the
  // admin's per-venue ceiling. Needs both the portfolio total and this venue's
  // current share; without either it is not measurable and must not be guessed.
  let concentrationCap: number | null = null;
  let concentrationDetail = "ارزش پرتفوی یا سهم فعلی این صرافی در دسترس نیست؛ این سقف اندازه‌گیری نشد.";
  if (input.portfolioValueToman !== null && input.buyVenueExposureToman !== null) {
    const ceilingToman = Math.floor(
      (input.portfolioValueToman * (policy.max_venue_exposure_percent as number)) / 100
    );
    const headroomToman = ceilingToman - input.buyVenueExposureToman;
    concentrationCap = tomanCapToMicros(Math.max(0, headroomToman), probe.buyVwapToman);
    concentrationDetail = `سقف ${policy.max_venue_exposure_percent}٪ پرتفوی = ${ceilingToman.toLocaleString("en-US")} تومان، فضای باقی‌مانده ${Math.max(0, headroomToman).toLocaleString("en-US")} تومان`;
  }

  const constraints: SizingConstraint[] = [
    constraint(
      "depth_evidence",
      depthCap,
      `عمیق‌ترین پروبی که در همین چرخه هر دو سمت آن پر شد: ${probe.sizeUsdt} تتر`
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
      `سیاست «حداکثر حجم هر سفارش» = ${policy.max_order_size_usdt} تتر`
    ),
    constraint("venue_concentration", concentrationCap, concentrationDetail)
  ];

  /* ── 7. the minimum, split into its two halves for the report ─────────── */
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

  // Deterministic tie-break: constraint order above decides which cap is named
  // as binding when two are exactly equal.
  let sizeMicros = Number.POSITIVE_INFINITY;
  let binding: SizingConstraintKey | null = null;
  for (const c of measured) {
    if ((c.capUsdtMicros as number) < sizeMicros) {
      sizeMicros = c.capUsdtMicros as number;
      binding = c.key;
    }
  }
  sizeMicros = quantizeSizeMicros(sizeMicros);

  const partial: Omit<SizingResult, "status" | "sizeUsdtMicros" | "sizeUsdt" | "economics"> = {
    bindingConstraint: binding,
    constraints,
    liquidityMaxUsdtMicros: Number.isFinite(liquidityMax) ? liquidityMax : null,
    policyMaxUsdtMicros: policyMax,
    quote: {
      probeSizeUsdt: probe.sizeUsdt,
      buyVwapToman: probe.buyVwapToman,
      sellVwapToman: probe.sellVwapToman,
      // Same rule the broker uses: the executable buy VWAP for this cycle is
      // the honest replacement cost of the USDT a sell-side fee consumes.
      markPriceToman: probe.buyVwapToman,
      buyAgeMs: Math.round(buy.ageMs),
      sellAgeMs: Math.round(sell.ageMs)
    },
    blockers: []
  };

  if (sizeMicros < MIN_TRADEABLE_USDT_MICROS) {
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      economics: null,
      blockers: [
        blocker(
          "size_floor",
          binding ?? "unknown",
          `حجم محاسبه‌شده ${(sizeMicros / 1_000_000).toFixed(6)} تتر، کمتر از حداقل ۱ تتر؛ محدودکننده: ${binding ? SIZING_CONSTRAINT_FA[binding] : "—"}`
        )
      ]
    };
  }

  /* ── 8. price it, then gate on risk-adjusted profit ───────────────────── */
  const economics = priceAt(
    sizeMicros,
    probe,
    buyFeeBps,
    sellFeeBps,
    input.buySettlement,
    input.sellSettlement,
    probe.buyVwapToman,
    input.slippageBufferBps
  );

  if (economics.riskAdjustedPnlToman <= 0) {
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      economics,
      blockers: [
        blocker(
          "not_net_positive",
          `${economics.riskAdjustedPnlToman}`,
          `سود تعدیل‌شده ${economics.riskAdjustedPnlToman.toLocaleString("en-US")} تومان است و باید اکیداً مثبت باشد`
        )
      ]
    };
  }

  const edgeFloor = policy.min_risk_adjusted_edge_percent as number;
  if (economics.riskAdjustedEdgePercent < edgeFloor) {
    return {
      ...partial,
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      economics,
      blockers: [
        blocker(
          "edge_below_floor",
          `${economics.riskAdjustedEdgePercent}%`,
          `حاشیهٔ تعدیل‌شده ${economics.riskAdjustedEdgePercent}٪ در برابر کف سیاست ${edgeFloor}٪`
        )
      ]
    };
  }

  return {
    ...partial,
    status: "SIZED",
    sizeUsdtMicros: sizeMicros,
    sizeUsdt: microsToUsdt(sizeMicros),
    economics,
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
  probeSizesUsdt: readonly number[];
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
          probeSizesUsdt: input.probeSizesUsdt
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
