/**
 * Ensure Local Paper telemetry path is live for continuous / bounded runs.
 *
 * Root cause (SHADOW continuous 2026-09-09): shadow-worker launched with
 * SHADOW_RELEASE_BOOTSTRAP=false and WITHOUT a RUNNING paper session or fee
 * seed → runPaperExecutionIsolated returned no_session → paper tables n=0 and
 * every lifecycle fee_unknown.
 *
 * Opt-in via SHADOW_PAPER_ENSURE=1 (or true/yes/on). Never invents fills.
 * LIVE remains false forever in this path.
 *
 * Observation identity: creates/links a real shadow_observation_sessions row
 * (typed identity: paper session ≠ experiment ≠ observation ≠ run). Never
 * invents metadata or conflates experimentId with observationId.
 */
import { SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import { seedLocalFeeEvidence } from "@/lib/shadowArbitrage/localFeeEvidenceSeed";
import { defaultAllocation } from "@/lib/shadowArbitrage/paper/portfolio";
import { PAPER_POLICY_SET } from "@/lib/shadowArbitrage/live/paperPolicySet";
import { recordRiskPolicy } from "@/db/repositories/shadowLive";
import {
  createPaperSession,
  getActivePaperSession,
  linkPaperSessionObservation,
  setPaperSessionStatus
} from "@/db/repositories/shadowPaper";
import {
  ensureObservationSession,
  setObservationStatus
} from "@/db/repositories/shadowArbitrage";

export function paperEnsureEnabled(): boolean {
  const raw = (process.env.SHADOW_PAPER_ENSURE ?? "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(raw);
}

export type LocalPaperEnsureResult = {
  enabled: true;
  feeSeed: Awaited<ReturnType<typeof seedLocalFeeEvidence>>;
  policiesWritten: number;
  sessionId: string;
  observationId: string;
  sessionReused: boolean;
  decisionTraceForced: boolean;
  capitalToman: number;
};

const DEFAULT_CAPITAL = 100_000_000;
const DEFAULT_MARK = 200_000;
const DEFAULT_POLL_MS = 30_000;

/**
 * Ensure a durable RUNNING observation session for Local Paper.
 * If the latest observation is COMPLETED, open a new one (additive; history kept).
 */
async function ensureDurableLocalObservation(pollIntervalMs = DEFAULT_POLL_MS) {
  let observation = await ensureObservationSession(pollIntervalMs);
  if (observation.status === "COMPLETED") {
    observation = await setObservationStatus("start", pollIntervalMs);
  }
  return observation;
}

/**
 * Seed fees + paper policies + RUNNING session; force decision traces on.
 * Always links a real observationId (never null on the ensure create/reuse path).
 */
export async function ensureLocalPaperTelemetry(input?: {
  capitalToman?: number;
  markPriceToman?: number;
  createdBy?: string;
}): Promise<LocalPaperEnsureResult | { enabled: false }> {
  if (!paperEnsureEnabled()) return { enabled: false };

  // Decision traces must be on for full funnel evidence persistence.
  if (!process.env.SHADOW_DECISION_TRACE) {
    process.env.SHADOW_DECISION_TRACE = "true";
  }
  const decisionTraceForced = ["1", "true", "yes", "on"].includes(
    (process.env.SHADOW_DECISION_TRACE ?? "").trim().toLowerCase()
  );

  const feeSeed = await seedLocalFeeEvidence();

  let policiesWritten = 0;
  for (const e of PAPER_POLICY_SET) {
    await recordRiskPolicy({
      policyKey: e.key,
      value: e.value,
      setBy: input?.createdBy ?? "shadow-paper-ensure",
      validForDays: 30,
      note: "local paper ensure — telemetry path"
    });
    policiesWritten += 1;
  }

  const capital = input?.capitalToman ?? DEFAULT_CAPITAL;
  const mark = input?.markPriceToman ?? DEFAULT_MARK;
  const observation = await ensureDurableLocalObservation(DEFAULT_POLL_MS);
  const existing = await getActivePaperSession();
  if (existing && existing.status === "RUNNING") {
    let observationId = existing.observationId;
    if (!observationId) {
      const linked = await linkPaperSessionObservation(existing.id, observation.id);
      observationId = linked?.observationId ?? observation.id;
    }
    return {
      enabled: true,
      feeSeed,
      policiesWritten,
      sessionId: existing.id,
      observationId,
      sessionReused: true,
      decisionTraceForced,
      capitalToman: existing.totalCapitalToman
    };
  }
  if (existing && existing.status !== "STOPPED") {
    await setPaperSessionStatus(existing.id, "STOPPED");
  }

  const venueIds = SHADOW_SOURCES.map((s) => s.id);
  const alloc = defaultAllocation(capital, venueIds, mark);
  const session = await createPaperSession({
    observationId: observation.id,
    name: "Local Paper ensure (telemetry)",
    mode: "APPROVED_PLAN",
    totalCapitalToman: capital,
    valuationPriceToman: mark,
    openingAllocations: alloc,
    approvalFingerprint: "shadow-paper-ensure",
    createdBy: input?.createdBy ?? "shadow-paper-ensure",
    note: "SHADOW_PAPER_ENSURE — LIVE=false; no real orders"
  });
  await setPaperSessionStatus(session.id, "RUNNING");

  return {
    enabled: true,
    feeSeed,
    policiesWritten,
    sessionId: session.id,
    observationId: observation.id,
    sessionReused: false,
    decisionTraceForced,
    capitalToman: capital
  };
}
