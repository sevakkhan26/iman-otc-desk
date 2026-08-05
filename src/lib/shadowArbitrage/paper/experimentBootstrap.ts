/**
 * Activate the four-day Paper experiment at application startup.
 *
 * Idempotent: marker in shadow_release_bootstrap (run_key) + unique run_key on
 * experiments. Concurrent starts: one ACTIVE wins. endsAt is written once and
 * never refreshed. Prior sessions are STOPPED via audited status transition.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDbAsync } from "@/db/client";
import {
  ensureObservationSession,
  loadLatestCapitalPlan,
  loadLatestSourceSnapshots
} from "@/db/repositories/shadowArbitrage";
import {
  completeExperiment,
  createActiveExperiment,
  experimentIsOpen,
  getActiveExperiment,
  getExperimentByRunKey
} from "@/db/repositories/shadowExperiments";
import {
  createPaperSession,
  getActivePaperSession,
  loadPaperStats,
  setPaperSessionStatus
} from "@/db/repositories/shadowPaper";
import { applyRiskPolicySet } from "@/db/repositories/shadowLive";
import { RELEASE_CAPITAL_TOMAN } from "@/lib/shadowArbitrage/releaseBootstrap";
import { defaultAllocation } from "@/lib/shadowArbitrage/paper/portfolio";
import { SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import {
  PAPER_4D_DURATION_MS,
  PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
  PAPER_4D_MAX_UTILIZATION_PERCENT,
  PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT,
  PAPER_4D_MIN_RESERVE_PERCENT,
  PAPER_4D_POLICY_SET_KEY,
  PAPER_4D_RISK_POLICIES,
  PAPER_4D_RUN_KEY,
  PAPER_4D_TARGET_UTILIZATION_PERCENT,
  deriveMaxOrderUsdt,
  paper4dCanonical
} from "@/lib/shadowArbitrage/paper/experimentPolicy";
import appVersion from "../../../../version.json";

export type ExperimentBootstrapResult = {
  ran: boolean;
  reason:
    | "applied"
    | "already-applied"
    | "completed-existing"
    | "disabled"
    | "no-valuation-price"
    | "error";
  experimentId?: string;
  sessionId?: string;
  startedAt?: string;
  endsAt?: string;
  error?: string;
};

function enabled(): boolean {
  const raw = (process.env.SHADOW_RELEASE_BOOTSTRAP ?? "").trim().toLowerCase();
  if (["false", "0", "no", "off"].includes(raw)) return false;
  if (["true", "1", "yes", "on"].includes(raw)) return true;
  return process.env.NODE_ENV === "production";
}

async function markerExists(): Promise<boolean> {
  const db = await getDbAsync();
  const r = await db.execute(
    sql`SELECT 1 FROM shadow_release_bootstrap WHERE release_key = ${PAPER_4D_RUN_KEY} LIMIT 1`
  );
  const rows = Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? []);
  return rows.length > 0;
}

async function writeMarker(detail: Record<string, unknown>): Promise<void> {
  const db = await getDbAsync();
  await db.execute(
    sql`INSERT INTO shadow_release_bootstrap (release_key, detail)
        VALUES (${PAPER_4D_RUN_KEY}, ${JSON.stringify(detail)}::jsonb)
        ON CONFLICT (release_key) DO NOTHING`
  );
}

function medianMark(
  snaps: Array<{ userBuy: number | null; userSell: number | null; stale: boolean }>
): number | null {
  const mids = snaps
    .filter((s) => !s.stale && s.userBuy && s.userSell)
    .map((s) => ((s.userBuy as number) + (s.userSell as number)) / 2)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!mids.length) return null;
  const mid = Math.floor(mids.length / 2);
  return Math.round(mids.length % 2 ? mids[mid] : (mids[mid - 1] + mids[mid]) / 2);
}

/**
 * Start or reconcile the 4-day experiment. Safe on every startup.
 */
