/** Shadow Arbitrage Phase 1 — read-only types (no real orders). */

export type MarketModel = "ORDER_BOOK" | "OTC_QUOTE" | "REFERENCE";

export type AccountStatus = "verified" | "unverified" | "unknown";

export type FeeStatus = "official" | "account_api" | "provisional" | "unknown";

export type SourceHealth = "healthy" | "degraded" | "unavailable";

export type OpportunityEligibility =
  | "EXECUTABLE_NOW"
  | "ACCOUNT_REQUIRED"
  | "REFERENCE_ONLY"
  | "BLOCKED";

export type BlockedReasonCode =
  | "fee_unknown"
  | "stale_buy_source"
  | "stale_sell_source"
  | "insufficient_buy_depth"
  | "insufficient_sell_depth"
  | "account_required"
  | "reference_only"
  | "source_unhealthy"
  | "quote_direction_unverified"
  | "market_data_missing"
  | "same_venue"
  | "non_positive_net"
  /** Venue exposes only a headline price — no walkable book to size against. */
  | "depth_unverified"
  /** OTC venue did not publish a maximum executable quantity. */
  | "quote_max_unverified"
  /** Price unit (IRR vs IRT) could not be resolved unambiguously. */
  | "units_ambiguous"
  /** Public endpoint returned a rate-limit response this cycle. */
  | "rate_limited"
  /** Source is not LIVE_VERIFIED, so execution cannot be claimed. */
  | "source_not_certified";

export const BLOCKED_REASON_FA: Record<BlockedReasonCode, string> = {
  fee_unknown: "کارمزد تأییدنشده",
  stale_buy_source: "دادهٔ منبع خرید کهنه",
  stale_sell_source: "دادهٔ منبع فروش کهنه",
  insufficient_buy_depth: "عمق خرید ناکافی",
  insufficient_sell_depth: "عمق فروش ناکافی",
  account_required: "نیاز به حساب کاربری",
  reference_only: "منبع فقط مرجع",
  source_unhealthy: "منبع ناسالم",
  quote_direction_unverified: "جهت نقل‌قول تأییدنشده",
  market_data_missing: "دادهٔ بازار موجود نیست",
  same_venue: "یک صرافی",
  non_positive_net: "سود خالص غیرمثبت",
  depth_unverified: "عمق دفتر تأییدنشده",
  quote_max_unverified: "حد اجرای OTC تأییدنشده",
  units_ambiguous: "واحد قیمت مبهم",
  rate_limited: "محدودیت نرخ درخواست",
  source_not_certified: "منبع گواهی‌نشده"
};

export type ShadowTradeSizeUsdt = 5 | 10 | 20 | 25;

export type ShadowSourceId =
  | "nobitex"
  | "wallex"
  | "tabdeal"
  | "bitpin"
  | "abantether"
  | "ramzinex"
  | "tetherland"
  | "bit24"
  | "arzinja";

/** Order-book level: price in integer toman (IRT), amount in USDT (string micros-safe). */
export type BookLevel = {
  /** Integer toman per USDT */
  priceToman: number;
  /** USDT size at this level */
  amountUsdt: number;
};

export type SizeExecutable = {
  sizeUsdt: ShadowTradeSizeUsdt;
  /** Integer toman VWAP (or flat quote) for buying USDT (user pays) */
  userBuyVwapToman: number | null;
  /** Integer toman VWAP for selling USDT (user receives) */
  userSellVwapToman: number | null;
  buyFillable: boolean;
  sellFillable: boolean;
  buyFilledUsdt: number;
  sellFilledUsdt: number;
};

/** Per-source transport facts captured on every collection attempt. */
export type SourceResponseMeta = {
  endpoint: string | null;
  httpStatus: number | null;
  latencyMs: number | null;
  attempts: number;
  rateLimited: boolean;
  timedOut: boolean;
  /** True only when a real multi-level order book was parsed. */
  depthAvailable: boolean;
  /** True when ask >= bid held after normalization (no silent swap). */
  directionVerified: boolean;
  priceUnit: "IRT" | "IRR" | "ambiguous";
  /** Free-text note explaining any normalization decision. */
  normalizationNote: string | null;
};

export type NormalizedSourceSnapshot = {
  sourceId: ShadowSourceId;
  sourceName: string;
  marketModel: MarketModel;
  accountStatus: AccountStatus;
  eligibilityBase: OpportunityEligibility;
  bestBidToman: number | null;
  bestAskToman: number | null;
  /** User buy USDT (pays this) — best ask side */
  userBuyPriceToman: number | null;
  /** User sell USDT (receives this) — best bid side */
  userSellPriceToman: number | null;
  sizeExecutables: SizeExecutable[];
  depthUsdtBid: number | null;
  depthUsdtAsk: number | null;
  maxExecutableUsdt: number | null;
  marketFeeBps: number | null;
  feeStatus: FeeStatus;
  feeLabel: string;
  feeReferenceUrl: string | null;
  feeVerifiedAt: string | null;
  sourceTimestamp: string | null;
  receivedAt: string;
  ageMs: number;
  health: SourceHealth;
  errorReason: string | null;
  degradedReason: string | null;
  /** Snapshot age exceeded SHADOW_STALE_MS at collection time. */
  stale: boolean;
  meta: SourceResponseMeta;
  /** Reasons this source cannot back an executable claim this cycle. */
  sourceBlockedReasons: BlockedReasonCode[];
  /** Diagnostic only — truncated raw summary */
  diagnostics?: Record<string, unknown>;
};

