import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  getObservation,
  getWorkerHeartbeat,
  loadLatestCapitalApproval,
  loadLatestCapitalPlan,
  loadLatestFeeConfirmations,
  loadLatestSourceSnapshots,
  loadRunStats
} from "@/db/repositories/shadowArbitrage";
import {
  getActivePaperSession,
  loadPaperLedger,
  loadPaperStats
} from "@/db/repositories/shadowPaper";
import {
  loadAttestations,
  loadReadinessReviews,
  loadRiskPolicyHistory,
  loadRiskPolicyValues,
  recordAttestation,
  recordReadinessReview,
  recordRiskPolicy
} from "@/db/repositories/shadowLive";
import { buildAllReadiness } from "@/lib/shadowArbitrage/accounts";
import { classifyAllVenues, evaluateRecommendation } from "@/lib/shadowArbitrage/capital";
import { SHADOW_BANNER } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import {
  LIVE_EXECUTION_IMPLEMENTED,
  LIVE_NOT_IMPLEMENTED_BANNER_EN,
  LIVE_NOT_IMPLEMENTED_BANNER_FA,
  LIVE_UNAVAILABLE_REASON_FA
} from "@/lib/shadowArbitrage/live/capability";
import {
  REQUIRED_RISK_POLICIES,
  buildPolicyState,
  validatePolicyValue
} from "@/lib/shadowArbitrage/live/policy";
import { evaluateReadiness, type AttestationKind } from "@/lib/shadowArbitrage/live/readiness";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 7A — admin-only live-execution READINESS.
 *
 * This endpoint reports whether the desk would be ready, and records reviews,
 * risk policies and human attestations. It has no exchange client, accepts no
 * credentials, and contains no action that can arm or perform live trading:
 * live execution is not implemented in this build at all.
 */

const ATTESTATION_KINDS: AttestationKind[] = [
  "api_capability",
  "key_permissions",
  "transfer_costs",
  "reconciliation_runbook"
];

/**
 * Refused outright. The readiness surface records STATEMENTS about key
 * permissions; it must never receive the key itself.
 */
const FORBIDDEN_FIELDS = [
  "apiKey",
  "api_key",
  "secret",
  "apiSecret",
  "token",
  "password",
  "passphrase",
  "privateKey",
  "mnemonic",
  "credential",
  "authorization"
];

function bad(message: string, error = "bad_request", status = 400) {
  return new NextResponse(JSON.stringify({ error, message }), {
    status,
    headers: SHADOW_NO_STORE
  });
}

