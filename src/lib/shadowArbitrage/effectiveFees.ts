/**
 * Phase 8E-B — the one place the runtime asks "what fee applies to this venue?".
 *
 * Before this file, `shadow_fee_tier_evidence` was parallel data: the table was
 * written and displayed, while every consumer — the collector, the paper
 * engine, capital, readiness — still took its rate from the latest row of
 * `shadow_fee_confirmations`, which knows nothing about execution mode or tier.
 * A 0/0 rate evidenced for Arzinja's order book would have priced any flow.
 *
 * Now the tier evidence is authoritative for the APPLIED maker/taker rate, and
 * the older confirmation table keeps only the roles it is actually evidence for:
 *
 *   * the tier the account is on right now (`feeTier`) — the input matching is
 *     performed AGAINST, never a substitute for a missing rate;
 *   * reference metadata (quoted-market rates and similar) that is displayed and
 *     never settled;
 *   * the venue's official documentation link.
 *
 * Nothing here lets the old table, another tier, another execution mode or a
 * compiled-in venue default supply a rate. When the evidence does not match, the
 * venue carries NO fee and every consumer treats it as fee-unknown. That is the
 * whole point: a missing fee must cost the venue its executability, not be
 * quietly replaced by the nearest available number.
 *
 * Simulation only. No credential, no exchange call, no order, no transfer.
 */
import { loadLatestFeeConfirmations } from "@/db/repositories/shadowArbitrage";
import type { FeeConfirmationRow } from "@/db/repositories/shadowArbitrage";
import {
  EXECUTABLE_MODES,
  EXECUTION_MODE_FA,
  listFeeTierEvidence,
  selectEffectiveFee
} from "@/db/repositories/shadowFeeTier";
import type {
  ExecutionMode,
  FeeSelectionMiss,
  FeeTierRecord
} from "@/db/repositories/shadowFeeTier";
import { SHADOW_SOURCES, getSourceConfig } from "@/lib/shadowArbitrage/config";
import type { FeeBlock, FeeOverride } from "@/lib/shadowArbitrage/accounts";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

/**
 * The execution mode a venue's rate has to be evidenced for.
 *
 * Derived from the market model the adapter actually walks — an order book or a
 * dealer quote — so the mode used for matching is the mode the engine executes
 * in, not a label someone typed. A reference-only venue executes in no mode at
 * all and therefore has none.
 */
export function executionModeFor(sourceId: ShadowSourceId): ExecutionMode | null {
  const model = getSourceConfig(sourceId).marketModel;
  if (model === "ORDER_BOOK") return "ORDER_BOOK";
  if (model === "OTC_QUOTE") return "OTC_QUOTE";
  return null;
}

/** Why a venue has no applicable fee, beyond the four evidence-level misses. */
export type ExtraMiss = "reference_only_venue";

export type EffectiveFeeMiss = FeeSelectionMiss | ExtraMiss;

export const EXTRA_MISS_FA: Record<ExtraMiss, string> = {
  reference_only_venue:
    "این منبع در هیچ حالت اجرایی معامله نمی‌شود؛ کارمزد اجرایی برای آن معنا ندارد"
};

/** Everything known about the fee that applies — or does not — to one venue. */
export type VenueEffectiveFee = {
  sourceId: ShadowSourceId;
  nameFa: string;
  executionMode: ExecutionMode | null;
  executionModeFa: string;
  /**
   * The tier the account is on right now, taken from the newest append-only
   * account/fee confirmation. Null means the venue declares no tier — which is
   * a real state, matched exactly, never widened into "any tier".
   */
  currentTierLabel: string | null;
  /** The tier the applied rate was evidenced for. */
  evidenceTierLabel: string | null;
  ok: boolean;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  provenance: string | null;
  evidenceKey: string | null;
  confirmedBy: string | null;
  confirmedAt: string | null;
  validForDays: number | null;
  expiresAt: string | null;
  sourceUrl: string | null;
  note: string | null;
  miss: EffectiveFeeMiss | null;
  blockerFa: string | null;
  /** Whether this mode may ever price an executable trade. */
  executable: boolean;
  /**
   * The venue's non-executed flows. Present so the panel can state that Easy
   * Trade and Convert are NOT covered by the rate above, rather than leaving a
   * reader to assume one venue means one fee.
   */
  referenceModes: ReferenceModeRow[];
  /** Statements the panel prints verbatim. Derived here, never in React. */
  noticesFa: string[];
  /** Every confirmation ever recorded for this venue, all modes, newest first. */
  history: FeeTierRecord[];
};

export type ReferenceModeRow = {
  mode: ExecutionMode;
  modeFa: string;
  hasEvidence: boolean;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  labelFa: string;
};

/** Modes the engine never executes in. Their rates are shown, never applied. */
export const REFERENCE_MODES: ExecutionMode[] = ["EASY_TRADE", "CONVERT"];

