/**
 * Phase 8C-5 — append-only storage for allocation proposals.
 *
 * Two guarantees define this file:
 *
 * APPEND ONLY. Nothing here issues UPDATE, DELETE or DROP against either table.
 * A proposal is written once; its lifecycle is expressed by appending a
 * decision row. That is what makes "what did we propose, and what did we
 * accept" answerable months later rather than inferred from current state.
 *
 * APPLY ONCE. `applyProposal` inserts its decision row under a unique
 * idempotency key inside the same serialized section that writes the balances.
 * A duplicate request loses the insert and returns the FIRST outcome — it never
 * re-applies, and two concurrent applies cannot both succeed.
 *
 * Everything stored is virtual. Applying a proposal rewrites the balances of a
 * PAPER session; it places no order and moves no funds.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDbAsync } from "@/db/client";
import {
  shadowAllocationDecisions,
  shadowAllocationProposals,
  shadowPaperBalances
} from "@/db/schema";
import { runSerialized } from "@/db/repositories/shadowArbitrage";

/** Drivers return a Date or an ISO string depending on the backend. */
function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export type ProposalRow = {
  sourceId: string;
  role: string;
  irtToman: number;
  usdtUnits: number;
  valueToman: number;
  sharePercent: number;
  buyCapacityUsdtMicros: number | null;
  sellCapacityUsdtMicros: number | null;
  buyLimiter: string | null;
  sellLimiter: string | null;
  buyReason: string;
  sellReason: string;
  reasonFa: string;
};

export type Fingerprints = {
  books: string;
  fees: string;
  accounts: string;
  policy: string;
};

/**
 * A stable digest of the evidence a proposal was built from.
 *
 * Sorted before hashing so an unordered read cannot change the fingerprint;
 * two identical worlds must always produce the same string, or staleness
 * detection would fire at random.
 */
export function fingerprint(value: unknown): string {
  const canonical = JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
  return createHash("sha256").update(canonical ?? "null").digest("hex").slice(0, 32);
}

export type StoredProposal = {
  id: string;
  totalCapitalToman: number;
  valuationPriceToman: number;
  allocatedToman: number;
  residualToman: number;
  rows: ProposalRow[];
  fingerprints: Fingerprints;
  appliedPolicyCaps: Record<string, number>;
  unsetPolicyCaps: string[];
  observations: unknown[];
  status: string;
  createdBy: string;
  note: string | null;
  createdAt: string;
};

/** Write one proposal. Never overwrites: every call appends a new row. */
export async function recordProposal(input: {
  totalCapitalToman: number;
  valuationPriceToman: number;
  allocatedToman: number;
  residualToman: number;
  rows: ProposalRow[];
  fingerprints: Fingerprints;
  appliedPolicyCaps: Record<string, number>;
  unsetPolicyCaps: string[];
  observations: unknown[];
  createdBy: string;
  note?: string | null;
}): Promise<StoredProposal> {
  /*
   * Conservation is a storage invariant, not a display detail. A proposal that
   * does not add up must never reach the database, because a later apply would
   * copy the error straight into the virtual balances.
   */
  if (input.residualToman !== 0 || input.allocatedToman !== input.totalCapitalToman) {
    throw new Error(
      `allocation proposal does not conserve capital: allocated ${input.allocatedToman} vs total ${input.totalCapitalToman}`
    );
  }

  return runSerialized(async () => {
    const db = await getDbAsync();
    const [row] = await db
      .insert(shadowAllocationProposals)
      .values({
        id: randomUUID(),
        totalCapitalToman: input.totalCapitalToman,
        valuationPriceToman: input.valuationPriceToman,
        allocatedToman: input.allocatedToman,
        residualToman: input.residualToman,
        rows: input.rows,
        booksFingerprint: input.fingerprints.books,
        feesFingerprint: input.fingerprints.fees,
        accountsFingerprint: input.fingerprints.accounts,
        policyFingerprint: input.fingerprints.policy,
        appliedPolicyCaps: input.appliedPolicyCaps,
        unsetPolicyCaps: input.unsetPolicyCaps,
        observations: input.observations,
        status: "PROPOSED",
        createdBy: input.createdBy,
        note: input.note ?? null
      })
      .returning();
    return hydrate(row);
  });
}

