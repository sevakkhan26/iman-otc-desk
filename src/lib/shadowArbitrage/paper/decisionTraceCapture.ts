/**
 * Build append-only decision traces from an already-finished cycle evaluation.
 * Pure mapping — does not re-rank, re-size, or alter any decision.
 */
import type { PaperDecision, CycleEvaluation } from "@/lib/shadowArbitrage/paper/engine";
import type { DecisionCandidateTrace } from "@/db/repositories/shadowDecisionTraces";

export type CaptureInput = {
  decisions: PaperDecision[];
  evaluation: CycleEvaluation;
  filledLifecycleIds: Set<string>;
  ledgerIdByLifecycle?: Map<string, string>;
  venueCount: number;
};

function statusFor(
  d: PaperDecision,
  filled: Set<string>
): DecisionCandidateTrace["status"] {
  if (d.kind === "EXECUTE") {
    if (filled.has(d.candidate.lifecycleId)) return "traded";
    return "selected";
  }
  // SKIP
  if (d.code === "net_non_positive" || d.codes.includes("net_non_positive")) {
    return "rejected";
  }
  if (
    d.codes.includes("sizing_blocked") ||
    d.code === "sizing_blocked" ||
    d.codes.includes("sizing_invalid_size") ||
    d.code === "sizing_invalid_size" ||
    d.codes.includes("portfolio_limits_unavailable") ||
    d.code === "portfolio_limits_unavailable"
  ) {
    return "rejected";
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
    const selected = d.kind === "EXECUTE";
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

    if (d.kind === "EXECUTE") {
      economic = d.plan.economicNetPnlToman;
      riskAdj = d.plan.riskAdjustedPnlToman;
      gross = d.plan.grossSpreadToman;
      feeToman = d.plan.totalFeeToman;
      buyVwap = d.plan.buyLeg.vwapToman;
      sellVwap = d.plan.sellLeg.vwapToman;
      size = d.candidate.sizeUsdt;
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

    out.push({
      rank,
      lifecycleId: c.lifecycleId,
      routeKey: c.routeKey,
      buySourceId: c.buySourceId,
      sellSourceId: c.sellSourceId,
      sizeUsdt: size,
      buyVwapToman: buyVwap,
      sellVwapToman: sellVwap,
      grossSpreadToman: gross,
      economicNetPnlToman: economic,
      riskAdjustedPnlToman: riskAdj,
      buyFeeBps: c.buyFeeBps,
      sellFeeBps: c.sellFeeBps,
      feeTomanTotal: feeToman,
      slippageBufferToman: c.slippageBufferToman,
      bindingConstraint: binding,
      sizingReason,
      status,
      statusFa: STATUS_FA[status],
      reasonFa: d.kind === "SKIP" ? d.reasonFa : sizingReason,
      reasonCodes: d.kind === "SKIP" ? d.codes : [],
      selected,
      ledgerId: input.ledgerIdByLifecycle?.get(c.lifecycleId) ?? null,
      capitalCapUsdt: capitalCap,
      depthCapUsdt: depthCap
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
