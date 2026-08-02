/**
 * Phase 8E-B — append-only fee-tier and execution-mode evidence.
 *
 * Two rules define this file.
 *
 * APPEND ONLY. Nothing here issues UPDATE or DELETE. A correction is a new row
 * under a new evidence key, so the history of what was believed — and when —
 * survives instead of being overwritten by whatever is true today.
 *
 * FAIL CLOSED ON MISMATCH. `selectEffectiveFee` returns a fee only when the
 * evidence matches the venue AND the execution mode AND the tier currently in
 * force, and has not expired. It never falls back to another tier, another mode
 * or a venue-wide default: a rate confirmed for one thing is not evidence about
 * another, and quietly substituting one is how a 0/0 order-book fee would end
 * up making a Convert trade look free.
 *
 * Simulation only. No credential, no exchange call, no order, no transfer.
 */
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDbAsync } from "@/db/client";
import { shadowFeeTierEvidence } from "@/db/schema";
import { runSerialized } from "@/db/repositories/shadowArbitrage";

/** The venue behaviours a fee can be evidenced for. */
export const EXECUTION_MODES = ["ORDER_BOOK", "EASY_TRADE", "CONVERT", "OTC_QUOTE"] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const EXECUTION_MODE_FA: Record<ExecutionMode, string> = {
  ORDER_BOOK: "دفتر سفارش (معاملهٔ بازار)",
  EASY_TRADE: "خرید و فروش آسان",
  CONVERT: "تبدیل",
  OTC_QUOTE: "نقل‌قول OTC"
};

/**
 * Which modes may price an executable net-profit calculation.
 *
 * Only the two the engine actually walks. Easy Trade and Convert are recorded
 * as reference metadata so their rates are visible, and are deliberately not
 * executable — the sizer has no model of them, and pricing a trade with a rate
 * from a flow the engine cannot execute would be a fabrication.
 */
export const EXECUTABLE_MODES: ExecutionMode[] = ["ORDER_BOOK", "OTC_QUOTE"];

export type FeeTierRecord = {
  id: string;
  sourceId: string;
  executionMode: ExecutionMode;
  /** Null when the evidence named no tier. */
  tierLabel: string | null;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  provenance: string;
  evidenceKey: string;
  confirmedBy: string;
  confirmedAt: string;
  validForDays: number | null;
  expiresAt: string | null;
  sourceUrl: string | null;
  note: string | null;
  /** When we recorded it. Breaks ties when two confirmations share a stamp. */
  createdAt: string;
};

function toIso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function hydrate(row: typeof shadowFeeTierEvidence.$inferSelect): FeeTierRecord {
  return {
    id: row.id,
    sourceId: row.sourceId,
    executionMode: row.executionMode as ExecutionMode,
    tierLabel: row.tierLabel,
    makerFeeBps: row.makerFeeBps,
    takerFeeBps: row.takerFeeBps,
    provenance: row.provenance,
    evidenceKey: row.evidenceKey,
    confirmedBy: row.confirmedBy,
    confirmedAt: toIso(row.confirmedAt) as string,
    validForDays: row.validForDays,
    expiresAt: toIso(row.expiresAt),
    sourceUrl: row.sourceUrl,
    note: row.note,
    createdAt: toIso(row.createdAt) as string
  };
}

export type RecordFeeTierInput = {
  sourceId: string;
  executionMode: ExecutionMode;
  tierLabel: string | null;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  provenance: string;
  evidenceKey: string;
  confirmedBy: string;
  confirmedAt: string;
  validForDays: number | null;
  sourceUrl?: string | null;
  note?: string | null;
};

/**
 * Append one confirmation.
 *
 * Idempotent by evidence key: re-importing the same confirmation returns the
 * existing row untouched rather than writing a second one. A genuinely new
 * confirmation carries a new key and appends beside the old.
 */
export async function recordFeeTierEvidence(input: RecordFeeTierInput): Promise<FeeTierRecord> {
  if (!EXECUTION_MODES.includes(input.executionMode)) {
    throw new Error(`unknown execution mode: ${input.executionMode}`);
  }
  return runSerialized(async () => {
    const db = await getDbAsync();
    const existing = await db
      .select()
      .from(shadowFeeTierEvidence)
      .where(
        and(
          eq(shadowFeeTierEvidence.sourceId, input.sourceId),
          eq(shadowFeeTierEvidence.executionMode, input.executionMode),
          eq(shadowFeeTierEvidence.evidenceKey, input.evidenceKey)
        )
      )
      .limit(1);
    if (existing.length) return hydrate(existing[0]);

    const confirmedAtMs = Date.parse(input.confirmedAt);
    // Expiry is derived from the approver's own validity period; when they
    // stated none, there is no expiry rather than an assumed one.
    const expiresAt =
      input.validForDays === null
        ? null
        : new Date(confirmedAtMs + input.validForDays * 86_400_000).toISOString();

    const [row] = await db
      .insert(shadowFeeTierEvidence)
      .values({
        id: randomUUID(),
        sourceId: input.sourceId,
        executionMode: input.executionMode,
        tierLabel: input.tierLabel,
        makerFeeBps: input.makerFeeBps,
        takerFeeBps: input.takerFeeBps,
        provenance: input.provenance,
        evidenceKey: input.evidenceKey,
        confirmedBy: input.confirmedBy,
        confirmedAt: new Date(confirmedAtMs).toISOString(),
        validForDays: input.validForDays,
        expiresAt,
        sourceUrl: input.sourceUrl ?? null,
        note: input.note ?? null
      })
      .returning();
    return hydrate(row);
  });
}

