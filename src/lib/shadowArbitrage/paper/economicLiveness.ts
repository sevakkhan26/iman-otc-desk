/**
 * PAPER-V2 Economic liveness monitoring.
 *
 * Splits INFRA HEALTH / MARKET DATA HEALTH / ECONOMIC LIVENESS so that
 * Docker/ops infra HEALTHY + advancing cycles never imply economically-alive
 * Paper. Detectors: NO-FILL, FEE-BLOCK, POSITIVE-NET dropout. Validity model
 * VALID | WARNING | ECONOMICS_DEGRADED | ECONOMICS_INVALID with immutable
 * first_degraded_at. Pure + testable; wiring is thin.
 *
 * Does NOT loosen economics/risk/sizing/coherence thresholds.
 * Does NOT conflate with ops/health.ts Docker infra liveness.
 */
import type { VenueEffectiveFee } from "@/lib/shadowArbitrage/effectiveFees";
import {
  assessRuntimeFeeHorizon,
  feeExpiryWarnings,
  type FeeExpiryWarning,
  type FeeHorizonBlocker
} from "@/lib/shadowArbitrage/paper/feeHorizon";
import {
  classifyMarketDataHealth,
  type MarketDataHealthState
} from "@/lib/shadowArbitrage/paper/dataHealth";

export const ECONOMIC_LIVENESS_DEFAULTS = {
  /** Hours without a fill while candidates keep evaluating → WARNING. */
  noFillWarningHours: 3,
  /** Hours without a fill while candidates keep evaluating → CRITICAL. */
  noFillCriticalHours: 6,
  /** Hours of raw-positive>0 with positive-net=0 → WARNING. */
  positiveNetDropoutWarningHours: 1,
  /** Hours of raw-positive>0 with positive-net=0 → CRITICAL. */
  positiveNetDropoutCriticalHours: 3,
  /** Rolling fee_unknown share of rejects that triggers alert. */
  feeUnknownRejectRatio: 0.5,
  /** Consecutive completed cycles at/above feeUnknownRejectRatio. */
  feeUnknownConsecutiveCycles: 5
} as const;

export type EconomicLivenessThresholds = {
  noFillWarningHours: number;
  noFillCriticalHours: number;
  positiveNetDropoutWarningHours: number;
  positiveNetDropoutCriticalHours: number;
  feeUnknownRejectRatio: number;
  feeUnknownConsecutiveCycles: number;
};

export type InfraHealthStatus = "healthy" | "degraded" | "stopped" | "unknown";
export type AggregateMarketDataHealth = MarketDataHealthState;

export type EconomicLivenessLevel =
  | "HEALTHY"
  | "WARNING"
  | "CRITICAL"
  | "ECONOMICS_DEGRADED"
  | "ECONOMICS_INVALID"
  | "NO_EXECUTABLE_OPPORTUNITIES";

export type ExperimentValidityState =
  | "VALID"
  | "WARNING"
  | "ECONOMICS_DEGRADED"
  | "ECONOMICS_INVALID";

export type NoFillClassification =
  | "OK"
  | "NO_EXECUTABLE_OPPORTUNITIES"
  | "EXECUTION_STALLED"
  | "WARNING"
  | "CRITICAL";

export type AlertSeverity = "WARNING" | "CRITICAL";

export type EconomicAlert = {
  code:
    | "NO_FILL_WARNING"
    | "NO_FILL_CRITICAL"
    | "FEE_BLOCK_IMMEDIATE"
    | "FEE_UNKNOWN_ROLLING"
    | "FEE_EXPIRY_T_24H"
    | "FEE_EXPIRY_T_6H"
    | "POSITIVE_NET_DROPOUT_WARNING"
    | "POSITIVE_NET_DROPOUT_CRITICAL"
    | "ECONOMICS_INVALID";
  severity: AlertSeverity;
  message: string;
  detail?: Record<string, unknown>;
};

export type CycleFunnelCounts = {
  candidatesEvaluated: number;
  rawPositive: number;
  positiveNet: number;
  selected: number;
  filled: number;
  rejects: number;
  rejectDistribution: Record<string, number>;
};

export type DominantDropoutCause = {
  category: "fee" | "slippage" | "buffer" | "reject" | "unknown";
  code: string;
  count: number;
  share: number;
};

export type FeeBlockerExact = FeeHorizonBlocker & {
  mode?: string | null;
};