export const NO_EVIDENCE_FOR_REFERENCE_MODE_FA = "اعمال نمی‌شود؛ شواهد این حالت وجود ندارد";
export const REFERENCE_ONLY_MODE_FA = "فقط مرجع؛ در محاسبهٔ اجرا اعمال نمی‌شود";
export const ZERO_FEE_ORDER_BOOK_ONLY_FA = "کارمزد ۰/۰ فقط برای دفتر سفارش";
export const QUOTE_EXECUTABLE_NO_TIER_FA = "نقل‌قول اجراپذیر — پلکان اعلام نشده";

/**
 * What the panel must say about a venue, decided from the evidence.
 *
 * These are conditions, not venue names: the zero-fee caveat appears for any
 * venue whose order-book rate is zero, and the no-tier quote caveat for any
 * dealer venue whose evidence names no tier. Today that is Arzinja and
 * AbanTether; hard-coding either id would make the label a decoration rather
 * than a statement about the data.
 */
function noticesFor(input: {
  mode: ExecutionMode | null;
  ok: boolean;
  makerFeeBps: number | null;
  takerFeeBps: number | null;
  evidenceTierLabel: string | null;
  executable: boolean;
}): string[] {
  const out: string[] = [];
  if (
    input.ok &&
    input.mode === "ORDER_BOOK" &&
    input.makerFeeBps === 0 &&
    input.takerFeeBps === 0
  ) {
    out.push(ZERO_FEE_ORDER_BOOK_ONLY_FA);
  }
  if (input.ok && input.mode === "OTC_QUOTE" && input.executable && input.evidenceTierLabel === null) {
    out.push(QUOTE_EXECUTABLE_NO_TIER_FA);
  }
  return out;
}

/** Newest record per non-executed mode, with an explicit label when absent. */
function referenceModesFor(records: FeeTierRecord[], sourceId: string): ReferenceModeRow[] {
  return REFERENCE_MODES.map((mode) => {
    const newest = records
      .filter((r) => r.sourceId === sourceId && r.executionMode === mode)
      .sort(
        (a, b) =>
          Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) || b.seq - a.seq
      )[0];
    return {
      mode,
      modeFa: EXECUTION_MODE_FA[mode],
      hasEvidence: Boolean(newest),
      makerFeeBps: newest?.makerFeeBps ?? null,
      takerFeeBps: newest?.takerFeeBps ?? null,
      labelFa: newest ? REFERENCE_ONLY_MODE_FA : NO_EVIDENCE_FOR_REFERENCE_MODE_FA
    };
  });
}

export type EffectiveFees = {
  nowMs: number;
  venues: VenueEffectiveFee[];
  byVenue: Record<string, VenueEffectiveFee>;
  /** Readiness input for venues whose evidence matched. */
  overrides: FeeOverride[];
  /** Readiness input for venues that failed closed, with the exact reason. */
  blocks: FeeBlock[];
  /**
   * Applied taker rate per venue, for `computeRouteEconomics`.
   *
   * Every venue is present. A blocked venue maps to an explicit `null`, which
   * that function reads as "no fee is known" rather than as "not supplied" —
   * the difference between failing closed and falling back to a config default.
   */
  confirmedFeeBps: Partial<Record<ShadowSourceId, number | null>>;
  /** The full append-only table, for audit surfaces. */
  records: FeeTierRecord[];
};

/**
 * Pure builder — the same logic the runtime uses, with the two reads injected
 * so it can be tested without a database.
 */
