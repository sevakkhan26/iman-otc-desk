/**
 * Canonical Paper opportunity lifecycle funnel + decision evidence.
 * Telemetry only — never alters ranking, sizing, or fill acceptance.
 *
 * Required stages (every opportunity/lifecycle):
 * candidate → raw-positive → fee → net-positive → sizing → inventory/capital →
 * coherence/freshness → allocator/selection → arrival/delayed-book recheck →
 * delayed VWAP/slippage/net → first leg → second leg → partial fill/leg risk →
 * fill OR exact reject.
 *
 * Terminal reasons must be exact machine-readable codes. Generic
 * `sizing_blocked` / null / unknown / silent skip are forbidden for NEW writes.
 */
import type { PaperReasonCode } from "@/lib/shadowArbitrage/paper/reasons";
import type { DelayedBookEvidence } from "@/lib/shadowArbitrage/paper/delayedBookRecheck";
import type { RejectDiagnostics } from "@/lib/shadowArbitrage/paper/rejectDiagnostics";
import type { PaperDecision } from "@/lib/shadowArbitrage/paper/engine";

export const LIFECYCLE_FUNNEL_STAGES = [
  "candidate",
  "raw_positive",
  "fee",
  "net_positive",
  "sizing",
  "inventory_capital",
  "coherence_freshness",
  "allocator_selection",
  "arrival_delayed_book_recheck",
  "delayed_vwap_slippage_net",
  "first_leg",
  "second_leg",
  "partial_fill_leg_risk",
  "fill_or_exact_reject"
] as const;

export type LifecycleFunnelStage = (typeof LIFECYCLE_FUNNEL_STAGES)[number];

export type FunnelStageVerdict = "passed" | "failed" | "skipped" | "not_reached";

export type FunnelStageRecord = {
  stage: LifecycleFunnelStage;
  verdict: FunnelStageVerdict;
  /** Exact reason when failed at this stage; null when passed/skipped/not_reached. */
  terminalReason: PaperReasonCode | null;
  observed?: Record<string, unknown> | null;
};

/** Banned as sole terminal reason for NEW paper decisions. */
export const BANNED_TERMINAL_REASONS = new Set<string>([
  "sizing_blocked",
  "unknown",
  "null",
  ""
]);

export function assertExactTerminalReason(code: string | null | undefined): void {
  if (code == null || BANNED_TERMINAL_REASONS.has(String(code))) {
    throw new Error(
      `banned/missing terminal reason: ${String(code)} — exact PaperReasonCode required`
    );
  }
}

export type LifecycleDecisionEvidence = {
  version: "paper_lifecycle_evidence_v1";
  label?: "FIXTURE_NOT_REAL_TRADE" | null;
  lifecycleId: string;
  sessionId: string | null;
  runId: string | null;
  ledgerId: string | null;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  occurredAt: string;
  /** Single terminal machine-readable reason for non-fills; null on FILLED. */
  terminalReason: PaperReasonCode | null;
  outcome: "FILLED" | "SKIPPED" | "LEG_RISK";
  stages: FunnelStageRecord[];
  venueRoute: { routeKey: string; buySourceId: string; sellSourceId: string };
  timestamps: {
    occurredAt: string;
    decisionTimestampMs?: number | null;
    arrivalTimestampMs?: number | null;
  };
  ageSkew: {
    sourceSkewMs: number | null;
    venueClockSkewMs: number | null;
    buyAgeMs: number | null;
    sellAgeMs: number | null;
  };
  sizes: {
    candidateSizeUsdt: number;
    fillSizeUsdt: number | null;
    capitalCapUsdt: number | null;
    depthCapUsdt: number | null;
  };
  capitalInventory: Record<string, unknown> | null;
  fees: {
    buyFeeBps: number | null;
    sellFeeBps: number | null;
    feeTomanTotal: number | null;
    buyProvenance?: string | null;
    sellProvenance?: string | null;
  };
  edges: {
    grossSpreadToman: number | null;
    economicNetPnlToman: number | null;
    riskAdjustedPnlToman: number | null;
    netProfitToman: number | null;
  };
  vwap: {
    originalBuyToman: number | null;
    originalSellToman: number | null;
    delayedBuyToman: number | null;
    delayedSellToman: number | null;
  };
  slippage: { bufferToman: number | null; delayedNetToman: number | null };
  policy: { fingerprint: string | null; observed: Record<string, unknown> | null };
  allocator: {
    rank: number | null;
    selected: boolean;
    budgetRemaining: number | null;
  };
  legs: DelayedBookEvidence["legRisk"] | null;
  delayedRecheck: DelayedBookEvidence | null;
  diagnostics: RejectDiagnostics | null;
  reasonCodes: string[];
};