/** Persisted / rolling monitor state (JSON-safe). */
export type EconomicLivenessPersistedState = {
  version: "economic_liveness_v1";
  lastFillAt: string | null;
  hoursSinceFill: number | null;
  firstDegradedAt: string | null;
  validityState: ExperimentValidityState;
  validityReasons: string[];
  feeUnknownStreak: number;
  /** ISO when rawPositive>0 && positiveNet==0 streak began; null when broken. */
  rawPositiveWithoutNetSince: string | null;
  lastCycleAt: string | null;
  lastFunnel: CycleFunnelCounts | null;
  /** Earliest wall-clock when validity left VALID (immutable once set). */
  firstDegradedAtSource?: string | null;
};

export type HealthSplitReport = {
  infraHealth: InfraHealthStatus;
  marketDataHealth: AggregateMarketDataHealth;
  economicLiveness: EconomicLivenessLevel;
  /** Explicit: infra healthy must never imply economics healthy. */
  infraImpliesEconomics: false;
};

export type EconomicLivenessAssessment = {
  health: HealthSplitReport;
  validityState: ExperimentValidityState;
  firstDegradedAt: string | null;
  validityReasons: string[];
  lastFillAt: string | null;
  hoursSinceFill: number | null;
  noFill: {
    classification: NoFillClassification;
    candidateEvaluationContinuing: boolean;
  };
  feeBlocks: {
    immediateCritical: boolean;
    blockers: FeeBlockerExact[];
    rollingFeeUnknownAlert: boolean;
    feeUnknownStreak: number;
    feeUnknownShareLastCycle: number | null;
    expiryWarnings: FeeExpiryWarning[];
  };
  positiveNetDropout: {
    active: boolean;
    since: string | null;
    hours: number | null;
    severity: AlertSeverity | null;
    dominantCauses: DominantDropoutCause[];
  };
  funnel: CycleFunnelCounts;
  alerts: EconomicAlert[];
  nextPersisted: EconomicLivenessPersistedState;
  /** Machine-readable supervisor payload (authoritative over terminal text). */
  supervisorPayload: SupervisorEconomicPayload;
};

export type SupervisorEconomicPayload = {
  version: "supervisor_economic_liveness_v1";
  assessedAt: string;
  infraHealth: InfraHealthStatus;
  marketDataHealth: AggregateMarketDataHealth;
  economicLivenessStatus: EconomicLivenessLevel;
  validityState: ExperimentValidityState;
  last_fill_at: string | null;
  hours_since_fill: number | null;
  rolling_funnel_counts: CycleFunnelCounts;
  reject_distribution: Record<string, number>;
  fee_blockers: FeeBlockerExact[];
  first_degraded_at: string | null;
  validity_reasons: string[];
  alerts: EconomicAlert[];
  fee_expiry_warnings: FeeExpiryWarning[];
  no_fill_classification: NoFillClassification;
  positive_net_dropout: {
    active: boolean;
    since: string | null;
    hours: number | null;
    severity: AlertSeverity | null;
    dominant_causes: DominantDropoutCause[];
  };
  terminal_output_authoritative: false;
};

export type EndReportValidityWindows = {
  validWindow: { from: string | null; to: string | null };
  invalidWindow: { from: string | null; to: string | null };
  firstDegradedAt: string | null;
  validityStateAtEnd: ExperimentValidityState;
  note: string;
};

export type OpportunityFunnelInput = {
  buyVwapToman: number;
  sellVwapToman: number;
  netProfitToman: number;
  feeUnknown?: boolean;
  isActive?: boolean;
};

export type DecisionFunnelInput = {
  kind: "EXECUTE" | "SKIP";
  code?: string;
  codes?: string[];
  buyVwapToman?: number;
  sellVwapToman?: number;
  netProfitToman?: number;
};

function hoursBetween(fromIso: string | null, nowMs: number): number | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (nowMs - t) / (60 * 60 * 1000));
}