export function buildEffectiveFees(input: {
  records: FeeTierRecord[];
  confirmations: Record<string, FeeConfirmationRow>;
  nowMs: number;
}): EffectiveFees {
  const venues: VenueEffectiveFee[] = [];
  const overrides: FeeOverride[] = [];
  const blocks: FeeBlock[] = [];
  const confirmedFeeBps: Partial<Record<ShadowSourceId, number | null>> = {};

  for (const cfg of SHADOW_SOURCES) {
    const sourceId = cfg.id;
    const confirmation = input.confirmations[sourceId] ?? null;
    const currentTierLabel = confirmation?.feeTier ?? null;
    const mode = executionModeFor(sourceId);
    const history = input.records
      .filter((r) => r.sourceId === sourceId)
      .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt) || b.seq - a.seq);

    if (mode === null) {
      const blockerFa = EXTRA_MISS_FA.reference_only_venue;
      venues.push({
        sourceId,
        nameFa: cfg.nameFa,
        executionMode: null,
        executionModeFa: "—",
        currentTierLabel,
        evidenceTierLabel: null,
        ok: false,
        makerFeeBps: null,
        takerFeeBps: null,
        provenance: null,
        evidenceKey: null,
        confirmedBy: null,
        confirmedAt: null,
        validForDays: null,
        expiresAt: null,
        sourceUrl: confirmation?.sourceUrl ?? cfg.feeReferenceUrl,
        note: null,
        miss: "reference_only_venue",
        blockerFa,
        executable: false,
        referenceModes: referenceModesFor(input.records, sourceId),
        noticesFa: [],
        history
      });
      blocks.push({ sourceId, miss: "reference_only_venue", detailFa: blockerFa });
      confirmedFeeBps[sourceId] = null;
      continue;
    }

    const selection = selectEffectiveFee({
      records: input.records,
      sourceId,
      executionMode: mode,
      currentTierLabel,
      nowMs: input.nowMs
    });

    if (selection.ok) {
      const rec = selection.record;
      venues.push({
        sourceId,
        nameFa: cfg.nameFa,
        executionMode: mode,
        executionModeFa: EXECUTION_MODE_FA[mode],
        currentTierLabel,
        evidenceTierLabel: rec.tierLabel,
        ok: true,
        makerFeeBps: selection.makerFeeBps,
        takerFeeBps: selection.takerFeeBps,
        provenance: rec.provenance,
        evidenceKey: rec.evidenceKey,
        confirmedBy: rec.confirmedBy,
        confirmedAt: rec.confirmedAt,
        validForDays: rec.validForDays,
        expiresAt: rec.expiresAt,
        sourceUrl: rec.sourceUrl ?? confirmation?.sourceUrl ?? cfg.feeReferenceUrl,
        note: rec.note,
        miss: null,
        blockerFa: null,
        executable: selection.executable,
        referenceModes: referenceModesFor(input.records, sourceId),
        noticesFa: noticesFor({
          mode,
          ok: true,
          makerFeeBps: selection.makerFeeBps,
          takerFeeBps: selection.takerFeeBps,
          evidenceTierLabel: rec.tierLabel,
          executable: selection.executable
        }),
        history
      });
      overrides.push({
        sourceId,
        // The applied rate comes from the tier evidence and from nowhere else.
        takerFeeBps: selection.takerFeeBps,
        makerFeeBps: selection.makerFeeBps,
        feeTier: rec.tierLabel,
        sourceUrl: rec.sourceUrl ?? confirmation?.sourceUrl ?? null,
        provenance: rec.provenance,
        validDays: rec.validForDays,
        /*
         * Reference metadata (quoted-market or easy-trade rates) is descriptive,
         * never settled, so it is carried over from the confirmation it was
         * recorded on rather than being dropped or promoted to an applied rate.
         */
        referenceMetadata: confirmation?.referenceMetadata ?? null,
        confirmedBy: rec.confirmedBy,
        confirmedAt: rec.confirmedAt,
        note: rec.note
      });
      confirmedFeeBps[sourceId] = selection.takerFeeBps;
      continue;
    }

    const rec = selection.record;
    venues.push({
      sourceId,
      nameFa: cfg.nameFa,
      executionMode: mode,
      executionModeFa: EXECUTION_MODE_FA[mode],
      currentTierLabel,
      evidenceTierLabel: rec?.tierLabel ?? null,
      ok: false,
      // Fail closed: a mismatched or expired record supplies no rate at all.
      makerFeeBps: null,
      takerFeeBps: null,
      provenance: rec?.provenance ?? null,
      evidenceKey: rec?.evidenceKey ?? null,
      confirmedBy: rec?.confirmedBy ?? null,
      confirmedAt: rec?.confirmedAt ?? null,
      validForDays: rec?.validForDays ?? null,
      expiresAt: rec?.expiresAt ?? null,
      sourceUrl: rec?.sourceUrl ?? confirmation?.sourceUrl ?? cfg.feeReferenceUrl,
      note: rec?.note ?? null,
      miss: selection.miss,
      blockerFa: selection.detailFa,
      executable: EXECUTABLE_MODES.includes(mode),
      referenceModes: referenceModesFor(input.records, sourceId),
      noticesFa: [],
      history
    });
    blocks.push({ sourceId, miss: selection.miss, detailFa: selection.detailFa });
    confirmedFeeBps[sourceId] = null;
  }

  return {
    nowMs: input.nowMs,
    venues,
    byVenue: Object.fromEntries(venues.map((v) => [v.sourceId, v])),
    overrides,
    blocks,
    confirmedFeeBps,
    records: input.records
  };
}

/**
 * The runtime entry point. Every consumer calls this instead of reading fee
 * confirmations directly.
 *
 * A failed read of the evidence table yields no records, so every venue fails
 * closed rather than the request failing — the safe direction, and the same
 * outcome as an empty table.
 */
export async function loadEffectiveFees(nowMs: number = Date.now()): Promise<EffectiveFees> {
  const [records, confirmations] = await Promise.all([
    listFeeTierEvidence().catch(() => [] as FeeTierRecord[]),
    loadLatestFeeConfirmations()
  ]);
  return buildEffectiveFees({ records, confirmations, nowMs });
}
