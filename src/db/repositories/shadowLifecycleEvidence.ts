/**
 * Append-only lifecycle decision evidence (full funnel).
 * Best-effort writes — must never throw into the paper path.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { asDbError, getDbAsync } from "@/db/client";
import { runSerialized } from "@/db/repositories/shadowArbitrage";
import { shadowPaperLifecycleEvidence } from "@/db/schema";
import type { LifecycleDecisionEvidence } from "@/lib/shadowArbitrage/paper/lifecycleFunnel";

const serial = runSerialized;

export async function appendLifecycleEvidence(input: {
  evidence: LifecycleDecisionEvidence;
  releaseVersion?: string | null;
  policyFingerprint?: string | null;
}): Promise<{ id: string } | { error: string }> {
  try {
    const db = await getDbAsync();
    const id = randomUUID();
    const e = input.evidence;
    await serial(async () => {
      await db.insert(shadowPaperLifecycleEvidence).values({
        id,
        sessionId: e.sessionId,
        runId: e.runId,
        ledgerId: e.ledgerId,
        lifecycleId: e.lifecycleId,
        routeKey: e.routeKey,
        buySourceId: e.buySourceId,
        sellSourceId: e.sellSourceId,
        occurredAt: e.occurredAt,
        outcome: e.outcome,
        terminalReason: e.terminalReason,
        reasonCodes: e.reasonCodes,
        evidence: e as unknown as Record<string, unknown>,
        stages: e.stages as unknown as Array<Record<string, unknown>>,
        releaseVersion: input.releaseVersion ?? null,
        policyFingerprint: input.policyFingerprint ?? e.policy.fingerprint,
        fixtureLabel: e.label ?? null,
        createdAt: e.occurredAt
      });
    });
    return { id };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export async function getLifecycleEvidenceByLifecycleId(
  lifecycleId: string,
  limit = 50
): Promise<Array<typeof shadowPaperLifecycleEvidence.$inferSelect>> {
  try {
    const db = await getDbAsync();
    return await serial(async () =>
      db
        .select()
        .from(shadowPaperLifecycleEvidence)
        .where(eq(shadowPaperLifecycleEvidence.lifecycleId, lifecycleId))
        .orderBy(desc(shadowPaperLifecycleEvidence.occurredAt))
        .limit(Math.min(200, Math.max(1, limit)))
    );
  } catch (error) {
    throw asDbError(error, "getLifecycleEvidenceByLifecycleId");
  }
}

export async function listLifecycleEvidence(input: {
  sessionId: string;
  limit?: number;
}): Promise<Array<typeof shadowPaperLifecycleEvidence.$inferSelect>> {
  try {
    const db = await getDbAsync();
    const limit = Math.min(200, Math.max(1, input.limit ?? 50));
    return await serial(async () =>
      db
        .select()
        .from(shadowPaperLifecycleEvidence)
        .where(eq(shadowPaperLifecycleEvidence.sessionId, input.sessionId))
        .orderBy(desc(shadowPaperLifecycleEvidence.occurredAt))
        .limit(limit)
    );
  } catch (error) {
    throw asDbError(error, "listLifecycleEvidence");
  }
}

export async function countEvidenceMissingTerminal(sessionId: string): Promise<number> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowPaperLifecycleEvidence)
        .where(
          and(
            eq(shadowPaperLifecycleEvidence.sessionId, sessionId),
            eq(shadowPaperLifecycleEvidence.outcome, "SKIPPED")
          )
        )
        .limit(5000)
    );
    return rows.filter((r) => !r.terminalReason || r.terminalReason === "sizing_blocked").length;
  } catch {
    return -1;
  }
}