function mergeThresholds(
  partial?: Partial<EconomicLivenessThresholds> | null
): EconomicLivenessThresholds {
  return {
    noFillWarningHours:
      partial?.noFillWarningHours ?? ECONOMIC_LIVENESS_DEFAULTS.noFillWarningHours,
    noFillCriticalHours:
      partial?.noFillCriticalHours ?? ECONOMIC_LIVENESS_DEFAULTS.noFillCriticalHours,
    positiveNetDropoutWarningHours:
      partial?.positiveNetDropoutWarningHours ??
      ECONOMIC_LIVENESS_DEFAULTS.positiveNetDropoutWarningHours,
    positiveNetDropoutCriticalHours:
      partial?.positiveNetDropoutCriticalHours ??
      ECONOMIC_LIVENESS_DEFAULTS.positiveNetDropoutCriticalHours,
    feeUnknownRejectRatio:
      partial?.feeUnknownRejectRatio ?? ECONOMIC_LIVENESS_DEFAULTS.feeUnknownRejectRatio,
    feeUnknownConsecutiveCycles:
      partial?.feeUnknownConsecutiveCycles ??
      ECONOMIC_LIVENESS_DEFAULTS.feeUnknownConsecutiveCycles
  };
}

/** Classify aggregate market-data health from per-venue health strings. */
export function aggregateMarketDataHealth(
  venueHealth: Array<string | null | undefined>
): AggregateMarketDataHealth {
  if (!venueHealth.length) return "unknown";
  const states = venueHealth.map((h) => classifyMarketDataHealth({ health: h }));
  if (states.every((s) => s === "healthy")) return "healthy";
  if (states.some((s) => s === "unavailable")) {
    return states.every((s) => s === "unavailable") ? "unavailable" : "degraded";
  }
  if (states.some((s) => s === "degraded" || s === "unknown")) return "degraded";
  return "healthy";
}

/**
 * Build cycle funnel from opportunities + decisions.
 * raw-positive = gross (sellVwap − buyVwap) > 0
 * positive-net = known-fee netProfitToman > 0
 */
export function buildCycleFunnel(input: {
  opportunities?: OpportunityFunnelInput[];
  decisions?: DecisionFunnelInput[];
  filledCount?: number;
}): CycleFunnelCounts {
  const rejectDistribution: Record<string, number> = {};
  let candidatesEvaluated = 0;
  let rawPositive = 0;
  let positiveNet = 0;
  let selected = 0;
  let rejects = 0;

  const opps = input.opportunities ?? [];
  if (opps.length) {
    candidatesEvaluated = opps.length;
    for (const o of opps) {
      const gross = o.sellVwapToman - o.buyVwapToman;
      if (Number.isFinite(gross) && gross > 0) rawPositive += 1;
      if (!o.feeUnknown && Number.isFinite(o.netProfitToman) && o.netProfitToman > 0) {
        positiveNet += 1;
      }
    }
  }

  const decisions = input.decisions ?? [];
  if (decisions.length) {
    if (!opps.length) candidatesEvaluated = decisions.length;
    for (const d of decisions) {
      if (d.kind === "EXECUTE") {
        selected += 1;
        continue;
      }
      rejects += 1;
      const code = d.code ?? d.codes?.[0] ?? "unknown";
      rejectDistribution[code] = (rejectDistribution[code] ?? 0) + 1;
      // When no opportunities provided, derive raw/net from decision snapshot.
      if (!opps.length) {
        if (
          d.buyVwapToman != null &&
          d.sellVwapToman != null &&
          Number.isFinite(d.buyVwapToman) &&
          Number.isFinite(d.sellVwapToman) &&
          d.sellVwapToman - d.buyVwapToman > 0
        ) {
          rawPositive += 1;
        }
        if (d.netProfitToman != null && d.netProfitToman > 0) {
          positiveNet += 1;
        }
      }
    }
  }

  const filled =
    input.filledCount != null
      ? input.filledCount
      : decisions.filter((d) => d.kind === "EXECUTE").length;

  return {
    candidatesEvaluated,
    rawPositive,
    positiveNet,
    selected,
    filled,
    rejects,
    rejectDistribution
  };
}

export function attributeDominantDropoutCauses(
  rejectDistribution: Record<string, number>
): DominantDropoutCause[] {
  const entries = Object.entries(rejectDistribution);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  if (total === 0) return [];

  const categorized = entries.map(([code, count]) => {
    let category: DominantDropoutCause["category"] = "reject";
    if (
      code === "fee_unknown" ||
      code === "fee_stale" ||
      code.startsWith("fee_")
    ) {
      category = "fee";
    } else if (code.includes("slippage") || code === "slippage_exceeded") {
      category = "slippage";
    } else if (
      code.includes("buffer") ||
      code === "net_non_positive" ||
      code === "not_net_positive" ||
      code === "non_positive_net"
    ) {
      category = "buffer";
    }
    return {
      category,
      code,
      count,
      share: Math.round((count / total) * 10_000) / 10_000
    };
  });

  return categorized.sort(
    (a, b) => b.count - a.count || a.code.localeCompare(b.code)
  );
}