export type ShadowOpportunity = {
  id: string;
  routeKey: string;
  buySourceId: ShadowSourceId;
  sellSourceId: ShadowSourceId;
  buySourceName: string;
  sellSourceName: string;
  sizeUsdt: ShadowTradeSizeUsdt;
  buyVwapToman: number;
  sellVwapToman: number;
  rawSpreadPercent: number;
  buyFeeToman: number;
  sellFeeToman: number;
  buyFeeBps: number;
  sellFeeBps: number;
  totalFeePercent: number;
  slippageBufferToman: number;
  rebalanceCostToman: number;
  netProfitToman: number;
  netEdgePercent: number;
  buyCostToman: number;
  sellProceedsToman: number;
  eligibility: OpportunityEligibility;
  blockedReasons: BlockedReasonCode[];
  firstSeenAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  durationMs: number;
  maxNetEdgePercent: number;
  maxNetProfitToman: number;
  maxRawSpreadPercent: number;
  /** Either venue's fee is unverified — net numbers are raw potential only. */
  feeUnknown: boolean;
  /** Cycles this same lifecycle has been observed in. */
  observationCount: number;
  isActive: boolean;
  buyAgeMs: number;
  sellAgeMs: number;
};

/** One row per unique opportunity lifecycle — never one row per polling cycle. */
export type LifecycleAnalyticsRow = {
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  rawEdgePercent: number;
  netEdgePercent: number;
  estimatedNetProfitToman: number;
  maxRawSpreadPercent: number;
  maxNetEdgePercent: number;
  firstSeenAt: string;
  lastSeenAt: string;
  durationMs: number;
  observationCount: number;
  eligibility: OpportunityEligibility;
  /** Fees unverified → figures are raw potential, not expected profit. */
  feeUnknown: boolean;
  blockedReasons: BlockedReasonCode[];
};

export type SourcePerformanceRow = {
  sourceId: string;
  sourceName: string;
  certStatus: string;
  samples: number;
  healthySamples: number;
  uptimePercent: number;
  errorRatePercent: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  /** Share of samples that arrived inside the freshness budget. */
  freshnessPercent: number;
  staleSamples: number;
  lastErrorAt: string | null;
  lastError: string | null;
};

export type ShadowAnalytics = {
  collectedFrom: string | null;
  collectedTo: string | null;
  windowDays: number;
  /** Collection cycles recorded in the window. */
  runCount: number;
  successfulRuns: number;
  partialRuns: number;
  failedRuns: number;
  snapshotCount: number;
  /** successful source reads / attempted source reads over the window. */
  dataCoveragePercent: number;
  /** recorded cycles / cycles the interval implies for the elapsed window. */
  cycleCoveragePercent: number;
  uniqueLifecycles: number;
  uniqueActiveOpportunities: number;
  uniqueNetPositiveAllTime: number;
  uniqueRawPotentialOnly: number;
  medianDurationMs: number | null;
  maxDurationMs: number | null;
  medianNetEdgePercent: number | null;
  maxNetEdgePercent: number | null;
  estimatedNetPnlBySize: Record<string, number>;
  /** Ranking evidence — raw potential when fees are unverified. */
  lifecycles: LifecycleAnalyticsRow[];
  routes: Array<{
    routeKey: string;
    buySourceId: string;
    sellSourceId: string;
    sizeUsdt: number;
    count: number;
    samples: number;
    medianEdge: number | null;
    maxEdge: number | null;
    maxRawSpread: number | null;
    avgRawSpread: number | null;
    feeUnknown: boolean;
    /** "net" when both fees verified, otherwise "raw_potential". */
    rankingBasis: "net" | "raw_potential";
  }>;
  sourceUptime: SourcePerformanceRow[];
  blockedByReason: Array<{ reason: BlockedReasonCode | string; label: string; count: number }>;
  /** True when the window holds too little data to say anything useful. */
  insufficientData: boolean;
  dataNote: string;
};

export type ShadowMatrixResponse = {
  serverNow: string;
  shadowMode: true;
  banner: string;
  sizes: ShadowTradeSizeUsdt[];
  sources: NormalizedSourceSnapshot[];
  opportunities: ShadowOpportunity[];
  generatedAt: string;
  pollIntervalMs: number;
};
