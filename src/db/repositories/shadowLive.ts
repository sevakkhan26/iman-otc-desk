/**
 * Phase 7A persistence — readiness attestations, risk policies and review
 * audit trail. All three are append-only.
 *
 * These tables hold STATEMENTS about readiness. They never hold an API key,
 * secret, token or any credential, and nothing here can reach an exchange.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import { asDbError, getDbAsync } from "@/db/client";
import { runSerialized } from "@/db/repositories/shadowArbitrage";
import {
  shadowLiveAttestations,
  shadowLiveReadinessReviews,
  shadowLiveRiskPolicies
} from "@/db/schema";
import type { AttestationKind, AttestationRecord } from "@/lib/shadowArbitrage/live/readiness";
import type { RiskPolicyValue } from "@/lib/shadowArbitrage/live/policy";

const serial = runSerialized;

function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Full attestation history, newest first. Nothing is ever updated or deleted. */
export async function loadAttestations(limit = 200): Promise<AttestationRecord[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowLiveAttestations)
        .orderBy(desc(shadowLiveAttestations.confirmedAt))
        .limit(Math.min(500, Math.max(1, limit)))
    );
    return rows.map((r) => ({
      kind: r.kind as AttestationKind,
      confirmedBy: r.confirmedBy,
      confirmedAt: r.confirmedAt,
      claims: (r.claims ?? {}) as AttestationRecord["claims"],
      note: r.note
    }));
  } catch {
    return [];
  }
}

export async function recordAttestation(input: {
  kind: AttestationKind;
  confirmedBy: string;
  claims: Record<string, boolean | number | string | null>;
  note?: string | null;
}): Promise<AttestationRecord> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      kind: input.kind,
      confirmedBy: input.confirmedBy,
      confirmedAt: now,
      claims: input.claims,
      note: input.note ?? null,
      createdAt: now
    };
    await serial(async () => db.insert(shadowLiveAttestations).values(row));
    return {
      kind: input.kind,
      confirmedBy: row.confirmedBy,
      confirmedAt: row.confirmedAt,
      claims: row.claims,
      note: row.note
    };
  } catch (error) {
    throw asDbError(error, "recordAttestation");
  }
}

/** Latest value per policy key. Absent keys stay unset, never defaulted. */
export async function loadRiskPolicyValues(): Promise<RiskPolicyValue[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowLiveRiskPolicies)
        // seq breaks ties when two values share a millisecond.
        .orderBy(desc(shadowLiveRiskPolicies.setAt), desc(shadowLiveRiskPolicies.seq))
        .limit(500)
    );
    const latest = new Map<string, RiskPolicyValue>();
    for (const r of rows) {
      if (latest.has(r.policyKey)) continue;
      latest.set(r.policyKey, {
        key: r.policyKey as RiskPolicyValue["key"],
        value: num(r.value),
        provenance: "ADMIN_APPROVED",
        validForDays: r.validForDays ?? null,
        setBy: r.setBy,
        setAt: r.setAt,
        note: r.note
      });
    }
    return [...latest.values()];
  } catch {
    return [];
  }
}

export async function loadRiskPolicyHistory(policyKey?: string, limit = 100) {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () => {
      const q = db.select().from(shadowLiveRiskPolicies);
      const filtered = policyKey ? q.where(eq(shadowLiveRiskPolicies.policyKey, policyKey)) : q;
      return filtered
        .orderBy(desc(shadowLiveRiskPolicies.setAt), desc(shadowLiveRiskPolicies.seq))
        .limit(Math.min(500, limit));
    });
    return rows.map((r) => ({
      policyKey: r.policyKey,
      value: num(r.value),
      provenance: r.provenance,
      validForDays: r.validForDays ?? null,
      setBy: r.setBy,
      setAt: r.setAt,
      note: r.note
    }));
  } catch {
    return [];
  }
}

export async function recordRiskPolicy(input: {
  policyKey: string;
  value: number;
  setBy: string;
  /** Chosen by the approver. Null means they stated no expiry. */
  validForDays?: number | null;
  note?: string | null;
}): Promise<RiskPolicyValue> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    // seq is assigned by the database sequence, so it is never supplied here.
    const row = {
      id: randomUUID(),
      policyKey: input.policyKey,
      value: String(input.value),
      provenance: "ADMIN_APPROVED",
      validForDays: input.validForDays ?? null,
      setBy: input.setBy,
      setAt: now,
      note: input.note ?? null,
      createdAt: now
    };
    await serial(async () => db.insert(shadowLiveRiskPolicies).values(row));
    return {
      key: input.policyKey as RiskPolicyValue["key"],
      value: input.value,
      provenance: "ADMIN_APPROVED",
      validForDays: input.validForDays ?? null,
      setBy: input.setBy,
      setAt: now,
      note: row.note
    };
  } catch (error) {
    throw asDbError(error, "recordRiskPolicy");
  }
}

export type PolicySetApplyEntry = { policyKey: string; value: number };

export type PolicySetApplyResult = {
  setKey: string;
  fingerprint: string;
  appliedAt: string;
  /** Keys this call actually wrote. */
  applied: string[];
  /** Keys left alone because a newer admin value is already in force. */
  preserved: string[];
};