function hydrate(row: typeof shadowAllocationProposals.$inferSelect): StoredProposal {
  return {
    id: row.id,
    totalCapitalToman: Number(row.totalCapitalToman),
    valuationPriceToman: Number(row.valuationPriceToman),
    allocatedToman: Number(row.allocatedToman),
    residualToman: Number(row.residualToman),
    rows: (row.rows ?? []) as ProposalRow[],
    fingerprints: {
      books: row.booksFingerprint,
      fees: row.feesFingerprint,
      accounts: row.accountsFingerprint,
      policy: row.policyFingerprint
    },
    appliedPolicyCaps: (row.appliedPolicyCaps ?? {}) as Record<string, number>,
    unsetPolicyCaps: (row.unsetPolicyCaps ?? []) as string[],
    observations: (row.observations ?? []) as unknown[],
    status: row.status,
    createdBy: row.createdBy,
    note: row.note,
    createdAt: toIso(row.createdAt)
  };
}

export async function listProposals(limit = 20): Promise<StoredProposal[]> {
  const db = await getDbAsync();
  const rows = await db
    .select()
    .from(shadowAllocationProposals)
    .orderBy(desc(shadowAllocationProposals.createdAt))
    .limit(limit);
  return rows.map(hydrate);
}

export async function getProposal(id: string): Promise<StoredProposal | null> {
  const db = await getDbAsync();
  const rows = await db
    .select()
    .from(shadowAllocationProposals)
    .where(eq(shadowAllocationProposals.id, id))
    .limit(1);
  return rows.length ? hydrate(rows[0]) : null;
}

/** Every decision ever appended for a proposal, newest first. */
export async function listDecisions(proposalId?: string, limit = 50) {
  const db = await getDbAsync();
  const q = db.select().from(shadowAllocationDecisions);
  const rows = proposalId
    ? await q
        .where(eq(shadowAllocationDecisions.proposalId, proposalId))
        .orderBy(desc(shadowAllocationDecisions.decidedAt))
        .limit(limit)
    : await q.orderBy(desc(shadowAllocationDecisions.decidedAt)).limit(limit);
  return rows;
}

export type ApplyOutcome = {
  ok: boolean;
  decision: "APPLIED" | "REJECTED_STALE" | "FAILED";
  detailFa: string;
  /** True when this call did nothing because the key was already used. */
  idempotentReplay: boolean;
  proposalId: string;
  decidedAt: string;
};

/**
 * Apply a proposal to a paper session's virtual balances.
 *
 * Refuses when the world has moved: the caller passes the fingerprints it just
 * derived, and any difference means the proposal was computed against evidence
 * that no longer holds. A stale apply is recorded as a decision too — a refusal
 * is part of the audit trail, not an absence from it.
 *
 * The balance writes and the decision insert share one serialized section, so a
 * partial apply cannot survive: if the decision insert loses the unique-key
 * race, the balances written in that same section are rolled back with it.
 */