function emptyFunnel(): CycleFunnelCounts {
  return {
    candidatesEvaluated: 0,
    rawPositive: 0,
    positiveNet: 0,
    selected: 0,
    filled: 0,
    rejects: 0,
    rejectDistribution: {}
  };
}

export function emptyPersistedState(): EconomicLivenessPersistedState {
  return {
    version: "economic_liveness_v1",
    lastFillAt: null,
    hoursSinceFill: null,
    firstDegradedAt: null,
    validityState: "VALID",
    validityReasons: [],
    feeUnknownStreak: 0,
    rawPositiveWithoutNetSince: null,
    lastCycleAt: null,
    lastFunnel: null,
    firstDegradedAtSource: null
  };
}

function validityRank(s: ExperimentValidityState): number {
  switch (s) {
    case "VALID":
      return 0;
    case "WARNING":
      return 1;
    case "ECONOMICS_DEGRADED":
      return 2;
    case "ECONOMICS_INVALID":
      return 3;
  }
}

/**
 * Merge validity: severity only escalates (or stays). firstDegradedAt is
 * immutable once set. Refreshing fees before expiry may clear WARNING back
 * toward VALID only when never degraded/invalid.
 */
export function mergeValidityState(input: {
  prior: EconomicLivenessPersistedState | null | undefined;
  proposed: ExperimentValidityState;
  reasons: string[];
  nowIso: string;
  /** When true, allow WARNING→VALID / clear soft warnings (fee refreshed). */
  allowRecoverWarnings?: boolean;
}): {
  validityState: ExperimentValidityState;
  firstDegradedAt: string | null;
  validityReasons: string[];
} {
  const prior = input.prior ?? emptyPersistedState();
  const priorDegraded = prior.firstDegradedAt;
  let next = input.proposed;

  // Once INVALID or DEGRADED, never silently return to VALID.
  if (prior.validityState === "ECONOMICS_INVALID") {
    next = "ECONOMICS_INVALID";
  } else if (
    prior.validityState === "ECONOMICS_DEGRADED" &&
    validityRank(next) < validityRank("ECONOMICS_DEGRADED")
  ) {
    next = "ECONOMICS_DEGRADED";
  } else if (
    !input.allowRecoverWarnings &&
    validityRank(next) < validityRank(prior.validityState)
  ) {
    next = prior.validityState;
  }

  const crossedDegraded =
    (next === "ECONOMICS_DEGRADED" || next === "ECONOMICS_INVALID") &&
    !priorDegraded;

  const firstDegradedAt = priorDegraded ?? (crossedDegraded ? input.nowIso : null);

  const reasons =
    next === "VALID"
      ? []
      : Array.from(new Set([...(prior.validityReasons ?? []), ...input.reasons]));

  return { validityState: next, firstDegradedAt, validityReasons: reasons };
}

/**
 * Immediate CRITICAL fee blockers: required executable venue blocked by
 * expired / tier-mismatched / missing fee during a valid run.
 */
export function detectImmediateFeeBlocks(input: {
  venues: VenueEffectiveFee[];
  nowMs: number;
  requiredSourceIds?: string[] | null;
}): { critical: boolean; blockers: FeeBlockerExact[] } {
  const runtime = assessRuntimeFeeHorizon({
    venues: input.venues,
    nowMs: input.nowMs,
    requiredSourceIds: input.requiredSourceIds
  });

  const required = input.requiredSourceIds?.length
    ? new Set(input.requiredSourceIds)
    : null;
  const blockers: FeeBlockerExact[] = [...runtime.expired];

  for (const v of input.venues) {
    if (v.executable !== true || v.executionMode === null) continue;
    if (required && !required.has(v.sourceId)) continue;
    if (v.ok && v.takerFeeBps != null) continue;

    const miss = v.miss;
    const isBlock =
      miss === "expired" ||
      miss === "tier_mismatch" ||
      miss === "fees_missing" ||
      miss === "no_evidence_for_mode" ||
      (!v.ok && (v.takerFeeBps === null || v.takerFeeBps === undefined));

    if (!isBlock) continue;
    if (blockers.some((b) => b.sourceId === v.sourceId && b.miss === miss)) continue;

    blockers.push({
      sourceId: v.sourceId,
      executionMode: v.executionMode,
      mode: v.executionMode,
      tierLabel: v.evidenceTierLabel ?? v.currentTierLabel,
      expiresAt: v.expiresAt,
      miss: miss ?? "fees_missing",
      reason:
        miss === "expired"
          ? "already_expired"
          : miss === "tier_mismatch"
            ? "tier_mismatch"
            : miss === "fees_missing"
              ? "fees_missing"
              : miss === "no_evidence_for_mode"
                ? "no_evidence"
                : "not_ok",
      detailFa:
        v.blockerFa ??
        `Required executable venue ${v.sourceId} blocked by fee miss=${miss ?? "unknown"}`
    });
  }

  return { critical: blockers.length > 0, blockers };
}