const FEE_FAIL = new Set<string>([
  "fee_unknown",
  "fee_stale",
  "fee_settlement_unknown",
  "fee_settlement_unsupported"
]);
const COHERENCE_FAIL = new Set<string>([
  "market_data_time_incoherent",
  "stale_market_data",
  "market_data_resync",
  "market_data_sequence_gap",
  "market_data_missing",
  "market_data_unverified",
  "delayed_book_stale",
  "delayed_book_incoherent",
  "delayed_book_invalid"
]);
const SIZING_FAIL = new Set<string>([
  "sizing_missing_policy",
  "sizing_expired_policy",
  "sizing_slippage_over_limit",
  "sizing_size_floor",
  "sizing_invalid_size",
  "size_not_selected",
  "insufficient_depth"
]);
const INVENTORY_FAIL = new Set<string>([
  "insufficient_irt",
  "insufficient_usdt",
  "inventory_limit",
  "portfolio_utilization_cap",
  "route_capital_cap",
  "venue_exposure_cap",
  "reservation_conflict",
  "portfolio_limits_unavailable",
  "negative_balance_guard",
  "no_balance_record"
]);
const ALLOC_FAIL = new Set<string>([
  "portfolio_not_selected",
  "optimizer_budget_exhausted",
  "adjusted_score_non_positive",
  "lifecycle_already_processed",
  "experiment_closed"
]);
const DELAYED_FAIL = new Set<string>([
  "delayed_liquidity_disappeared",
  "delayed_depth_insufficient",
  "delayed_net_non_positive",
  "delayed_edge_below_floor",
  "delayed_observation_missing",
  "post_leg_observation_missing",
  "partial_below_minimum"
]);

function stageFailAt(
  codes: string[],
  set: Set<string>
): PaperReasonCode | null {
  for (const c of codes) {
    if (set.has(c)) return c as PaperReasonCode;
  }
  return null;
}

/**
 * Build funnel stage records from an already-finished decision.
 * Does NOT back-infer terminal reason as the cause at a positive instant —
 * earlier stages stay `passed` when a later stage failed.
 */