export async function applyProposal(input: {
  proposalId: string;
  sessionId: string;
  idempotencyKey: string;
  currentFingerprints: Fingerprints;
  decidedBy: string;
}): Promise<ApplyOutcome> {
  return runSerialized(async () => {
    const db = await getDbAsync();

    // An already-used key returns the FIRST outcome; nothing is re-applied.
    const existing = await db
      .select()
      .from(shadowAllocationDecisions)
      .where(eq(shadowAllocationDecisions.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (existing.length) {
      const d = existing[0];
      return {
        ok: d.decision === "APPLIED",
        decision: d.decision as ApplyOutcome["decision"],
        detailFa: d.detailFa,
        idempotentReplay: true,
        proposalId: d.proposalId,
        decidedAt: toIso(d.decidedAt)
      };
    }

    const found = await db
      .select()
      .from(shadowAllocationProposals)
      .where(eq(shadowAllocationProposals.id, input.proposalId))
      .limit(1);
    if (!found.length) throw new Error("proposal not found");
    const proposal = hydrate(found[0]);

    /*
     * A proposal is applied at most once, whatever key is presented.
     *
     * Per-key idempotency alone only stops a RETRY; it would still let a new
     * key re-apply the same plan, appending a second APPLIED row and making
     * "when did this allocation take effect" ambiguous. The proposal itself is
     * the unit that gets applied once — generate a fresh one to allocate again.
     */
    const already = await db
      .select()
      .from(shadowAllocationDecisions)
      .where(
        and(
          eq(shadowAllocationDecisions.proposalId, proposal.id),
          eq(shadowAllocationDecisions.decision, "APPLIED")
        )
      )
      .limit(1);
    if (already.length) {
      const d = already[0];
      return {
        ok: false,
        decision: "APPLIED",
        detailFa: `این پیشنهاد قبلاً در ${toIso(d.decidedAt)} اعمال شده است؛ برای تخصیص دوباره یک پیشنهاد تازه بسازید.`,
        idempotentReplay: true,
        proposalId: proposal.id,
        decidedAt: toIso(d.decidedAt)
      };
    }

    const drifted = (
      [
        ["books", "دفتر سفارش"],
        ["fees", "کارمزدها"],
        ["accounts", "شواهد حساب"],
        ["policy", "سیاست‌های ریسک"]
      ] as Array<[keyof Fingerprints, string]>
    ).filter(([k]) => proposal.fingerprints[k] !== input.currentFingerprints[k]);

    if (drifted.length) {
      const detailFa = `پیشنهاد کهنه است — از زمان ساخت آن ${drifted
        .map(([, fa]) => fa)
        .join("، ")} تغییر کرده است. پیشنهاد تازه بسازید.`;
      const [rec] = await db
        .insert(shadowAllocationDecisions)
        .values({
          id: randomUUID(),
          proposalId: proposal.id,
          sessionId: input.sessionId,
          decision: "REJECTED_STALE",
          idempotencyKey: input.idempotencyKey,
          detailFa,
          balancesBefore: null,
          balancesAfter: null,
          decidedBy: input.decidedBy
        })
        .returning();
      return {
        ok: false,
        decision: "REJECTED_STALE",
        detailFa,
        idempotentReplay: false,
        proposalId: proposal.id,
        decidedAt: toIso(rec.decidedAt)
      };
    }

    const before = await db
      .select()
      .from(shadowPaperBalances)
      .where(eq(shadowPaperBalances.sessionId, input.sessionId));

    const balancesBefore = before.map((b) => ({
      sourceId: b.sourceId,
      irtToman: Number(b.irtToman),
      usdtMicros: Number(b.usdtMicros)
    }));

    // Write the new virtual balances. Every venue in the proposal is written;
    // a venue absent from the proposal keeps whatever it had.
    for (const row of proposal.rows) {
      const usdtMicros = Math.round(row.usdtUnits * 1_000_000);
      const existingRow = before.find((b) => b.sourceId === row.sourceId);
      if (existingRow) {
        await db
          .update(shadowPaperBalances)
          .set({ irtToman: row.irtToman, usdtMicros })
          .where(
            and(
              eq(shadowPaperBalances.sessionId, input.sessionId),
              eq(shadowPaperBalances.sourceId, row.sourceId)
            )
          );
      } else {
        // The id is `${sessionId}|${sourceId}` by contract, which is what keeps
        // a repeated insert from creating a second row for the same venue.
        await db.insert(shadowPaperBalances).values({
          id: `${input.sessionId}|${row.sourceId}`,
          sessionId: input.sessionId,
          sourceId: row.sourceId,
          irtToman: row.irtToman,
          usdtMicros
        });
      }
    }

    const balancesAfter = proposal.rows.map((r) => ({
      sourceId: r.sourceId,
      irtToman: r.irtToman,
      usdtMicros: Math.round(r.usdtUnits * 1_000_000)
    }));

    const detailFa = `تخصیص پیشنهادی روی ${proposal.rows.length} صرافی اعمال شد؛ مجموع ${proposal.allocatedToman.toLocaleString("en-US")} تومان با باقی‌ماندهٔ صفر.`;

    /*
     * The decision insert is last on purpose. It is the only write protected by
     * a unique index, so if a concurrent apply already took the key this insert
     * throws and rolls back the balance writes above with it.
     */
    const [rec] = await db
      .insert(shadowAllocationDecisions)
      .values({
        id: randomUUID(),
        proposalId: proposal.id,
        sessionId: input.sessionId,
        decision: "APPLIED",
        idempotencyKey: input.idempotencyKey,
        detailFa,
        balancesBefore,
        balancesAfter,
        decidedBy: input.decidedBy
      })
      .returning();

    return {
      ok: true,
      decision: "APPLIED",
      detailFa,
      idempotentReplay: false,
      proposalId: proposal.id,
      decidedAt: toIso(rec.decidedAt)
    };
  });
}
