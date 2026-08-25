import { feeFromBps, mulPriceSizeToman, percentOf, round4 } from "@/lib/shadowArbitrage/money";
import { SLIPPAGE_BUFFER_BPS, getSourceConfig } from "@/lib/shadowArbitrage/config";
import type { BlockedReasonCode, ShadowSourceId } from "@/lib/shadowArbitrage/types";
import {
  computeCanonicalEconomics,
  type CanonicalFeeAsset
} from "@/lib/shadowArbitrage/paper/canonicalEconomics";
import {
  settlementCoherent,
  settlementFor,
  settlementUsable,
  type SideSettlement
} from "@/lib/shadowArbitrage/paper/broker";

export type RouteFeeBreakdown = {
  buyCostToman: number;
  sellProceedsToman: number;
  buyFeeToman: number;
  sellFeeToman: number;
  /** Exact fee denomination and amount (IRT units or USDT micros). */
  buyFeeAsset: CanonicalFeeAsset;
  sellFeeAsset: CanonicalFeeAsset;
  buyFeeAmount: number;
  sellFeeAmount: number;
  buyFeeUsdtMicros: number;
  sellFeeUsdtMicros: number;
  buyFeeBps: number;
  sellFeeBps: number;
  totalFeePercent: number;
  slippageBufferToman: number;
  rebalanceCostToman: number;
  buyDebitIrtToman: number;
  sellDebitUsdtMicros: number;
  economicNetPnlToman: number;
  riskAdjustedPnlToman: number;
  netProfitToman: number;
  netEdgePercent: number;
  rawSpreadPercent: number;
  feeUnknown: boolean;
  blocked: BlockedReasonCode[];
};