export function buildFunnelStages(input: {
  decision: PaperDecision;
  rank?: number | null;
  selected?: boolean;
}): FunnelStageRecord[] {
  const d = input.decision;
  const codes =
    d.kind === "SKIP" ? d.codes.map(String) : ([] as string[]);
  const terminal =
    d.kind === "SKIP"
      ? d.code
      : d.executionOutcome === "LEG_RISK"
        ? ("leg_risk_second_leg_failed" as PaperReasonCode)
        : null;
  const delayed = d.delayedRecheck ?? null;
  const c = d.candidate;
  const gross = c.sellVwapToman - c.buyVwapToman;
  const rawPos = Number.isFinite(gross) && gross > 0;
  const netPos = Number.isFinite(c.netProfitToman) && c.netProfitToman > 0;

  const out: FunnelStageRecord[] = [];
  const push = (
    stage: LifecycleFunnelStage,
    verdict: FunnelStageVerdict,
    terminalReason: PaperReasonCode | null = null,
    observed?: Record<string, unknown> | null
  ) => out.push({ stage, verdict, terminalReason, observed: observed ?? null });

  push("candidate", "passed", null, { lifecycleId: c.lifecycleId, sizeUsdt: c.sizeUsdt });
  push(
    "raw_positive",
    rawPos ? "passed" : "failed",
    rawPos ? null : "net_non_positive",
    { grossSpreadToman: Math.round(gross) }
  );

  const feeFail = stageFailAt(codes, FEE_FAIL);
  if (feeFail) push("fee", "failed", feeFail);
  else push("fee", "passed", null, { buyFeeBps: c.buyFeeBps, sellFeeBps: c.sellFeeBps });

  const netFail =
    codes.includes("net_non_positive") || (!netPos && d.kind === "SKIP" && !feeFail)
      ? ("net_non_positive" as PaperReasonCode)
      : null;
  // Do not mark net_positive failed solely because a later gate rejected a net-pos candidate.
  if (codes.includes("net_non_positive")) {
    push("net_positive", "failed", "net_non_positive", { netProfitToman: c.netProfitToman });
  } else if (netPos || d.kind === "EXECUTE") {
    push("net_positive", "passed", null, { netProfitToman: c.netProfitToman });
  } else if (feeFail) {
    push("net_positive", "not_reached", null);
  } else {
    push("net_positive", netFail ? "failed" : "passed", netFail, {
      netProfitToman: c.netProfitToman
    });
  }

  const sizingFail = stageFailAt(codes, SIZING_FAIL);
  if (sizingFail) push("sizing", "failed", sizingFail);
  else if (feeFail || codes.includes("net_non_positive"))
    push("sizing", "not_reached");
  else push("sizing", "passed");

  const invFail = stageFailAt(codes, INVENTORY_FAIL);
  if (invFail) push("inventory_capital", "failed", invFail);
  else if (sizingFail || feeFail || codes.includes("net_non_positive"))
    push("inventory_capital", "not_reached");
  else push("inventory_capital", "passed");

  const cohFail = stageFailAt(codes, COHERENCE_FAIL);
  if (cohFail) push("coherence_freshness", "failed", cohFail);
  else if (invFail || sizingFail || feeFail) push("coherence_freshness", "not_reached");
  else push("coherence_freshness", "passed");

  const allocFail = stageFailAt(codes, ALLOC_FAIL);
  if (allocFail) push("allocator_selection", "failed", allocFail);
  else if (d.kind === "EXECUTE" || input.selected)
    push("allocator_selection", "passed", null, { rank: input.rank ?? null });
  else if (cohFail || invFail || sizingFail || feeFail)
    push("allocator_selection", "not_reached");
  else push("allocator_selection", "skipped", terminal);

  const delayedFail = stageFailAt(codes, DELAYED_FAIL) ??
    (delayed?.rejectCode && DELAYED_FAIL.has(delayed.rejectCode)
      ? delayed.rejectCode
      : null);
  if (delayedFail) {
    push("arrival_delayed_book_recheck", "failed", delayedFail);
    push("delayed_vwap_slippage_net", "failed", delayedFail, {
      delayedBuy: delayed?.delayed.buyVwapToman ?? null,
      delayedSell: delayed?.delayed.sellVwapToman ?? null
    });
  } else if (d.kind === "EXECUTE" || delayed) {
    push("arrival_delayed_book_recheck", "passed", null, {
      appliedDelayMs: delayed?.appliedDelayMs ?? null
    });
    push("delayed_vwap_slippage_net", "passed", null, {
      delayedBuy: delayed?.delayed.buyVwapToman ?? null,
      delayedSell: delayed?.delayed.sellVwapToman ?? null,
      delayedNet: delayed?.delayed.economicNetPnlToman ?? null
    });
  } else {
    push("arrival_delayed_book_recheck", "not_reached");
    push("delayed_vwap_slippage_net", "not_reached");
  }

  const legRisk = delayed?.legRisk;
  const legFail =
    terminal === "leg_risk_second_leg_failed" ||
    codes.includes("leg_risk_second_leg_failed");
  if (legFail) {
    push("first_leg", "passed", null, { filled: legRisk?.firstLegFilledUsdt ?? null });
    push("second_leg", "failed", "leg_risk_second_leg_failed");
    push("partial_fill_leg_risk", "failed", "leg_risk_second_leg_failed");
  } else if (d.kind === "EXECUTE") {
    push("first_leg", "passed");
    push("second_leg", "passed");
    push(
      "partial_fill_leg_risk",
      delayed?.partial ? "passed" : "passed",
      null,
      { partial: delayed?.partial ?? false }
    );
  } else {
    push("first_leg", "not_reached");
    push("second_leg", "not_reached");
    push("partial_fill_leg_risk", "not_reached");
  }

  if (d.kind === "EXECUTE" && d.executionOutcome !== "LEG_RISK") {
    push("fill_or_exact_reject", "passed", null, { outcome: "FILLED" });
  } else {
    const reason = terminal ?? (codes[0] as PaperReasonCode | undefined) ?? null;
    if (reason) assertExactTerminalReason(reason);
    push("fill_or_exact_reject", "failed", reason, { outcome: "SKIPPED" });
  }

  return out;
}

