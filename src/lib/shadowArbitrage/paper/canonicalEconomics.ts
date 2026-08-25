/**
 * Canonical PAPER/FAKE route economics.
 *
 * This module is pure accounting. It has no exchange, database, network, or
 * credential dependency. Discovery, sizing, and the simulated broker all call
 * this function so there is exactly one decision-time PnL formula.
 */
import { feeFromBps, mulPriceSizeToman } from "@/lib/shadowArbitrage/money";

export const CANONICAL_ECONOMICS_VERSION = "PAPER_ECONOMICS_V3" as const;
export const USDT_MICROS_PER_UNIT = 1_000_000;

export type CanonicalFeeAsset = "IRT" | "USDT" | "UNKNOWN";
export type CanonicalFeeDebitMode = "ADD_TO_DEBIT" | "DEDUCT_FROM_CREDIT" | "UNKNOWN";
export type CanonicalSettlement = {
  feeAsset: CanonicalFeeAsset;
  debitMode: CanonicalFeeDebitMode;
  provenance: "ADMIN_CONFIRMED" | "UNKNOWN";
};

export type CanonicalEconomicsFailureCode =
  | "invalid_quantity"
  | "incomplete_two_leg_walk"
  | "invalid_price"
  | "fee_unknown"
  | "settlement_unknown"
  | "settlement_unsupported"
  | "mark_price_unavailable"
  | "rebalance_required_unpriced";

export type CanonicalLegInput = {
  complete: boolean;
  notionalToman: number;
  vwapToman: number;
  bestPriceToman: number;
};

export type CanonicalEconomicsInput = {
  sizeUsdtMicros: number;
  buy: CanonicalLegInput;
  sell: CanonicalLegInput;
  buyFeeBps: number | null;
  sellFeeBps: number | null;
  buySettlement: CanonicalSettlement;
  sellSettlement: CanonicalSettlement;
  /** Session capital mark used only for K/capital-efficiency. */
  capitalMarkPriceToman: number | null;
  /** Existing approved latency/risk buffer, normally 5 bps. */
  riskBufferBps?: number;
  /** Broker callers may supply the already-computed integer buffer. */
  riskBufferToman?: number;
  /** Non-negative only. Improving inventory cannot create a PnL bonus. */
  inventoryPenaltyToman?: number;
  /** A transfer-dependent route must supply a positive, priced cost. */
  rebalanceRequired?: boolean;
  rebalanceCostToman?: number | null;
};

export type CanonicalEconomics = {
  version: typeof CANONICAL_ECONOMICS_VERSION;
  sizeUsdtMicros: number;
  sizeUsdt: number;
  buyNotionalToman: number;
  sellNotionalToman: number;
  buyVwapToman: number;
  sellVwapToman: number;
  buyFeeToman: number;
  sellFeeToman: number;
  buyFeeUsdtMicros: number;
  sellFeeUsdtMicros: number;
  totalFeeUsdtMicros: number;
  usdtFeeValueToman: number;
  buyDebitIrtToman: number;
  sellDebitUsdtMicros: number;
  cashPnlIrtToman: number;
  inventoryDeltaUsdtMicros: number;
  economicNetPnlToman: number;
  observedImpactToman: number;
  riskBufferMarketToman: number;
  inventoryPenaltyToman: number;
  rebalanceCostToman: number;
  riskBufferToman: number;
  riskAdjustedPnlToman: number;
  netEdgeBps: number;
  capitalLockedToman: number;
  capitalEfficiencyBps: number;
  buyDeltaIrtToman: number;
  buyDeltaUsdtMicros: number;
  sellDeltaIrtToman: number;
  sellDeltaUsdtMicros: number;
};

export type CanonicalEconomicsResult =
  | { ok: true; economics: CanonicalEconomics }
  | { ok: false; code: CanonicalEconomicsFailureCode };

export function canonicalSettlementCoherent(
  settlement: CanonicalSettlement,
  side: "buy" | "sell"
): boolean {
  const debitAsset = side === "buy" ? "IRT" : "USDT";
  return settlement.debitMode === "ADD_TO_DEBIT"
    ? settlement.feeAsset === debitAsset
    : settlement.debitMode === "DEDUCT_FROM_CREDIT" && settlement.feeAsset !== debitAsset;
}

function roundBps(value: number, denominator: number): number {
  if (!(denominator > 0)) return 0;
  return Math.round((value / denominator) * 10_000 * 100) / 100;
}

/**
 * Price a completely walked two-leg simulated route.
 *
 * USDT fees are marked at THIS quantity's buy VWAP. Book impact is already in
 * the walked notionals and is reported, never deducted a second time.
 */
