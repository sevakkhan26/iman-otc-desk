/**
 * PAPER-V2 Phase 1B — bounded reject-path diagnostics for Paper ledger rows.
 *
 * Goal: next run can classify false negatives from persisted fields rather than
 * estimating them. No strategy change — telemetry only, auditable and bounded.
 */
import type { VenueEffectiveFee } from "@/lib/shadowArbitrage/effectiveFees";
import type { CoherenceResult } from "@/lib/shadowArbitrage/streaming/eventFabric";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import type { SizingResult } from "@/lib/shadowArbitrage/paper/sizing";

/** Compact, JSON-safe reject diagnostics stored in ledger sizing_audit. */
export type RejectDiagnostics = {
  version: "paper_v2_reject_diagnostics_v1";
  rejectionCodes: string[];
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  candidateSizeUsdt: number;
  prices?: {
    buyVwapToman: number | null;
    sellVwapToman: number | null;
  };
  economics?: {
    grossSpreadToman: number | null;
    netProfitToman: number | null;
    economicNetPnlToman: number | null;
    riskAdjustedPnlToman: number | null;
    buyFeeBps: number | null;
    sellFeeBps: number | null;
  };
  /** sizing_blocked — exact blocker code(s), constraints, quantities. */
  sizingAudit?: Record<string, unknown> | null;
  /** market_data_time_incoherent — skew + both source timestamps/ages. */
  coherence?: {
    /** Comparable-clock gate skew (|buyReceive − sellReceive|). */
    sourceSkewMs: number | null;
    /** Raw venue-server clock delta; diagnostic only, not the gate. */
    venueClockSkewMs: number | null;
    reason: string | null;
    buy: SourceTimeDiag | null;
    sell: SourceTimeDiag | null;
  };
  /** fee_unknown — exact miss / evidence / expiresAt per leg. */
  feeUnknown?: {
    buy: FeeMissDiag | null;
    sell: FeeMissDiag | null;
  };
};

export type SourceTimeDiag = {
  sourceId: string;
  sourceEventTimestamp: string | null;
  receivedAt: string | null;
  receiveTimestamp: string | null;
  ageMs: number | null;
  sourceEventAgeMs: number | null;
};

export type FeeMissDiag = {
  sourceId: string;
  miss: string | null;
  blockerFa: string | null;
  evidenceKey: string | null;
  expiresAt: string | null;
  confirmedAt: string | null;
  tierLabel: string | null;
  executionMode: string | null;
  takerFeeBps: number | null;
  ok: boolean;
};

function sourceTimeDiag(
  snap: NormalizedSourceSnapshot | undefined,
  sourceId: string
): SourceTimeDiag {
  const md = snap?.marketData;
  return {
    sourceId,
    sourceEventTimestamp: md?.sourceEventTimestamp ?? snap?.sourceTimestamp ?? null,
    receivedAt: snap?.receivedAt ?? null,
    receiveTimestamp: md?.receiveTimestamp ?? snap?.receivedAt ?? null,
    ageMs: snap?.ageMs ?? null,
    sourceEventAgeMs: md?.sourceEventAgeMs ?? null
  };
}

function feeMissDiag(
  fee: VenueEffectiveFee | undefined,
  sourceId: string
): FeeMissDiag {
  if (!fee) {
    return {
      sourceId,
      miss: "no_evidence_for_mode",
      blockerFa: null,
      evidenceKey: null,
      expiresAt: null,
      confirmedAt: null,
      tierLabel: null,
      executionMode: null,
      takerFeeBps: null,
      ok: false
    };
  }
  return {
    sourceId,
    miss: fee.miss,
    blockerFa: fee.blockerFa,
    evidenceKey: fee.evidenceKey,
    expiresAt: fee.expiresAt,
    confirmedAt: fee.confirmedAt,
    tierLabel: fee.evidenceTierLabel ?? fee.currentTierLabel,
    executionMode: fee.executionMode,
    takerFeeBps: fee.takerFeeBps,
    ok: fee.ok
  };
}