export async function runPaperExperimentBootstrap(
  log: (message: string, extra?: unknown) => void = () => undefined
): Promise<ExperimentBootstrapResult> {
  if (!enabled()) return { ran: false, reason: "disabled" };

  try {
    // Complete expired ACTIVE runs without extending endsAt.
    const active = await getActiveExperiment();
    const nowMs = Date.now();
    if (active && !experimentIsOpen(active, nowMs)) {
      const stats = active.sessionId ? await loadPaperStats(active.sessionId) : null;
      await completeExperiment(active.id, {
        completedReason: "duration_elapsed",
        completedAt: new Date(nowMs).toISOString(),
        filled: stats?.filled ?? 0,
        skipped: stats?.skipped ?? 0,
        economicNetPnlToman: stats?.economicNetPnlToman ?? 0,
        peakUtilizationPercent: active.peakUtilizationPercent,
        averageUtilizationPercent:
          active.utilizationStats.n > 0
            ? active.utilizationStats.sum / active.utilizationStats.n
            : 0
      });
      if (active.sessionId) {
        await setPaperSessionStatus(active.sessionId, "STOPPED");
      }
      log("paper 4d experiment completed by clock", {
        id: active.id,
        endsAt: active.endsAt
      });
      return {
        ran: true,
        reason: "completed-existing",
        experimentId: active.id,
        sessionId: active.sessionId ?? undefined,
        startedAt: active.startedAt,
        endsAt: active.endsAt
      };
    }

    if (await markerExists()) {
      const existing = await getExperimentByRunKey(PAPER_4D_RUN_KEY);
      return {
        ran: false,
        reason: "already-applied",
        experimentId: existing?.id,
        sessionId: existing?.sessionId ?? undefined,
        startedAt: existing?.startedAt,
        endsAt: existing?.endsAt
      };
    }

    // Idempotent: if experiment row exists without marker, finish marker only.
    const byKey = await getExperimentByRunKey(PAPER_4D_RUN_KEY);
    if (byKey) {
      await writeMarker({ experimentId: byKey.id, sessionId: byKey.sessionId });
      return {
        ran: false,
        reason: "already-applied",
        experimentId: byKey.id,
        sessionId: byKey.sessionId ?? undefined,
        startedAt: byKey.startedAt,
        endsAt: byKey.endsAt
      };
    }

    const snaps = await loadLatestSourceSnapshots();
    const mark =
      medianMark(
        snaps.map((s) => ({
          userBuy: s.userBuy ?? null,
          userSell: s.userSell ?? null,
          stale: Boolean(s.stale)
        }))
      ) ?? null;
    // Fall back to active session valuation or capital plan.
    const plan = await loadLatestCapitalPlan();
    const valuation =
      mark ??
      plan?.valuationPriceToman ??
      (await getActivePaperSession())?.valuationPriceToman ??
      null;
    if (!valuation || valuation <= 0) {
      return { ran: false, reason: "no-valuation-price" };
    }

    const capital = RELEASE_CAPITAL_TOMAN;
    const maxOrderUsdt = deriveMaxOrderUsdt({
      equityToman: capital,
      markPriceToman: valuation,
      routeCapitalPercent: PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT
    });
    const canonical = paper4dCanonical({ maxOrderUsdt, markPriceToman: valuation });
    const fingerprint = createHash("sha256").update(canonical).digest("hex").slice(0, 32);

    // Apply risk policies: capital-relative order size + 4D risk rows.
    await applyRiskPolicySet({
      setKey: PAPER_4D_POLICY_SET_KEY,
      fingerprint,
      entries: [
        { policyKey: "max_order_size_usdt", value: maxOrderUsdt },
        ...PAPER_4D_RISK_POLICIES.map((p) => ({ policyKey: p.key, value: p.value }))
      ],
      setBy: "release-bootstrap",
      validForDays: 4,
      note: `مجموعهٔ ${PAPER_4D_POLICY_SET_KEY} — آزمایش چهارروزه (${fingerprint})`
    });

    const venueIds = SHADOW_SOURCES.map((s) => s.id);
    const allocations = defaultAllocation(capital, venueIds, valuation);

    // Close prior active paper session without deleting it.
    const previous = await getActivePaperSession();
    if (previous && previous.status !== "STOPPED") {
      await setPaperSessionStatus(previous.id, "STOPPED");
    }

    await ensureObservationSession(30_000);
    const session = await createPaperSession({
      observationId: null,
      name: `آزمایش Paper چهارروزه ${PAPER_4D_POLICY_SET_KEY}`,
      mode: "APPROVED_PLAN",
      totalCapitalToman: capital,
      valuationPriceToman: valuation,
      openingAllocations: allocations,
      approvalFingerprint: fingerprint,
      createdBy: "release-bootstrap",
      note: `4-day experiment ${PAPER_4D_RUN_KEY}`
    });
    await setPaperSessionStatus(session.id, "RUNNING");

    const startedAt = new Date().toISOString();
    const endsAt = new Date(Date.parse(startedAt) + PAPER_4D_DURATION_MS).toISOString();

    const exp = await createActiveExperiment({
      runKey: PAPER_4D_RUN_KEY,
      policySetKey: PAPER_4D_POLICY_SET_KEY,
      policyFingerprint: fingerprint,
      releaseVersion: appVersion.appVersion,
      startedAt,
      endsAt,
      sessionId: session.id,
      initialCapitalToman: capital,
      targetUtilizationPercent: PAPER_4D_TARGET_UTILIZATION_PERCENT,
      maxUtilizationPercent: PAPER_4D_MAX_UTILIZATION_PERCENT,
      minReservePercent: PAPER_4D_MIN_RESERVE_PERCENT,
      maxRouteCapitalPercent: PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
      maxVenueExposurePercent: PAPER_4D_MAX_VENUE_EXPOSURE_PERCENT,
      derivedMaxOrderUsdt: maxOrderUsdt,
      derivedMaxOrderReferencePrice: valuation,
      config: {
        durationMs: PAPER_4D_DURATION_MS,
        canonical,
        allocationVenueCount: allocations.length
      }
    });

    await writeMarker({
      experimentId: exp.id,
      sessionId: session.id,
      startedAt,
      endsAt,
      maxOrderUsdt,
      valuation,
      fingerprint
    });

    log("paper 4d experiment activated", {
      experimentId: exp.id,
      sessionId: session.id,
      startedAt,
      endsAt,
      maxOrderUsdt
    });

    return {
      ran: true,
      reason: "applied",
      experimentId: exp.id,
      sessionId: session.id,
      startedAt,
      endsAt
    };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    if (/duplicate key|unique constraint|shadow_paper_experiments/i.test(error)) {
      const existing = await getExperimentByRunKey(PAPER_4D_RUN_KEY);
      return {
        ran: false,
        reason: "already-applied",
        experimentId: existing?.id,
        sessionId: existing?.sessionId ?? undefined,
        startedAt: existing?.startedAt,
        endsAt: existing?.endsAt
      };
    }
    log("paper 4d experiment bootstrap failed", error);
    return { ran: false, reason: "error", error };
  }
}
