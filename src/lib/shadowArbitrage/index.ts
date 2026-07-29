export { SHADOW_BANNER, SHADOW_TRADE_SIZES, SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
export { buildOpportunities } from "@/lib/shadowArbitrage/calculate";
export { runShadowMatrix } from "@/lib/shadowArbitrage/engine";
export { computeAnalytics, loadHistory, loadLastMatrix } from "@/lib/shadowArbitrage/store";
export type * from "@/lib/shadowArbitrage/types";