export function buildRejectDiagnostics(input: {
  rejectionCodes: string[];
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  candidateSizeUsdt: number;
  buyVwapToman?: number | null;
  sellVwapToman?: number | null;
  netProfitToman?: number | null;
  buyFeeBps?: number | null;
  sellFeeBps?: number | null;
  sizing?: SizingResult | null;
  coherence?: CoherenceResult | null;
  buySnap?: NormalizedSourceSnapshot;
  sellSnap?: NormalizedSourceSnapshot;
  buyFee?: VenueEffectiveFee | null;
  sellFee?: VenueEffectiveFee | null;
}): RejectDiagnostics {
  const codes = input.rejectionCodes;
  const base: RejectDiagnostics = {
    version: "paper_v2_reject_diagnostics_v1",
    rejectionCodes: codes,
    routeKey: input.routeKey,
    buySourceId: input.buySourceId,
    sellSourceId: input.sellSourceId,
    candidateSizeUsdt: input.candidateSizeUsdt,
    prices: {
      buyVwapToman: input.buyVwapToman ?? null,
      sellVwapToman: input.sellVwapToman ?? null
    },
    economics: {
      grossSpreadToman:
        input.buyVwapToman != null &&
        input.sellVwapToman != null &&
        Number.isFinite(input.buyVwapToman) &&
        Number.isFinite(input.sellVwapToman)
          ? Math.round(input.sellVwapToman - input.buyVwapToman)
          : null,
      netProfitToman: input.netProfitToman ?? null,
      economicNetPnlToman: input.sizing?.economics?.economicNetPnlToman ?? null,
      riskAdjustedPnlToman: input.sizing?.economics?.riskAdjustedPnlToman ?? null,
      buyFeeBps: input.buyFeeBps ?? null,
      sellFeeBps: input.sellFeeBps ?? null
    }
  };

  const sizingRelated = codes.some(
    (c) =>
      c === "sizing_blocked" || // historical reads only
      c.startsWith("sizing_") ||
      c === "insufficient_depth" ||
      c === "insufficient_irt" ||
      c === "insufficient_usdt" ||
      c === "inventory_limit" ||
      c === "net_non_positive" ||
      c === "portfolio_limits_unavailable"
  );
  if (sizingRelated && input.sizing) {
    const audit = input.sizing.audit as Record<string, unknown> | null;
    const blockerCodes = (input.sizing.blockers ?? []).map((b) => b.code);
    base.sizingAudit = {
      ...(audit ?? {}),
      blockerCodes,
      blockers: (input.sizing.blockers ?? []).map((b) => ({
        code: b.code,
        subject: b.subject,
        detailFa: b.detailFa
      })),
      status: input.sizing.status,
      bindingConstraint: input.sizing.bindingConstraint,
      sizeUsdtMicros: input.sizing.sizeUsdtMicros,
      constraints: input.sizing.constraints ?? null,
      capacity: input.sizing.capacity
        ? {
            limitingSide: input.sizing.capacity.limitingSide,
            limitingSourceId: input.sizing.capacity.limitingSourceId,
            limitingUsableMicros: input.sizing.capacity.limitingUsableMicros,
            capitalCapMicros: input.sizing.capacity.capitalCapMicros,
            depthCapMicros: input.sizing.capacity.depthCapMicros
          }
        : null
    };
  }

  if (
    codes.includes("market_data_time_incoherent") ||
    codes.includes("market_data_resync") ||
    codes.includes("stale_market_data")
  ) {
    base.coherence = {
      sourceSkewMs: input.coherence?.sourceSkewMs ?? null,
      venueClockSkewMs: input.coherence?.venueClockSkewMs ?? null,
      reason: input.coherence?.reason ?? null,
      buy: sourceTimeDiag(input.buySnap, input.buySourceId),
      sell: sourceTimeDiag(input.sellSnap, input.sellSourceId)
    };
  }

  if (codes.includes("fee_unknown") || codes.includes("fee_stale")) {
    base.feeUnknown = {
      buy: feeMissDiag(input.buyFee ?? undefined, input.buySourceId),
      sell: feeMissDiag(input.sellFee ?? undefined, input.sellSourceId)
    };
  }

  return base;
}

/** Persist diagnostics into the existing sizing_audit JSONB column on skips. */
export function diagnosticsAsSizingAudit(
  diagnostics: RejectDiagnostics | null | undefined
): Record<string, unknown> | null {
  if (!diagnostics) return null;
  return diagnostics as unknown as Record<string, unknown>;
}