async function buildReport() {
  const [
    observation,
    worker,
    runStats,
    latestFees,
    snapshots,
    savedPlan,
    approvalRow,
    paperSession,
    attestations,
    policyValues
  ] = await Promise.all([
    getObservation(),
    getWorkerHeartbeat(),
    loadRunStats(),
    loadLatestFeeConfirmations(),
    loadLatestSourceSnapshots(),
    loadLatestCapitalPlan(),
    loadLatestCapitalApproval(),
    getActivePaperSession(),
    loadAttestations(),
    loadRiskPolicyValues()
  ]);

  const readiness = buildAllReadiness(Object.values(latestFees));
  const venueStates = classifyAllVenues(readiness);
  const policies = buildPolicyState(policyValues);

  // Valuation price is only needed to re-evaluate the Phase 5 recommendation.
  const mids = snapshots
    .filter((s) => !s.stale && s.userBuy !== null && s.userSell !== null)
    .map((s) => ((s.userBuy as number) + (s.userSell as number)) / 2)
    .sort((a, b) => a - b);
  const valuationPriceToman = mids.length
    ? Math.round(mids.length % 2 ? mids[Math.floor(mids.length / 2)] : (mids[mids.length / 2 - 1] + mids[mids.length / 2]) / 2)
    : null;

  let capitalRecommendation: { status: string; reasonFa: string } | null = null;
  if (savedPlan && valuationPriceToman !== null) {
    const rec = evaluateRecommendation({
      plan: {
        totalCapitalToman: savedPlan.totalCapitalToman,
        valuationPriceToman,
        allocations: savedPlan.allocations as never,
        mode: savedPlan.mode
      },
      states: venueStates,
      observation: observation
        ? {
            status: observation.status,
            successCoveragePercent: observation.successCoveragePercent,
            elapsedMs: observation.elapsedMs,
            targetDurationMs: observation.targetDurationMs
          }
        : null,
      approval: approvalRow
        ? {
            approvedBy: approvalRow.approvedBy,
            approvedAt: approvalRow.approvedAt,
            readinessFingerprint: approvalRow.readinessFingerprint,
            planFingerprint: approvalRow.planFingerprint
          }
        : null
    });
    capitalRecommendation = { status: rec.status, reasonFa: rec.reasonFa };
  }

  const paperStats = paperSession ? await loadPaperStats(paperSession.id) : null;

  // Read-only ledger integrity check over rows Phase 6 already wrote. A fill
  // must satisfy cashPnl - sellFeeValue == economicNetPnl and must carry the
  // balances it produced; anything else is a mismatch. Null when unmeasurable.
  let reconciliationMismatches: number | null = null;
  if (paperSession) {
    const fills = await loadPaperLedger(paperSession.id, { outcome: "FILLED", limit: 500 });
    reconciliationMismatches = fills.filter((f) => {
      const cash = f.cashPnlIrtToman;
      const feeValue = f.sellFeeValueToman;
      const economic = f.economicNetPnlToman;
      if (cash === null || feeValue === null || economic === null) return true;
      if (cash - feeValue !== economic) return true;
      return f.balancesAfter.length === 0;
    }).length;
  }

  const report = evaluateReadiness({
    observation: observation
      ? {
          status: observation.status,
          elapsedMs: observation.elapsedMs,
          targetDurationMs: observation.targetDurationMs,
          successCoveragePercent: observation.successCoveragePercent
        }
      : null,
    collector: worker
      ? {
          running: Boolean(!worker.stale && worker.leaseHeld),
          heartbeatStale: Boolean(worker.stale),
          duplicateIdempotencyKeys: runStats.duplicateIdempotencyKeys,
          successfulCycles: runStats.successfulRuns,
          lastCycleStatus: worker.lastCycleStatus
        }
      : null,
    capitalRecommendation,
    paper: paperSession
      ? {
          sessionPresent: true,
          status: paperSession.status,
          cyclesEvaluated: paperSession.cyclesEvaluated,
          tradesExecuted: paperStats?.filled ?? 0,
          failedDecisions: paperStats?.skipped ?? 0,
          economicNetPnlToman: paperStats?.economicNetPnlToman ?? 0
        }
      : null,
    reconciliationMismatches,
    venueStates,
    policies,
    attestations,
    nowMs: Date.now()
  });

  return { report, policies, attestations };
}

export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const [{ report, policies, attestations }, reviews, policyHistory] = await Promise.all([
    buildReport(),
    loadReadinessReviews(30),
    loadRiskPolicyHistory(undefined, 100)
  ]);

  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      liveBanner: LIVE_NOT_IMPLEMENTED_BANNER_EN,
      liveBannerFa: LIVE_NOT_IMPLEMENTED_BANNER_FA,
      // Structural facts, repeated in the payload so no client can misread them.
      liveExecutionImplemented: LIVE_EXECUTION_IMPLEMENTED,
      canArm: false,
      canPlaceRealOrders: false,
      unavailableReasonFa: LIVE_UNAVAILABLE_REASON_FA,
      serverNow: new Date().toISOString(),
      report,
      policies,
      policyDefinitions: REQUIRED_RISK_POLICIES,
      attestations,
      policyHistory,
      reviews
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}

/**
 * Actions: `review` (record an audit entry), `set_policy`, `attest`.
 *
 * There is deliberately no `arm`, `enable` or `execute` action — not disabled,
 * absent. Live execution is not implemented, so no request can start it.
 */
