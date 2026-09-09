/**
 * Build append-only decision traces from an already-finished cycle evaluation.
 * Pure mapping — does not re-rank, re-size, or alter any decision.
 */
import type { PaperDecision, CycleEvaluation } from "@/lib/shadowArbitrage/paper/engine";
import type { DecisionCandidateTrace } from "@/db/repositories/shadowDecisionTraces";
import {
  buildLifecycleDecisionEvidence,
  type LifecycleDecisionEvidence
} from "@/lib/shadowArbitrage/paper/lifecycleFunnel";
import { isBannedTerminalReason } from "@/lib/shadowArbitrage/paper/reasons";

export type CaptureInput = {
  decisions: PaperDecision[];
  evaluation: CycleEvaluation;
  filledLifecycleIds: Set<string>;
  ledgerIdByLifecycle?: Map<string, string>;
  venueCount: number;
  sessionId?: string | null;
  runId?: string | null;
  occurredAt?: string;
  policyFingerprint?: string | null;
  fixtureLabel?: "FIXTURE_NOT_REAL_TRADE" | null;
};

function statusFor(
  d: PaperDecision,
  filled: Set<string>
): DecisionCandidateTrace["status"] {
  if (d.kind === "EXECUTE") {
    if (d.executionOutcome === "LEG_RISK") return "failed";
    if (filled.has(d.candidate.lifecycleId)) return "traded";
    return "selected";
  }
  return "rejected";
}

const STATUS_FA: Record<DecisionCandidateTrace["status"], string> = {
  evaluating: "در حال بررسی",
  rejected: "رد شد",
  valid: "معتبر",
  selected: "انتخاب شد",
  traded: "✓ معامله شد",
  failed: "اجرای ناموفق"
};

/**
 * Map engine decisions → candidate traces. Rank = evaluation order (already
 * risk-adjusted rank in the engine's authoritative pass).
 */
export function buildCandidateTraces(input: CaptureInput): DecisionCandidateTrace[] {
  const out: DecisionCandidateTrace[] = [];
  let rank = 0;
  for (const d of input.decisions) {
    rank += 1;
    const c = d.candidate;
    const status = statusFor(d, input.filledLifecycleIds);
    const selected = d.kind === "EXECUTE" && d.executionOutcome !== "LEG_RISK";
    let economic: number | null = null;
    let riskAdj: number | null = null;
    let gross: number | null = null;
    let feeToman: number | null = null;
    let binding: string | null = null;
    let sizingReason: string | null = null;
    let capitalCap: number | null = null;
    let depthCap: number | null = null;
    let buyVwap = c.buyVwapToman;
    let sellVwap = c.sellVwapToman;
    let size = c.sizeUsdt;
    let buyProv: string | null = null;
    let sellProv: string | null = null;

    if (d.kind === "EXECUTE") {
      economic = d.plan.economicNetPnlToman;
      riskAdj = d.plan.riskAdjustedPnlToman;
      gross = d.plan.grossSpreadToman;
      feeToman = d.plan.totalFeeToman;
      buyVwap = d.plan.buyLeg.vwapToman;
      sellVwap = d.plan.sellLeg.vwapToman;
      size = d.candidate.sizeUsdt;
      buyProv = d.plan.buyLeg.settlement.provenance;
      sellProv = d.plan.sellLeg.settlement.provenance;
      if (d.sizing.selection) {
        sizingReason = d.sizing.selection.reasonFa;
        binding = d.sizing.bindingConstraint;
      }
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

    const terminalReason =
      d.kind === "SKIP"
        ? d.code
        : d.executionOutcome === "LEG_RISK"
          ? "leg_risk_second_leg_failed"
          : null;
    if (terminalReason && isBannedTerminalReason(terminalReason)) {
      throw new Error(`banned terminal reason in trace capture: ${terminalReason}`);
    }

    const delayed = d.delayedRecheck ?? null;
    const evidence: LifecycleDecisionEvidence = buildLifecycleDecisionEvidence({
      decision: d,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      ledgerId: input.ledgerIdByLifecycle?.get(c.lifecycleId) ?? null,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
      rank,
      selected,
      policyFingerprint: input.policyFingerprint ?? null,
      label: input.fixtureLabel ?? null
    });

    out.push({
      rank,
      lifecycleId: c.lifecycleId,
      routeKey: c.routeKey,
      buySourceId: c.buySourceId,
      sellSourceId: c.sellSourceId,
      sizeUsdt: size,
      buyVwapToman: buyVwap,
      sellVwapToman: sellVwap,
      delayedBuyVwapToman: delayed?.delayed.buyVwapToman ?? null,
      delayedSellVwapToman: delayed?.delayed.sellVwapToman ?? null,
      grossSpreadToman: gross,
      economicNetPnlToman: economic,
      riskAdjustedPnlToman: riskAdj,
      buyFeeBps: c.buyFeeBps,
      sellFeeBps: c.sellFeeBps,
      buyFeeProvenance: buyProv,
      sellFeeProvenance: sellProv,
      feeTomanTotal: feeToman,
      slippageBufferToman: c.slippageBufferToman,
      bindingConstraint: binding,
      sizingReason,
      status,
      statusFa: STATUS_FA[status],
      reasonFa: d.kind === "SKIP" ? d.reasonFa : sizingReason,
      reasonCodes: d.kind === "SKIP" ? d.codes : [],
      terminalReason,
      selected,
      ledgerId: input.ledgerIdByLifecycle?.get(c.lifecycleId) ?? null,
      capitalCapUsdt: capitalCap,
      depthCapUsdt: depthCap,
      sourceSkewMs:
        (d.kind === "SKIP" ? d.diagnostics?.coherence?.sourceSkewMs : null) ??
        delayed?.delayed.coherence?.sourceSkewMs ??
        null,
      appliedDelayMs: delayed?.appliedDelayMs ?? null,
      delayedNetPnlToman: delayed?.delayed.economicNetPnlToman ?? null,
      funnelStages: evidence.stages,
      lifecycleEvidence: evidence as unknown as Record<string, unknown>
    });
  }
  return out;
}

export function cycleOutcomeFromTraces(
  candidates: DecisionCandidateTrace[],
  filledCount: number
): { outcome: string; reasonFa: string } {
  if (filledCount > 0) {
    return { outcome: "filled", reasonFa: "حداقل یک معاملهٔ کاغذی در این چرخه تکمیل شد" };
  }
  if (candidates.some((c) => c.selected)) {
    return {
      outcome: "selected_not_filled",
      reasonFa: "کاندید انتخاب شد ولی پر کاغذی ثبت نشد"
    };
  }
  if (candidates.some((c) => c.status === "valid")) {
    return {
      outcome: "valid_not_selected",
      reasonFa: "کاندید معتبر وجود داشت ولی انتخاب نشد"
    };
  }
  if (candidates.length === 0) {
    return { outcome: "empty", reasonFa: "هیچ کاندیدی در این چرخه ارزیابی نشد" };
  }
  return { outcome: "all_rejected", reasonFa: "همهٔ کاندیدها رد شدند" };
}