export function buildLifecycleDecisionEvidence(input: {
  decision: PaperDecision;
  sessionId: string | null;
  runId: string | null;
  ledgerId?: string | null;
  occurredAt: string;
  rank?: number | null;
  selected?: boolean;
  policyFingerprint?: string | null;
  allocatorBudgetRemaining?: number | null;
  label?: "FIXTURE_NOT_REAL_TRADE" | null;
}): LifecycleDecisionEvidence {
  const d = input.decision;
  const c = d.candidate;
  const delayed = d.delayedRecheck ?? null;
  const diagnostics = d.kind === "SKIP" ? d.diagnostics ?? null : null;
  const codes = d.kind === "SKIP" ? d.codes : [];
  const terminal =
    d.kind === "SKIP"
      ? d.code
      : d.executionOutcome === "LEG_RISK"
        ? ("leg_risk_second_leg_failed" as PaperReasonCode)
        : null;
  if (terminal) assertExactTerminalReason(terminal);

  const stages = buildFunnelStages({
    decision: d,
    rank: input.rank,
    selected: input.selected
  });

  let capitalCap: number | null = null;
  let depthCap: number | null = null;
  let economic: number | null = null;
  let riskAdj: number | null = null;
  let feeTotal: number | null = null;
  let buyProv: string | null = null;
  let sellProv: string | null = null;
  let fillSize: number | null = null;

  if (d.kind === "EXECUTE") {
    economic = d.plan.economicNetPnlToman;
    riskAdj = d.plan.riskAdjustedPnlToman;
    feeTotal = d.plan.totalFeeToman;
    buyProv = d.plan.buyLeg.settlement.provenance;
    sellProv = d.plan.sellLeg.settlement.provenance;
    fillSize = d.candidate.sizeUsdt;
    if (d.sizing.capacity) {
      capitalCap =
        d.sizing.capacity.capitalCapMicros != null
          ? d.sizing.capacity.capitalCapMicros / 1e6
          : null;
      depthCap =
        d.sizing.capacity.depthCapMicros != null
          ? d.sizing.capacity.depthCapMicros / 1e6
          : null;
    }
  }

  return {
    version: "paper_lifecycle_evidence_v1",
    label: input.label ?? null,
    lifecycleId: c.lifecycleId,
    sessionId: input.sessionId,
    runId: input.runId,
    ledgerId: input.ledgerId ?? null,
    routeKey: c.routeKey,
    buySourceId: c.buySourceId,
    sellSourceId: c.sellSourceId,
    occurredAt: input.occurredAt,
    terminalReason: terminal,
    outcome:
      d.kind === "EXECUTE"
        ? d.executionOutcome === "LEG_RISK"
          ? "LEG_RISK"
          : "FILLED"
        : "SKIPPED",
    stages,
    venueRoute: {
      routeKey: c.routeKey,
      buySourceId: c.buySourceId,
      sellSourceId: c.sellSourceId
    },
    timestamps: {
      occurredAt: input.occurredAt,
      decisionTimestampMs: delayed?.decisionTimestampMs ?? null,
      arrivalTimestampMs: delayed?.arrivalTimestampMs ?? null
    },
    ageSkew: {
      sourceSkewMs:
        diagnostics?.coherence?.sourceSkewMs ??
        delayed?.delayed.coherence?.sourceSkewMs ??
        null,
      venueClockSkewMs:
        diagnostics?.coherence?.venueClockSkewMs ??
        delayed?.delayed.coherence?.venueClockSkewMs ??
        null,
      buyAgeMs: diagnostics?.coherence?.buy?.ageMs ?? delayed?.delayed.buy.ageMs ?? null,
      sellAgeMs:
        diagnostics?.coherence?.sell?.ageMs ?? delayed?.delayed.sell.ageMs ?? null
    },
    sizes: {
      candidateSizeUsdt: c.sizeUsdt,
      fillSizeUsdt: fillSize ?? delayed?.fillSizeUsdt ?? null,
      capitalCapUsdt: capitalCap,
      depthCapUsdt: depthCap
    },
    capitalInventory: null,
    fees: {
      buyFeeBps: c.buyFeeBps,
      sellFeeBps: c.sellFeeBps,
      feeTomanTotal: feeTotal,
      buyProvenance: buyProv,
      sellProvenance: sellProv
    },
    edges: {
      grossSpreadToman:
        Number.isFinite(c.sellVwapToman - c.buyVwapToman)
          ? Math.round(c.sellVwapToman - c.buyVwapToman)
          : null,
      economicNetPnlToman: economic,
      riskAdjustedPnlToman: riskAdj,
      netProfitToman: c.netProfitToman
    },
    vwap: {
      originalBuyToman: c.buyVwapToman,
      originalSellToman: c.sellVwapToman,
      delayedBuyToman: delayed?.delayed.buyVwapToman ?? null,
      delayedSellToman: delayed?.delayed.sellVwapToman ?? null
    },
    slippage: {
      bufferToman: c.slippageBufferToman,
      delayedNetToman: delayed?.delayed.economicNetPnlToman ?? null
    },
    policy: {
      fingerprint: input.policyFingerprint ?? null,
      observed: null
    },
    allocator: {
      rank: input.rank ?? null,
      selected: Boolean(input.selected ?? d.kind === "EXECUTE"),
      budgetRemaining: input.allocatorBudgetRemaining ?? null
    },
    legs: delayed?.legRisk ?? null,
    delayedRecheck: delayed,
    diagnostics,
    reasonCodes: codes
  };
}