export function computeCanonicalEconomics(
  input: CanonicalEconomicsInput
): CanonicalEconomicsResult {
  const q = Math.round(input.sizeUsdtMicros);
  if (!(q > 0) || !Number.isSafeInteger(q)) return { ok: false, code: "invalid_quantity" };
  if (!input.buy.complete || !input.sell.complete) {
    return { ok: false, code: "incomplete_two_leg_walk" };
  }
  const prices = [
    input.buy.notionalToman,
    input.sell.notionalToman,
    input.buy.vwapToman,
    input.sell.vwapToman,
    input.buy.bestPriceToman,
    input.sell.bestPriceToman
  ];
  if (prices.some((n) => !Number.isFinite(n) || n <= 0)) {
    return { ok: false, code: "invalid_price" };
  }
  if (
    input.buyFeeBps === null ||
    input.sellFeeBps === null ||
    !Number.isFinite(input.buyFeeBps) ||
    !Number.isFinite(input.sellFeeBps) ||
    input.buyFeeBps < 0 ||
    input.sellFeeBps < 0
  ) {
    return { ok: false, code: "fee_unknown" };
  }
  if (
    input.buySettlement.provenance !== "ADMIN_CONFIRMED" ||
    input.sellSettlement.provenance !== "ADMIN_CONFIRMED" ||
    input.buySettlement.feeAsset === "UNKNOWN" ||
    input.sellSettlement.feeAsset === "UNKNOWN"
  ) {
    return { ok: false, code: "settlement_unknown" };
  }
  if (
    !canonicalSettlementCoherent(input.buySettlement, "buy") ||
    !canonicalSettlementCoherent(input.sellSettlement, "sell")
  ) {
    return { ok: false, code: "settlement_unsupported" };
  }
  if (!(input.capitalMarkPriceToman && input.capitalMarkPriceToman > 0)) {
    return { ok: false, code: "mark_price_unavailable" };
  }
  if (
    input.rebalanceRequired &&
    !(input.rebalanceCostToman !== null && input.rebalanceCostToman !== undefined && input.rebalanceCostToman > 0)
  ) {
    return { ok: false, code: "rebalance_required_unpriced" };
  }

  const buyNotional = Math.round(input.buy.notionalToman);
  const sellNotional = Math.round(input.sell.notionalToman);
  const buyFeeToman =
    input.buySettlement.feeAsset === "IRT" ? feeFromBps(buyNotional, input.buyFeeBps) : 0;
  const sellFeeToman =
    input.sellSettlement.feeAsset === "IRT" ? feeFromBps(sellNotional, input.sellFeeBps) : 0;
  const buyFeeUsdtMicros =
    input.buySettlement.feeAsset === "USDT"
      ? Math.round((q * input.buyFeeBps) / 10_000)
      : 0;
  const sellFeeUsdtMicros =
    input.sellSettlement.feeAsset === "USDT"
      ? Math.round((q * input.sellFeeBps) / 10_000)
      : 0;

  const buyDeltaIrtToman = -(buyNotional + buyFeeToman);
  const buyDeltaUsdtMicros = q - buyFeeUsdtMicros;
  const sellDeltaIrtToman = sellNotional - sellFeeToman;
  const sellDeltaUsdtMicros = -(q + sellFeeUsdtMicros);
  const cashPnlIrtToman = buyDeltaIrtToman + sellDeltaIrtToman;
  const inventoryDeltaUsdtMicros = buyDeltaUsdtMicros + sellDeltaUsdtMicros;
  const totalFeeUsdtMicros = buyFeeUsdtMicros + sellFeeUsdtMicros;

  // Canonical fee replacement mark: THIS-q buy VWAP, never a session/global mark.
  const usdtFeeValueToman = mulPriceSizeToman(
    Math.round(input.buy.vwapToman),
    totalFeeUsdtMicros / USDT_MICROS_PER_UNIT
  );
  const economicNetPnlToman =
    cashPnlIrtToman +
    mulPriceSizeToman(
      Math.round(input.buy.vwapToman),
      inventoryDeltaUsdtMicros / USDT_MICROS_PER_UNIT
    );

  const qUnits = q / USDT_MICROS_PER_UNIT;
  const observedImpactToman =
    buyNotional - mulPriceSizeToman(input.buy.bestPriceToman, qUnits) +
    mulPriceSizeToman(input.sell.bestPriceToman, qUnits) - sellNotional;
  const riskBufferMarketToman =
    input.riskBufferToman === undefined
      ? feeFromBps(buyNotional, Math.max(0, input.riskBufferBps ?? 0))
      : Math.max(0, Math.round(input.riskBufferToman));
  const inventoryPenaltyToman = Math.max(0, Math.round(input.inventoryPenaltyToman ?? 0));
  const rebalanceCostToman = input.rebalanceRequired
    ? Math.max(0, Math.round(input.rebalanceCostToman ?? 0))
    : 0;
  const riskBufferToman = riskBufferMarketToman + inventoryPenaltyToman + rebalanceCostToman;
  const riskAdjustedPnlToman = economicNetPnlToman - riskBufferToman;
  const buyDebitIrtToman = -buyDeltaIrtToman;
  const sellDebitUsdtMicros = -sellDeltaUsdtMicros;
  const capitalLockedToman =
    buyDebitIrtToman +
    mulPriceSizeToman(
      Math.round(input.capitalMarkPriceToman),
      sellDebitUsdtMicros / USDT_MICROS_PER_UNIT
    );

  return {
    ok: true,
    economics: {
      version: CANONICAL_ECONOMICS_VERSION,
      sizeUsdtMicros: q,
      sizeUsdt: qUnits,
      buyNotionalToman: buyNotional,
      sellNotionalToman: sellNotional,
      buyVwapToman: Math.round(input.buy.vwapToman),
      sellVwapToman: Math.round(input.sell.vwapToman),
      buyFeeToman,
      sellFeeToman,
      buyFeeUsdtMicros,
      sellFeeUsdtMicros,
      totalFeeUsdtMicros,
      usdtFeeValueToman,
      buyDebitIrtToman,
      sellDebitUsdtMicros,
      cashPnlIrtToman,
      inventoryDeltaUsdtMicros,
      economicNetPnlToman,
      observedImpactToman,
      riskBufferMarketToman,
      inventoryPenaltyToman,
      rebalanceCostToman,
      riskBufferToman,
      riskAdjustedPnlToman,
      netEdgeBps: roundBps(riskAdjustedPnlToman, buyDebitIrtToman),
      capitalLockedToman,
      capitalEfficiencyBps: roundBps(riskAdjustedPnlToman, capitalLockedToman),
      buyDeltaIrtToman,
      buyDeltaUsdtMicros,
      sellDeltaIrtToman,
      sellDeltaUsdtMicros
    }
  };
}