export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("بدنهٔ JSON نامعتبر");
  }

  if (FORBIDDEN_FIELDS.some((k) => k in body)) {
    return bad(
      "این بخش هیچ کلید API، رمز یا اطلاعات محرمانه‌ای نمی‌پذیرد و ذخیره نمی‌کند.",
      "forbidden_field"
    );
  }

  const action = String(body.action ?? "");
  if (["arm", "enable_live", "execute", "go_live"].includes(action)) {
    return new NextResponse(
      JSON.stringify({
        error: "not_implemented",
        message: LIVE_UNAVAILABLE_REASON_FA,
        liveExecutionImplemented: LIVE_EXECUTION_IMPLEMENTED
      }),
      { status: 501, headers: SHADOW_NO_STORE }
    );
  }
  if (!["review", "set_policy", "attest"].includes(action)) {
    return bad("عملیات نامعتبر است");
  }

  if (action === "set_policy") {
    const policyKey = String(body.policyKey ?? "");
    const value = Number(body.value);
    const check = validatePolicyValue(policyKey, value);
    if (!check.ok) return bad(check.messageFa);
    // The approver states the validity period; the code never picks one.
    const rawValidity = body.validForDays;
    let validForDays: number | null = null;
    if (rawValidity !== undefined && rawValidity !== null) {
      const n = Number(rawValidity);
      if (!Number.isFinite(n) || n < 1 || n > 3_650) {
        return bad("مدت اعتبار باید بین ۱ تا ۳۶۵۰ روز باشد یا اصلاً تعیین نشود");
      }
      validForDays = Math.round(n);
    }
    await recordRiskPolicy({
      policyKey,
      value,
      setBy: session.u ?? "admin",
      validForDays,
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null
    });
  }

  if (action === "attest") {
    const kind = String(body.kind ?? "") as AttestationKind;
    if (!ATTESTATION_KINDS.includes(kind)) return bad("نوع تأییدیه نامعتبر است");
    const rawClaims = body.claims;
    if (!rawClaims || typeof rawClaims !== "object" || Array.isArray(rawClaims)) {
      return bad("فهرست تأییدها نامعتبر است");
    }
    const claims: Record<string, boolean | number | string | null> = {};
    for (const [k, v] of Object.entries(rawClaims as Record<string, unknown>)) {
      if (FORBIDDEN_FIELDS.some((f) => k.toLowerCase().includes(f.toLowerCase()))) {
        return bad("نام فیلد تأیید مجاز نیست.", "forbidden_field");
      }
      claims[k.slice(0, 64)] =
        typeof v === "boolean" || typeof v === "number" ? v : typeof v === "string" ? v.slice(0, 200) : null;
    }
    await recordAttestation({
      kind,
      confirmedBy: session.u ?? "admin",
      claims,
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null
    });
  }

  const { report, policies, attestations } = await buildReport();

  if (action === "review") {
    await recordReadinessReview({
      reviewedBy: session.u ?? "admin",
      gateState: report.gateState,
      effectiveState: report.effectiveState,
      passedCount: report.passedCount,
      blockedCount: report.blockedCount,
      blockers: report.blockers.map((b) => ({ gate: b.gate, blocker: b.blockerFa })),
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null
    });
  }

  const [reviews, policyHistory] = await Promise.all([
    loadReadinessReviews(30),
    loadRiskPolicyHistory(undefined, 100)
  ]);

  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      liveBanner: LIVE_NOT_IMPLEMENTED_BANNER_EN,
      liveBannerFa: LIVE_NOT_IMPLEMENTED_BANNER_FA,
      liveExecutionImplemented: LIVE_EXECUTION_IMPLEMENTED,
      canArm: false,
      canPlaceRealOrders: false,
      unavailableReasonFa: LIVE_UNAVAILABLE_REASON_FA,
      serverNow: new Date().toISOString(),
      report,
      policies,
      policyDefinitions: REQUIRED_RISK_POLICIES,
      attestations,
      policyHistory,
      reviews
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