/**
 * Apply a whole policy set in ONE transaction, or apply none of it.
 *
 * Six independent writes were the wrong shape: a failure on the fifth left the
 * desk in a configuration nobody reviewed — four new numbers and two old ones —
 * and the audit trail recorded it as though someone had chosen that mixture.
 *
 * Here every value is validated first, then all of them are written inside a
 * single transaction. A rejection anywhere rolls the whole set back, so the
 * stored state is always either the previous set or the new one.
 *
 * Append-only: nothing is updated or deleted. The previous values stay in the
 * history exactly as they were, and `loadRiskPolicyValues` resolves the latest
 * by `setAt` then `seq`.
 *
 * `preserveKeys` names values the caller must not overwrite — used by the
 * startup bootstrap, which is allowed to fill a gap but never to overrule an
 * administrator who has already decided.
 */
export async function applyRiskPolicySet(input: {
  setKey: string;
  fingerprint: string;
  entries: PolicySetApplyEntry[];
  setBy: string;
  validForDays: number | null;
  note?: string | null;
  /** Keys to leave untouched, even though they belong to the set. */
  preserveKeys?: string[];
  /**
   * Runs inside the SAME transaction, after every policy row is written. The
   * bootstrap uses it to insert its marker, so the marker cannot exist unless
   * all six rows do — and a losing race on the marker rolls the rows back too.
   */
  afterAll?: (tx: Parameters<Parameters<Awaited<ReturnType<typeof getDbAsync>>["transaction"]>[0]>[0]) => Promise<void>;
}): Promise<PolicySetApplyResult> {
  const preserve = new Set(input.preserveKeys ?? []);
  const toWrite = input.entries.filter((e) => !preserve.has(e.policyKey));

  // Validate BEFORE opening the transaction: a rejection here has written
  // nothing at all, which is a cheaper and clearer failure than a rollback.
  for (const e of toWrite) {
    if (!Number.isFinite(e.value)) {
      throw new Error(`مقدار نامعتبر برای ${e.policyKey}`);
    }
  }

  try {
    const db = await getDbAsync();
    const appliedAt = new Date().toISOString();
    const note = input.note ?? `مجموعهٔ ${input.setKey} (${input.fingerprint})`;

    await serial(async () =>
      db.transaction(async (tx) => {
        for (const e of toWrite) {
          await tx.insert(shadowLiveRiskPolicies).values({
            id: randomUUID(),
            policyKey: e.policyKey,
            value: String(e.value),
            provenance: "ADMIN_APPROVED",
            validForDays: input.validForDays,
            setBy: input.setBy,
            setAt: appliedAt,
            note,
            createdAt: appliedAt
          });
        }
        if (input.afterAll) await input.afterAll(tx);
      })
    );

    return {
      setKey: input.setKey,
      fingerprint: input.fingerprint,
      appliedAt,
      applied: toWrite.map((e) => e.policyKey),
      preserved: [...preserve]
    };
  } catch (error) {
    throw asDbError(error, "applyRiskPolicySet");
  }
}

export type ReadinessReviewRow = {
  id: string;
  reviewedBy: string;
  reviewedAt: string;
  gateState: string;
  effectiveState: string;
  passedCount: number;
  blockedCount: number;
  blockers: Array<Record<string, string>>;
  note: string | null;
};

export async function loadReadinessReviews(limit = 50): Promise<ReadinessReviewRow[]> {
  try {
    const db = await getDbAsync();
    const rows = await serial(async () =>
      db
        .select()
        .from(shadowLiveReadinessReviews)
        .orderBy(desc(shadowLiveReadinessReviews.reviewedAt))
        .limit(Math.min(200, Math.max(1, limit)))
    );
    return rows.map((r) => ({
      id: r.id,
      reviewedBy: r.reviewedBy,
      reviewedAt: r.reviewedAt,
      gateState: r.gateState,
      effectiveState: r.effectiveState,
      passedCount: r.passedCount,
      blockedCount: r.blockedCount,
      blockers: Array.isArray(r.blockers) ? r.blockers : [],
      note: r.note
    }));
  } catch {
    return [];
  }
}

/**
 * Record one readiness review. `effectiveState` is written as reported by the
 * engine, which is structurally DISARMED — a review is an observation, not an
 * arming action.
 */
export async function recordReadinessReview(input: {
  reviewedBy: string;
  gateState: string;
  effectiveState: string;
  passedCount: number;
  blockedCount: number;
  blockers: Array<Record<string, string>>;
  note?: string | null;
}): Promise<ReadinessReviewRow> {
  try {
    const db = await getDbAsync();
    const now = new Date().toISOString();
    const row = {
      id: randomUUID(),
      reviewedBy: input.reviewedBy,
      reviewedAt: now,
      gateState: input.gateState,
      effectiveState: input.effectiveState,
      passedCount: input.passedCount,
      blockedCount: input.blockedCount,
      blockers: input.blockers,
      note: input.note ?? null,
      createdAt: now
    };
    await serial(async () => db.insert(shadowLiveReadinessReviews).values(row));
    return {
      id: row.id,
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt,
      gateState: row.gateState,
      effectiveState: row.effectiveState,
      passedCount: row.passedCount,
      blockedCount: row.blockedCount,
      blockers: row.blockers,
      note: row.note
    };
  } catch (error) {
    throw asDbError(error, "recordReadinessReview");
  }
}
