/**
 * PAPER-V2 Phase 1A — fee evidence horizon for economically valid Paper runs.
 *
 * Fail-closed: never extends validity, never falls back to compiled defaults,
 * never treats stale/expired fee evidence as known. A planned N-day run that
 * cannot keep required executable venue fees current through planned_end must
 * not start as economically valid. Mid-run expiry marks ECONOMICS_INVALID /
 * DEGRADED_FROM_TIMESTAMP rather than silently continuing as valid.
 */
import type { VenueEffectiveFee } from "@/lib/shadowArbitrage/effectiveFees";

export const FEE_WARNING_WINDOWS_MS = {
  T_24H: 24 * 60 * 60 * 1000,
  T_6H: 6 * 60 * 60 * 1000
} as const;

export type FeeWarningLevel = "ok" | "T_24H" | "T_6H" | "EXPIRED";

export type FeeHorizonBlocker = {
  sourceId: string;
  executionMode: string | null;
  tierLabel: string | null;
  expiresAt: string | null;
  miss: string | null;
  reason:
    | "expires_before_planned_end"
    | "already_expired"
    | "no_evidence"
    | "tier_mismatch"
    | "fees_missing"
    | "not_ok";
  detailFa: string;
};

export type FeeHorizonValidation = {
  ok: boolean;
  plannedEndIso: string;
  nowMs: number;
  blockers: FeeHorizonBlocker[];
};

export type FeeExpiryWarning = {
  sourceId: string;
  executionMode: string | null;
  tierLabel: string | null;
  expiresAt: string;
  msUntilExpiry: number;
  level: Exclude<FeeWarningLevel, "ok" | "EXPIRED">;
};

export type FeeRuntimeHorizon = {
  economicsState: "ECONOMICS_VALID" | "ECONOMICS_INVALID";
  degradedFromTimestamp: string | null;
  warnings: FeeExpiryWarning[];
  expired: FeeHorizonBlocker[];
};

function isExecutableVenue(v: VenueEffectiveFee): boolean {
  return v.executable === true && v.executionMode !== null;
}

function missReason(v: VenueEffectiveFee): FeeHorizonBlocker["reason"] {
  if (v.miss === "tier_mismatch") return "tier_mismatch";
  if (v.miss === "expired") return "already_expired";
  if (v.miss === "fees_missing") return "fees_missing";
  if (v.miss === "no_evidence_for_mode" || v.miss === "reference_only_venue") {
    return "no_evidence";
  }
  if (!v.ok) return "not_ok";
  return "not_ok";
}

/**
 * Pre-run gate: every required executable venue must have fee evidence that
 * remains valid strictly past planned_end (expiresAt > plannedEndMs).
 * Non-expiring evidence (expiresAt === null) is accepted when ok.
 */
export function validateFeeHorizonForRun(input: {
  venues: VenueEffectiveFee[];
  plannedEndMs: number;
  nowMs: number;
  /** When set, only these venue ids are required (session allocation). */
  requiredSourceIds?: string[] | null;
}): FeeHorizonValidation {
  const plannedEndIso = new Date(input.plannedEndMs).toISOString();
  const required = input.requiredSourceIds?.length
    ? new Set(input.requiredSourceIds)
    : null;
  const blockers: FeeHorizonBlocker[] = [];

  for (const v of input.venues) {
    if (!isExecutableVenue(v)) continue;
    if (required && !required.has(v.sourceId)) continue;

    if (!v.ok || v.takerFeeBps === null) {
      blockers.push({
        sourceId: v.sourceId,
        executionMode: v.executionMode,
        tierLabel: v.evidenceTierLabel ?? v.currentTierLabel,
        expiresAt: v.expiresAt,
        miss: v.miss,
        reason: missReason(v),
        detailFa:
          v.blockerFa ??
          `شواهد کارمزد برای ${v.sourceId} معتبر نیست؛ اجرای اقتصادی قابل شروع نیست.`
      });
      continue;
    }

    if (v.expiresAt === null) {
      // Explicit non-expiring evidence — accepted, never invented.
      continue;
    }

    const expMs = Date.parse(v.expiresAt);
    if (!Number.isFinite(expMs)) {
      blockers.push({
        sourceId: v.sourceId,
        executionMode: v.executionMode,
        tierLabel: v.evidenceTierLabel ?? v.currentTierLabel,
        expiresAt: v.expiresAt,
        miss: v.miss,
        reason: "not_ok",
        detailFa: `expiresAt نامعتبر برای ${v.sourceId}`
      });
      continue;
    }

    if (expMs <= input.nowMs) {
      blockers.push({
        sourceId: v.sourceId,
        executionMode: v.executionMode,
        tierLabel: v.evidenceTierLabel ?? v.currentTierLabel,
        expiresAt: v.expiresAt,
        miss: "expired",
        reason: "already_expired",
        detailFa: `شواهد کارمزد ${v.sourceId} از ${v.expiresAt} منقضی است.`
      });
      continue;
    }

    if (expMs <= input.plannedEndMs) {
      blockers.push({
        sourceId: v.sourceId,
        executionMode: v.executionMode,
        tierLabel: v.evidenceTierLabel ?? v.currentTierLabel,
        expiresAt: v.expiresAt,
        miss: null,
        reason: "expires_before_planned_end",
        detailFa: `شواهد کارمزد ${v.sourceId} در ${v.expiresAt} منقضی می‌شود که قبل از پایان برنامه‌ریزی‌شده (${plannedEndIso}) است.`
      });
    }
  }

  return {
    ok: blockers.length === 0,
    plannedEndIso,
    nowMs: input.nowMs,
    blockers
  };
}