export function computeRouteEconomics(input: {
  buySourceId: ShadowSourceId;
  sellSourceId: ShadowSourceId;
  sizeUsdt: number;
  buyVwapToman: number;
  sellVwapToman: number;
  /** Exact rounded child notionals from walkBook when the caller has them. */
  buyNotionalToman?: number;
  sellNotionalToman?: number;
  /**
   * The effective taker fee per venue, in basis points.
   *
   * Phase 8E-B — PRESENCE IS AUTHORITATIVE. A venue that appears in this map is
   * answered by it, including when its value is `null`: null means the evidence
   * was checked and refused (wrong tier, wrong execution mode, expired, absent),
   * and the route must stay fee-unknown. Falling back to `cfg.feeBps` there
   * would be exactly the venue-wide default the fail-closed selector exists to
   * prevent. Only a venue the caller did not describe at all falls back to the
   * configured value.
   */
  confirmedFeeBps?: Partial<Record<ShadowSourceId, number | null>>;
  /** Venue/side settlement used by discovery, sizing, and the Paper broker. */
  buySettlement?: SideSettlement;
  sellSettlement?: SideSettlement;
}): RouteFeeBreakdown {
  const buyCfg = getSourceConfig(input.buySourceId);
  const sellCfg = getSourceConfig(input.sellSourceId);
  const buyCost = Math.round(
    input.buyNotionalToman ?? mulPriceSizeToman(input.buyVwapToman, input.sizeUsdt)
  );
  const sellProceeds = Math.round(
    input.sellNotionalToman ?? mulPriceSizeToman(input.sellVwapToman, input.sizeUsdt)
  );

  const supplied = input.confirmedFeeBps ?? {};
  const resolvedBuyFee = input.buySourceId in supplied
    ? supplied[input.buySourceId]
    : buyCfg.feeBps;
  const resolvedSellFee = input.sellSourceId in supplied
    ? supplied[input.sellSourceId]
    : sellCfg.feeBps;

  const feeUnknown =
    resolvedBuyFee === null ||
    resolvedSellFee === null ||
    resolvedBuyFee === undefined ||
    resolvedSellFee === undefined ||
    !Number.isFinite(resolvedBuyFee) ||
    !Number.isFinite(resolvedSellFee) ||
    resolvedBuyFee < 0 ||
    resolvedSellFee < 0;
  const buyFeeBps = resolvedBuyFee ?? 0;
  const sellFeeBps = resolvedSellFee ?? 0;
  const buySettlement = input.buySettlement ?? settlementFor(input.buySourceId, "buy");
  const sellSettlement = input.sellSettlement ?? settlementFor(input.sellSourceId, "sell");
  const settlementUnknown =
    !settlementUsable(buySettlement) || !settlementUsable(sellSettlement);
  const settlementUnsupported =
    !settlementUnknown &&
    (!settlementCoherent(buySettlement, "buy") || !settlementCoherent(sellSettlement, "sell"));
  const rawSpreadPercent = round4(percentOf(input.sellVwapToman - input.buyVwapToman, input.buyVwapToman));
  const slippage = feeFromBps(buyCost, SLIPPAGE_BUFFER_BPS);

  const canonical = feeUnknown || settlementUnknown || settlementUnsupported
    ? null
    : computeCanonicalEconomics({
        sizeUsdtMicros: Math.round(input.sizeUsdt * 1_000_000),
        buy: {
          complete: true,
          notionalToman: buyCost,
          vwapToman: input.buyVwapToman,
          bestPriceToman: input.buyVwapToman
        },
        sell: {
          complete: true,
          notionalToman: sellProceeds,
          vwapToman: input.sellVwapToman,
          bestPriceToman: input.sellVwapToman
        },
        buyFeeBps,
        sellFeeBps,
        buySettlement,
        sellSettlement,
        capitalMarkPriceToman: input.buyVwapToman,
        riskBufferBps: SLIPPAGE_BUFFER_BPS
      });
  const econ = canonical?.ok ? canonical.economics : null;
  const buyFeeUsdtValue = econ
    ? mulPriceSizeToman(input.buyVwapToman, econ.buyFeeUsdtMicros / 1_000_000)
    : 0;
  const sellFeeUsdtValue = econ
    ? mulPriceSizeToman(input.buyVwapToman, econ.sellFeeUsdtMicros / 1_000_000)
    : 0;
  // Legacy display fields remain toman-valued; exact denomination and amount
  // are carried separately below and are never treated as two toman fees.
  const buyFee = (econ?.buyFeeToman ?? 0) + buyFeeUsdtValue;
  const sellFee = (econ?.sellFeeToman ?? 0) + sellFeeUsdtValue;
  const netProfit = econ?.riskAdjustedPnlToman ?? 0;
  const netEdgePercent = econ ? round4(econ.netEdgeBps / 100) : 0;
  const totalFeePercent = round4(percentOf(buyFee + sellFee, buyCost));

  const blocked: BlockedReasonCode[] = [];
  if (feeUnknown || settlementUnknown || settlementUnsupported) blocked.push("fee_unknown");
  if (!feeUnknown && !settlementUnknown && !settlementUnsupported && (!econ || netProfit <= 0)) {
    blocked.push("non_positive_net");
  }

  return {
    buyCostToman: buyCost,
    sellProceedsToman: sellProceeds,
    buyFeeToman: buyFee,
    sellFeeToman: sellFee,
    buyFeeAsset: buySettlement.feeAsset,
    sellFeeAsset: sellSettlement.feeAsset,
    buyFeeAmount:
      buySettlement.feeAsset === "IRT" ? (econ?.buyFeeToman ?? 0) : (econ?.buyFeeUsdtMicros ?? 0),
    sellFeeAmount:
      sellSettlement.feeAsset === "IRT" ? (econ?.sellFeeToman ?? 0) : (econ?.sellFeeUsdtMicros ?? 0),
    buyFeeUsdtMicros: econ?.buyFeeUsdtMicros ?? 0,
    sellFeeUsdtMicros: econ?.sellFeeUsdtMicros ?? 0,
    buyFeeBps,
    sellFeeBps,
    totalFeePercent,
    slippageBufferToman: slippage,
    // No transfer is required by an ordinary round trip. A transfer-dependent
    // path is priced separately and fails closed when its cost is unknown.
    rebalanceCostToman: 0,
    buyDebitIrtToman: econ?.buyDebitIrtToman ?? 0,
    sellDebitUsdtMicros: econ?.sellDebitUsdtMicros ?? 0,
    economicNetPnlToman: econ?.economicNetPnlToman ?? 0,
    riskAdjustedPnlToman: econ?.riskAdjustedPnlToman ?? 0,
    netProfitToman: Math.round(netProfit),
    netEdgePercent,
    rawSpreadPercent,
    feeUnknown: feeUnknown || settlementUnknown || settlementUnsupported,
    blocked
  };
}