export function assessEconomicLiveness(input: {
  nowMs: number;
  infraHealth: InfraHealthStatus;
  marketDataHealth: AggregateMarketDataHealth;
  /** Candidate evaluation continuing this cycle (engine ran on opportunities). */
  candidateEvaluationContinuing: boolean;
  lastFillAt: string | null;
  /** Cycle filled count this cycle (updates lastFillAt when >0). */
  filledThisCycle?: number;
  funnel: CycleFunnelCounts;
  venues: VenueEffectiveFee[];
  requiredSourceIds?: string[] | null;
  prior?: EconomicLivenessPersistedState | null;
  thresholds?: Partial<EconomicLivenessThresholds> | null;
  /** Prior fee-horizon degraded timestamp (immutable from feeHorizon). */
  priorFeeDegradedFromTimestamp?: string | null;
}): EconomicLivenessAssessment {
  const th = mergeThresholds(input.thresholds);
  const nowIso = new Date(input.nowMs).toISOString();
  const prior = input.prior ?? emptyPersistedState();
  const alerts: EconomicAlert[] = [];
  const reasons: string[] = [];

  // --- last fill ---
  let lastFillAt = input.lastFillAt ?? prior.lastFillAt;
  if ((input.filledThisCycle ?? 0) > 0) {
    lastFillAt = nowIso;
  }
  const hoursSinceFill = hoursBetween(lastFillAt, input.nowMs);

  // --- fee horizon / immediate blocks ---
  const feeRuntime = assessRuntimeFeeHorizon({
    venues: input.venues,
    nowMs: input.nowMs,
    requiredSourceIds: input.requiredSourceIds,
    priorDegradedFromTimestamp:
      input.priorFeeDegradedFromTimestamp ??
      (prior.validityState === "ECONOMICS_INVALID" ? prior.firstDegradedAt : null)
  });
  const immediate = detectImmediateFeeBlocks({
    venues: input.venues,
    nowMs: input.nowMs,
    requiredSourceIds: input.requiredSourceIds
  });
  const expiryWarnings = feeExpiryWarnings({
    venues: input.venues,
    nowMs: input.nowMs,
    requiredSourceIds: input.requiredSourceIds
  });

  if (immediate.critical) {
    alerts.push({
      code: "FEE_BLOCK_IMMEDIATE",
      severity: "CRITICAL",
      message:
        "Required executable venue blocked by expired/tier-mismatched/missing fee",
      detail: { blockers: immediate.blockers }
    });
    reasons.push("FEE_BLOCK_IMMEDIATE");
  }
  if (feeRuntime.economicsState === "ECONOMICS_INVALID") {
    alerts.push({
      code: "ECONOMICS_INVALID",
      severity: "CRITICAL",
      message: "Runtime fee horizon ECONOMICS_INVALID",
      detail: {
        degradedFromTimestamp: feeRuntime.degradedFromTimestamp,
        expired: feeRuntime.expired
      }
    });
    reasons.push("RUNTIME_FEE_EXPIRED");
  }
  for (const w of expiryWarnings) {
    alerts.push({
      code: w.level === "T_6H" ? "FEE_EXPIRY_T_6H" : "FEE_EXPIRY_T_24H",
      severity: "WARNING",
      message: `Fee evidence for ${w.sourceId} expires within ${w.level}`,
      detail: {
        sourceId: w.sourceId,
        executionMode: w.executionMode,
        tierLabel: w.tierLabel,
        expiresAt: w.expiresAt,
        msUntilExpiry: w.msUntilExpiry,
        level: w.level
      }
    });
    reasons.push(`FEE_EXPIRY_${w.level}`);
  }

  // --- rolling fee_unknown ---
  const rejects = input.funnel.rejects;
  const feeUnknownCount =
    (input.funnel.rejectDistribution["fee_unknown"] ?? 0) +
    (input.funnel.rejectDistribution["fee_stale"] ?? 0);
  const feeUnknownShare =
    rejects > 0 ? feeUnknownCount / rejects : null;
  let feeUnknownStreak = prior.feeUnknownStreak;
  if (
    rejects > 0 &&
    feeUnknownShare != null &&
    feeUnknownShare >= th.feeUnknownRejectRatio
  ) {
    feeUnknownStreak += 1;
  } else if (input.candidateEvaluationContinuing) {
    feeUnknownStreak = 0;
  }
  const rollingFeeUnknownAlert =
    feeUnknownStreak >= th.feeUnknownConsecutiveCycles;
  if (rollingFeeUnknownAlert) {
    const topBlocker = immediate.blockers[0] ?? null;
    alerts.push({
      code: "FEE_UNKNOWN_ROLLING",
      severity: "CRITICAL",
      message: `fee_unknown/fee_stale >= ${th.feeUnknownRejectRatio * 100}% of rejects for ${feeUnknownStreak} consecutive cycles`,
      detail: {
        feeUnknownStreak,
        feeUnknownShare,
        rejectDistribution: input.funnel.rejectDistribution,
        exactBlocker: topBlocker
      }
    });
    reasons.push("FEE_UNKNOWN_ROLLING");
  }

  // --- NO-FILL detector ---
  let noFillClassification: NoFillClassification = "OK";
  const candidateEvaluationContinuing = input.candidateEvaluationContinuing;
  const hasCandidates =
    input.funnel.candidatesEvaluated > 0 ||
    input.funnel.rawPositive > 0 ||
    input.funnel.positiveNet > 0 ||
    input.funnel.selected > 0;

  if (!candidateEvaluationContinuing || !hasCandidates) {
    // No candidates flowing → not an execution stall.
    if ((hoursSinceFill == null || hoursSinceFill > 0) && !hasCandidates) {
      noFillClassification = "NO_EXECUTABLE_OPPORTUNITIES";
    }
  } else {
    // Candidates evaluating but no fills.
    if (hoursSinceFill == null || hoursSinceFill >= th.noFillCriticalHours) {
      // null lastFillAt with continuing candidates = stalled from start of window
      const hours = hoursSinceFill ?? Number.POSITIVE_INFINITY;
      if (hours >= th.noFillCriticalHours) {
        noFillClassification = "CRITICAL";
        alerts.push({
          code: "NO_FILL_CRITICAL",
          severity: "CRITICAL",
          message: `No fill for >= ${th.noFillCriticalHours}h while candidate evaluation continues`,
          detail: { lastFillAt, hoursSinceFill, classification: "EXECUTION_STALLED" }
        });
        reasons.push("NO_FILL_CRITICAL");
      }
    } else if (hoursSinceFill >= th.noFillWarningHours) {
      noFillClassification = "WARNING";
      alerts.push({
        code: "NO_FILL_WARNING",
        severity: "WARNING",
        message: `No fill for >= ${th.noFillWarningHours}h while candidate evaluation continues`,
        detail: { lastFillAt, hoursSinceFill, classification: "EXECUTION_STALLED" }
      });
      reasons.push("NO_FILL_WARNING");
    } else if (input.funnel.filled === 0 && hasCandidates) {
      noFillClassification = "EXECUTION_STALLED";
    }
  }

  // --- POSITIVE-NET dropout ---
  let rawPositiveWithoutNetSince = prior.rawPositiveWithoutNetSince;
  if (input.funnel.rawPositive > 0 && input.funnel.positiveNet === 0) {
    if (!rawPositiveWithoutNetSince) rawPositiveWithoutNetSince = nowIso;
  } else {
    rawPositiveWithoutNetSince = null;
  }
  const dropoutHours = hoursBetween(rawPositiveWithoutNetSince, input.nowMs);
  let dropoutSeverity: AlertSeverity | null = null;
  const dominantCauses = attributeDominantDropoutCauses(
    input.funnel.rejectDistribution
  );
  if (dropoutHours != null && dropoutHours >= th.positiveNetDropoutCriticalHours) {
    dropoutSeverity = "CRITICAL";
    alerts.push({
      code: "POSITIVE_NET_DROPOUT_CRITICAL",
      severity: "CRITICAL",
      message: `Raw-positive continues but positive-net stays zero for >= ${th.positiveNetDropoutCriticalHours}h`,
      detail: {
        since: rawPositiveWithoutNetSince,
        hours: dropoutHours,
        funnel: input.funnel,
        dominantCauses
      }
    });
    reasons.push("POSITIVE_NET_DROPOUT_CRITICAL");
  } else if (
    dropoutHours != null &&
    dropoutHours >= th.positiveNetDropoutWarningHours
  ) {
    dropoutSeverity = "WARNING";
    alerts.push({
      code: "POSITIVE_NET_DROPOUT_WARNING",
      severity: "WARNING",
      message: `Raw-positive continues but positive-net stays zero for >= ${th.positiveNetDropoutWarningHours}h`,
      detail: {
        since: rawPositiveWithoutNetSince,
        hours: dropoutHours,
        funnel: input.funnel,
        dominantCauses
      }
    });
    reasons.push("POSITIVE_NET_DROPOUT_WARNING");
  }

  // --- validity state ---
  let proposed: ExperimentValidityState = "VALID";
  if (
    feeRuntime.economicsState === "ECONOMICS_INVALID" ||
    immediate.critical
  ) {
    proposed = "ECONOMICS_INVALID";
  } else if (
    rollingFeeUnknownAlert ||
    noFillClassification === "CRITICAL" ||
    dropoutSeverity === "CRITICAL"
  ) {
    proposed = "ECONOMICS_DEGRADED";
  } else if (
    expiryWarnings.length > 0 ||
    noFillClassification === "WARNING" ||
    dropoutSeverity === "WARNING"
  ) {
    proposed = "WARNING";
  }

  // Fee refreshed before expiry (no warnings, no expiry, not immediate) →
  // allow WARNING recovery to VALID when never degraded.
  const allowRecoverWarnings =
    expiryWarnings.length === 0 &&
    !immediate.critical &&
    feeRuntime.economicsState === "ECONOMICS_VALID" &&
    !rollingFeeUnknownAlert &&
    noFillClassification !== "WARNING" &&
    noFillClassification !== "CRITICAL" &&
    dropoutSeverity == null;

  // Prefer fee-horizon degraded timestamp when invalidating via expiry.
  const feeDegradedIso = feeRuntime.degradedFromTimestamp;
  const merged = mergeValidityState({
    prior: {
      ...prior,
      firstDegradedAt:
        prior.firstDegradedAt ??
        input.priorFeeDegradedFromTimestamp ??
        null
    },
    proposed,
    reasons,
    nowIso: feeDegradedIso && proposed === "ECONOMICS_INVALID"
      ? feeDegradedIso
      : nowIso,
    allowRecoverWarnings
  });

  // Economic liveness level (distinct from infra).
  let economicLiveness: EconomicLivenessLevel = "HEALTHY";
  if (merged.validityState === "ECONOMICS_INVALID") {
    economicLiveness = "ECONOMICS_INVALID";
  } else if (merged.validityState === "ECONOMICS_DEGRADED") {
    economicLiveness = "ECONOMICS_DEGRADED";
  } else if (noFillClassification === "NO_EXECUTABLE_OPPORTUNITIES") {
    economicLiveness = "NO_EXECUTABLE_OPPORTUNITIES";
  } else if (
    alerts.some((a) => a.severity === "CRITICAL") ||
    noFillClassification === "CRITICAL"
  ) {
    economicLiveness = "CRITICAL";
  } else if (
    alerts.some((a) => a.severity === "WARNING") ||
    merged.validityState === "WARNING"
  ) {
    economicLiveness = "WARNING";
  }

  const nextPersisted: EconomicLivenessPersistedState = {
    version: "economic_liveness_v1",
    lastFillAt,
    hoursSinceFill,
    firstDegradedAt: merged.firstDegradedAt,
    validityState: merged.validityState,
    validityReasons: merged.validityReasons,
    feeUnknownStreak,
    rawPositiveWithoutNetSince,
    lastCycleAt: nowIso,
    lastFunnel: input.funnel,
    firstDegradedAtSource: merged.firstDegradedAt
  };

  const supervisorPayload: SupervisorEconomicPayload = {
    version: "supervisor_economic_liveness_v1",
    assessedAt: nowIso,
    infraHealth: input.infraHealth,
    marketDataHealth: input.marketDataHealth,
    economicLivenessStatus: economicLiveness,
    validityState: merged.validityState,
    last_fill_at: lastFillAt,
    hours_since_fill: hoursSinceFill,
    rolling_funnel_counts: input.funnel,
    reject_distribution: input.funnel.rejectDistribution,
    fee_blockers: immediate.blockers,
    first_degraded_at: merged.firstDegradedAt,
    validity_reasons: merged.validityReasons,
    alerts,
    fee_expiry_warnings: expiryWarnings,
    no_fill_classification: noFillClassification,
    positive_net_dropout: {
      active: rawPositiveWithoutNetSince != null,
      since: rawPositiveWithoutNetSince,
      hours: dropoutHours,
      severity: dropoutSeverity,
      dominant_causes: dominantCauses
    },
    terminal_output_authoritative: false
  };

  return {
    health: {
      infraHealth: input.infraHealth,
      marketDataHealth: input.marketDataHealth,
      economicLiveness,
      infraImpliesEconomics: false
    },
    validityState: merged.validityState,
    firstDegradedAt: merged.firstDegradedAt,
    validityReasons: merged.validityReasons,
    lastFillAt,
    hoursSinceFill,
    noFill: {
      classification: noFillClassification,
      candidateEvaluationContinuing
    },
    feeBlocks: {
      immediateCritical: immediate.critical,
      blockers: immediate.blockers,
      rollingFeeUnknownAlert,
      feeUnknownStreak,
      feeUnknownShareLastCycle: feeUnknownShare,
      expiryWarnings
    },
    positiveNetDropout: {
      active: rawPositiveWithoutNetSince != null,
      since: rawPositiveWithoutNetSince,
      hours: dropoutHours,
      severity: dropoutSeverity,
      dominantCauses
    },
    funnel: input.funnel,
    alerts,
    nextPersisted,
    supervisorPayload
  };
}

