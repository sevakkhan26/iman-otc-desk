import { feeFromBps, mulPriceSizeToman, percentOf, round4 } from "@/lib/shadowArbitrage/money";
import {
  REBALANCE_COST_TOMAN,
  SLIPPAGE_BUFFER_BPS,
  getSourceConfig
} from "@/lib/shadowArbitrage/config";
import type { BlockedReasonCode, ShadowSourceId } from "@/lib/shadowArbitrage/types";

export type RouteFeeBreakdown = {
  buyCostToman: number;
  sellProceedsToman: number;
  buyFeeToman: number;
  sellFeeToman: number;
  buyFeeBps: number;
  sellFeeBps: number;
  totalFeePercent: number;
  slippageBufferToman: number;
  rebalanceCostToman: number;
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
}): RouteFeeBreakdown {
  const buyCfg = getSourceConfig(input.buySourceId);
  const sellCfg = getSourceConfig(input.sellSourceId);
  const buyCost = mulPriceSizeToman(input.buyVwapToman, input.sizeUsdt);
  const sellProceeds = mulPriceSizeToman(input.sellVwapToman, input.sizeUsdt);

  const feeUnknown = buyCfg.feeBps === null || sellCfg.feeBps === null;
  const buyFeeBps = buyCfg.feeBps ?? 0;
  const sellFeeBps = sellCfg.feeBps ?? 0;
  const buyFee = feeUnknown ? 0 : feeFromBps(buyCost, buyFeeBps);
  const sellFee = feeUnknown ? 0 : feeFromBps(sellProceeds, sellFeeBps);
  const slippage = feeFromBps(buyCost, SLIPPAGE_BUFFER_BPS);
  const rebalance = REBALANCE_COST_TOMAN;

  const rawSpreadPercent = round4(percentOf(input.sellVwapToman - input.buyVwapToman, input.buyVwapToman));

  const netProfit = sellProceeds - buyCost - buyFee - sellFee - slippage - rebalance;
  const netEdgePercent = round4(percentOf(netProfit, buyCost));
  const totalFeePercent = round4(percentOf(buyFee + sellFee, buyCost));

  const blocked: BlockedReasonCode[] = [];
  if (feeUnknown) blocked.push("fee_unknown");
  if (!feeUnknown && netProfit <= 0) blocked.push("non_positive_net");

  return {
    buyCostToman: buyCost,
    sellProceedsToman: sellProceeds,
    buyFeeToman: buyFee,
    sellFeeToman: sellFee,
    buyFeeBps,
    sellFeeBps,
    totalFeePercent,
    slippageBufferToman: slippage,
    rebalanceCostToman: rebalance,
    netProfitToman: Math.round(netProfit),
    netEdgePercent,
    rawSpreadPercent,
    feeUnknown,
    blocked
  };
}