/** Every confirmation for a venue, newest first. History is never pruned. */
export async function listFeeTierEvidence(sourceId?: string): Promise<FeeTierRecord[]> {
  const db = await getDbAsync();
  const q = db.select().from(shadowFeeTierEvidence);
  const rows = sourceId
    ? await q
        .where(eq(shadowFeeTierEvidence.sourceId, sourceId))
        .orderBy(desc(shadowFeeTierEvidence.confirmedAt))
    : await q.orderBy(desc(shadowFeeTierEvidence.confirmedAt));
  return rows.map(hydrate);
}

export type FeeSelectionMiss =
  | "no_evidence_for_mode"
  | "tier_mismatch"
  | "expired"
  | "fees_missing";

export const FEE_SELECTION_MISS_FA: Record<FeeSelectionMiss, string> = {
  no_evidence_for_mode: "برای این صرافی در این حالتِ اجرا هیچ شواهدی ثبت نشده است",
  tier_mismatch: "پلکان فعلی با پلکان ثبت‌شده در شواهد کارمزد یکی نیست؛ تا تأیید مجدد معتبر نیست",
  expired: "اعتبار شواهد کارمزد منقضی شده است",
  fees_missing: "شواهد ثبت شده اما نرخ maker/taker در آن نیست"
};

export type FeeSelection =
  | {
      ok: true;
      record: FeeTierRecord;
      makerFeeBps: number;
      takerFeeBps: number;
      tierLabel: string | null;
      executable: boolean;
    }
  | { ok: false; miss: FeeSelectionMiss; detailFa: string; record: FeeTierRecord | null };

/**
 * The fee that applies right now, or an exact reason there is none.
 *
 * Matching is on venue AND mode AND tier. A tier change therefore invalidates
 * the fee evidence by construction: the newest record for the mode no longer
 * matches the tier in force, and this returns `tier_mismatch` until someone
 * confirms fees for the new tier. Nothing is inherited from another tier.
 */
export function selectEffectiveFee(input: {
  records: FeeTierRecord[];
  sourceId: string;
  executionMode: ExecutionMode;
  /** The tier currently in force. Null means the venue states none. */
  currentTierLabel: string | null;
  nowMs: number;
}): FeeSelection {
  const forMode = input.records
    .filter((r) => r.sourceId === input.sourceId && r.executionMode === input.executionMode)
    /*
     * Newest first. Two confirmations can carry the SAME confirmedAt — a bulk
     * import stamps one instant across every venue — so recording time breaks
     * the tie and the id settles it. Without that the "newest" record would
     * depend on row order, and the effective fee could change between reads.
     */
    .sort(
      (a, b) =>
        Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) ||
        Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        b.id.localeCompare(a.id)
    );

  if (!forMode.length) {
    return {
      ok: false,
      miss: "no_evidence_for_mode",
      detailFa: FEE_SELECTION_MISS_FA.no_evidence_for_mode,
      record: null
    };
  }

  const newest = forMode[0];

  if ((newest.tierLabel ?? null) !== (input.currentTierLabel ?? null)) {
    return {
      ok: false,
      miss: "tier_mismatch",
      detailFa: `${FEE_SELECTION_MISS_FA.tier_mismatch} — شواهد برای «${newest.tierLabel ?? "بدون پلکان"}» است و پلکان فعلی «${input.currentTierLabel ?? "بدون پلکان"}» است.`,
      record: newest
    };
  }

  if (newest.expiresAt !== null && Date.parse(newest.expiresAt) <= input.nowMs) {
    return {
      ok: false,
      miss: "expired",
      detailFa: `${FEE_SELECTION_MISS_FA.expired} (${newest.expiresAt}).`,
      record: newest
    };
  }

  if (newest.makerFeeBps === null || newest.takerFeeBps === null) {
    return {
      ok: false,
      miss: "fees_missing",
      detailFa: FEE_SELECTION_MISS_FA.fees_missing,
      record: newest
    };
  }

  return {
    ok: true,
    record: newest,
    makerFeeBps: newest.makerFeeBps,
    takerFeeBps: newest.takerFeeBps,
    tierLabel: newest.tierLabel,
    // Reference modes are visible but may never price an executable trade.
    executable: EXECUTABLE_MODES.includes(input.executionMode)
  };
}