/**
 * End-of-run report: separate valid economics window from invalid runtime.
 * firstDegradedAt is the audit cut; never invents a cleared invalidation.
 */
export function buildEndReportValidityWindows(input: {
  runStartedAt: string;
  runEndedAt: string;
  firstDegradedAt: string | null;
  validityStateAtEnd: ExperimentValidityState;
}): EndReportValidityWindows {
  const { runStartedAt, runEndedAt, firstDegradedAt, validityStateAtEnd } = input;
  if (!firstDegradedAt) {
    return {
      validWindow: { from: runStartedAt, to: runEndedAt },
      invalidWindow: { from: null, to: null },
      firstDegradedAt: null,
      validityStateAtEnd,
      note: "Entire run window remained economically valid (no first_degraded_at)."
    };
  }
  const degMs = Date.parse(firstDegradedAt);
  const startMs = Date.parse(runStartedAt);
  const endMs = Date.parse(runEndedAt);
  const degradedDuring =
    Number.isFinite(degMs) &&
    Number.isFinite(startMs) &&
    Number.isFinite(endMs) &&
    degMs >= startMs &&
    degMs <= endMs;

  if (!degradedDuring && degMs < startMs) {
    return {
      validWindow: { from: null, to: null },
      invalidWindow: { from: runStartedAt, to: runEndedAt },
      firstDegradedAt,
      validityStateAtEnd,
      note: "Run started already past first_degraded_at; entire window is invalid runtime."
    };
  }

  return {
    validWindow: { from: runStartedAt, to: firstDegradedAt },
    invalidWindow: { from: firstDegradedAt, to: runEndedAt },
    firstDegradedAt,
    validityStateAtEnd,
    note:
      "Valid economics only until first_degraded_at; subsequent window is invalid runtime and must not be mixed into valid-econ metrics."
  };
}

/** Convenience: classify infra from collector-style status string. */
export function classifyInfraHealth(
  status: string | null | undefined
): InfraHealthStatus {
  if (status === "healthy") return "healthy";
  if (status === "degraded") return "degraded";
  if (status === "stopped") return "stopped";
  return "unknown";
}