/** Warning windows before expiry for still-valid evidence (T-24h / T-6h). */
export function feeExpiryWarnings(input: {
  venues: VenueEffectiveFee[];
  nowMs: number;
  requiredSourceIds?: string[] | null;
}): FeeExpiryWarning[] {
  const required = input.requiredSourceIds?.length
    ? new Set(input.requiredSourceIds)
    : null;
  const out: FeeExpiryWarning[] = [];

  for (const v of input.venues) {
    if (!isExecutableVenue(v) || !v.ok || v.expiresAt === null) continue;
    if (required && !required.has(v.sourceId)) continue;
    const expMs = Date.parse(v.expiresAt);
    if (!Number.isFinite(expMs)) continue;
    const msUntil = expMs - input.nowMs;
    if (msUntil <= 0) continue;
    let level: FeeExpiryWarning["level"] | null = null;
    if (msUntil <= FEE_WARNING_WINDOWS_MS.T_6H) level = "T_6H";
    else if (msUntil <= FEE_WARNING_WINDOWS_MS.T_24H) level = "T_24H";
    if (!level) continue;
    out.push({
      sourceId: v.sourceId,
      executionMode: v.executionMode,
      tierLabel: v.evidenceTierLabel ?? v.currentTierLabel,
      expiresAt: v.expiresAt,
      msUntilExpiry: msUntil,
      level
    });
  }
  return out.sort((a, b) => a.msUntilExpiry - b.msUntilExpiry);
}

/**
 * Runtime monitor: if required fee evidence has expired, economics are invalid
 * from the earliest expiry timestamp. Collector may continue; validity does not.
 */
export function assessRuntimeFeeHorizon(input: {
  venues: VenueEffectiveFee[];
  nowMs: number;
  requiredSourceIds?: string[] | null;
  priorDegradedFromTimestamp?: string | null;
}): FeeRuntimeHorizon {
  const required = input.requiredSourceIds?.length
    ? new Set(input.requiredSourceIds)
    : null;
  const expired: FeeHorizonBlocker[] = [];
  let earliestExpiryMs: number | null = null;

  for (const v of input.venues) {
    if (!isExecutableVenue(v)) continue;
    if (required && !required.has(v.sourceId)) continue;

    const expMsParsed =
      v.expiresAt !== null && Number.isFinite(Date.parse(v.expiresAt))
        ? Date.parse(v.expiresAt)
        : null;
    const expiredNow =
      (!v.ok && v.miss === "expired") ||
      (expMsParsed !== null && expMsParsed <= input.nowMs && (!v.ok || v.takerFeeBps === null));

    // Also catch ok=false after selectEffectiveFee expired miss while expiresAt still set.
    const treatedExpired =
      expiredNow ||
      (!v.ok && v.miss === "expired") ||
      (v.ok === false && expMsParsed !== null && expMsParsed <= input.nowMs);

    if (!treatedExpired) continue;

    const expMs = expMsParsed ?? input.nowMs;
    if (earliestExpiryMs === null || expMs < earliestExpiryMs) {
      earliestExpiryMs = expMs;
    }
    expired.push({
      sourceId: v.sourceId,
      executionMode: v.executionMode,
      tierLabel: v.evidenceTierLabel ?? v.currentTierLabel,
      expiresAt: v.expiresAt,
      miss: v.miss ?? "expired",
      reason: "already_expired",
      detailFa:
        v.blockerFa ??
        `شواهد کارمزد ${v.sourceId} منقضی شده؛ اقتصاد آزمایش دیگر معتبر نیست.`
    });
  }

  const warnings = feeExpiryWarnings(input);

  if (expired.length === 0) {
    return {
      economicsState: input.priorDegradedFromTimestamp
        ? "ECONOMICS_INVALID"
        : "ECONOMICS_VALID",
      degradedFromTimestamp: input.priorDegradedFromTimestamp ?? null,
      warnings,
      expired: []
    };
  }

  const degradedFrom =
    input.priorDegradedFromTimestamp ??
    (earliestExpiryMs !== null
      ? new Date(earliestExpiryMs).toISOString()
      : new Date(input.nowMs).toISOString());

  return {
    economicsState: "ECONOMICS_INVALID",
    degradedFromTimestamp: degradedFrom,
    warnings,
    expired
  };
}

export type EconomicsValidityAudit = {
  state: "ECONOMICS_VALID" | "ECONOMICS_INVALID";
  reportState: "ECONOMICS_VALID" | "DEGRADED_FROM_TIMESTAMP";
  degradedFromTimestamp: string | null;
  updatedAt: string;
  expiredVenues: FeeHorizonBlocker[];
  warnings: FeeExpiryWarning[];
};

export function toEconomicsValidityAudit(
  runtime: FeeRuntimeHorizon,
  nowMs: number
): EconomicsValidityAudit {
  return {
    state: runtime.economicsState,
    reportState:
      runtime.economicsState === "ECONOMICS_INVALID"
        ? "DEGRADED_FROM_TIMESTAMP"
        : "ECONOMICS_VALID",
    degradedFromTimestamp: runtime.degradedFromTimestamp,
    updatedAt: new Date(nowMs).toISOString(),
    expiredVenues: runtime.expired,
    warnings: runtime.warnings
  };
}
