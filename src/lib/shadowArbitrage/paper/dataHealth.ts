/**
 * PAPER-V2 Phase 1D — separate MARKET DATA HEALTH from EXECUTION READINESS.
 *
 * Market data health: are prices / order books being received?
 * Execution readiness: fees / account evidence / coherence gates for trading.
 * Fee unknown must block execution while raw market data stays visible when
 * collection is healthy.
 */
export type MarketDataHealthState =
  | "healthy"
  | "degraded"
  | "unavailable"
  | "unknown";

export type ExecutionReadinessState =
  | "ready"
  | "blocked_fee_unknown"
  | "blocked_fee_stale"
  | "blocked_account"
  | "blocked_reference_only"
  | "blocked_other"
  | "unknown";

export type VenueHealthSplit = {
  sourceId: string;
  marketDataHealth: MarketDataHealthState;
  executionReadiness: ExecutionReadinessState;
  /** True when books/prices can be shown even if execution is blocked. */
  marketDataVisible: boolean;
  /** True only when execution readiness is ready. */
  executionAllowed: boolean;
  executionBlockerFa: string | null;
};

export function classifyMarketDataHealth(input: {
  health: string | null | undefined;
  ageMs?: number | null;
}): MarketDataHealthState {
  if (input.health === "healthy") return "healthy";
  if (input.health === "degraded") return "degraded";
  if (input.health === "unavailable") return "unavailable";
  return "unknown";
}

export function classifyExecutionReadiness(input: {
  referenceOnly?: boolean | null;
  feeOk?: boolean | null;
  feeMiss?: string | null;
  feeStale?: boolean | null;
  takerFeeBps?: number | null;
  accountState?: string | null;
  executionEligible?: boolean | null;
  blockingReason?: string | null;
}): ExecutionReadinessState {
  if (input.referenceOnly) return "blocked_reference_only";
  if (input.feeMiss === "expired" || input.feeStale === true) {
    return "blocked_fee_stale";
  }
  if (
    input.feeOk === false ||
    input.takerFeeBps === null ||
    input.takerFeeBps === undefined ||
    input.feeMiss === "no_evidence_for_mode" ||
    input.feeMiss === "tier_mismatch" ||
    input.feeMiss === "fees_missing"
  ) {
    return "blocked_fee_unknown";
  }
  if (
    input.executionEligible === false ||
    input.accountState === "NEEDS_ACCOUNT"
  ) {
    return "blocked_account";
  }
  if (input.feeOk === true && input.takerFeeBps != null && input.executionEligible !== false) {
    return "ready";
  }
  if (input.blockingReason) return "blocked_other";
  return "unknown";
}

export function buildVenueHealthSplit(input: {
  sourceId: string;
  health: string | null | undefined;
  referenceOnly?: boolean | null;
  feeOk?: boolean | null;
  feeMiss?: string | null;
  feeStale?: boolean | null;
  takerFeeBps?: number | null;
  accountState?: string | null;
  executionEligible?: boolean | null;
  blockingReason?: string | null;
}): VenueHealthSplit {
  const marketDataHealth = classifyMarketDataHealth({ health: input.health });
  const executionReadiness = classifyExecutionReadiness(input);
  const marketDataVisible =
    marketDataHealth === "healthy" || marketDataHealth === "degraded";
  const executionAllowed = executionReadiness === "ready";
  let executionBlockerFa: string | null = null;
  if (!executionAllowed) {
    if (executionReadiness === "blocked_fee_unknown") {
      executionBlockerFa =
        input.blockingReason ?? "کارمزد نامشخص — اجرا مسدود است؛ دادهٔ بازار در صورت سالم بودن نمایش داده می‌شود.";
    } else if (executionReadiness === "blocked_fee_stale") {
      executionBlockerFa =
        input.blockingReason ?? "شواهد کارمزد منقضی/کهنه است — اجرا مسدود است.";
    } else if (executionReadiness === "blocked_reference_only") {
      executionBlockerFa = "منبع فقط مرجع است و مبنای اجرا نیست.";
    } else if (executionReadiness === "blocked_account") {
      executionBlockerFa = input.blockingReason ?? "حساب برای اجرا آماده نیست.";
    } else {
      executionBlockerFa = input.blockingReason ?? "اجرا مسدود است.";
    }
  }
  return {
    sourceId: input.sourceId,
    marketDataHealth,
    executionReadiness,
    marketDataVisible,
    executionAllowed,
    executionBlockerFa
  };
}

export type HealthSplitSummary = {
  marketDataHealthy: number;
  marketDataDegraded: number;
  marketDataUnavailable: number;
  executionReady: number;
  executionBlockedFee: number;
  executionBlockedOther: number;
};

export function summarizeHealthSplit(rows: VenueHealthSplit[]): HealthSplitSummary {
  const s: HealthSplitSummary = {
    marketDataHealthy: 0,
    marketDataDegraded: 0,
    marketDataUnavailable: 0,
    executionReady: 0,
    executionBlockedFee: 0,
    executionBlockedOther: 0
  };
  for (const r of rows) {
    if (r.marketDataHealth === "healthy") s.marketDataHealthy += 1;
    else if (r.marketDataHealth === "degraded") s.marketDataDegraded += 1;
    else if (r.marketDataHealth === "unavailable") s.marketDataUnavailable += 1;
    if (r.executionReadiness === "ready") s.executionReady += 1;
    else if (
      r.executionReadiness === "blocked_fee_unknown" ||
      r.executionReadiness === "blocked_fee_stale"
    ) {
      s.executionBlockedFee += 1;
    } else if (r.executionReadiness !== "unknown") {
      s.executionBlockedOther += 1;
    }
  }
  return s;
}

/**
 * PAPER-V2 economic-liveness — three-way health split.
 * Infra healthy must never be read as economics healthy.
 */
export type ThreeWayHealthSplit = {
  infraHealth: "healthy" | "degraded" | "stopped" | "unknown";
  marketDataHealth: MarketDataHealthState;
  economicLiveness:
    | "HEALTHY"
    | "WARNING"
    | "CRITICAL"
    | "ECONOMICS_DEGRADED"
    | "ECONOMICS_INVALID"
    | "NO_EXECUTABLE_OPPORTUNITIES"
    | "unknown";
  /** Always false — documented invariant for supervisors. */
  infraImpliesEconomics: false;
};

export function buildThreeWayHealthSplit(input: {
  infraHealth: ThreeWayHealthSplit["infraHealth"];
  marketDataHealth: MarketDataHealthState;
  economicLiveness: ThreeWayHealthSplit["economicLiveness"];
}): ThreeWayHealthSplit {
  return {
    infraHealth: input.infraHealth,
    marketDataHealth: input.marketDataHealth,
    economicLiveness: input.economicLiveness,
    infraImpliesEconomics: false
  };
}
