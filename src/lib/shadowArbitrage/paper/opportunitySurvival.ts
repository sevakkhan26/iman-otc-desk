/** Paper-only opportunity persistence and expected-capture evidence. */

export type SurvivalPolicy = {
  decisionHorizonMs: number;
  minimumObservations: number;
  conservativePriorCaptureFactor: number;
  provenance: string;
};

export const DEFAULT_SURVIVAL_POLICY: SurvivalPolicy = {
  decisionHorizonMs: 2_000,
  minimumObservations: 4,
  conservativePriorCaptureFactor: 0.25,
  provenance: "PAPER_POLICY_V1:event-decision-horizon; configurable"
};

export type OpportunityTracePoint = {
  routeKey: string;
  observedAtMs: number;
  active: boolean;
};

type RouteHistory = {
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
  activeSinceMs: number | null;
  wasActive: boolean;
  observations: number;
  activeObservations: number;
  recurrences: number;
  disappearances: number;
  completedLifetimesMs: number[];
};

export type SurvivalEstimate = {
  routeKey: string;
  firstSeenAtMs: number | null;
  lastSeenAtMs: number | null;
  continuousAgeMs: number;
  observations: number;
  recurrenceCount: number;
  disappearanceCount: number;
  disappearanceRatePerSecond: number | null;
  empiricalSurvivalAtHorizon: number | null;
  empiricalHalfLifeMs: number | null;
  captureFactor: number;
  confidence: number;
  insufficientHistory: boolean;
  provenance: string;
  policy: SurvivalPolicy;
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b);
  const midpoint = Math.floor(ordered.length / 2);
  return ordered.length % 2
    ? ordered[midpoint]
    : (ordered[midpoint - 1] + ordered[midpoint]) / 2;
}

/**
 * Deterministic replay tracker. A false→true transition is recurrence and a
 * true→false transition closes one lifetime without mutating historical rows.
 */
export class OpportunitySurvivalTracker {
  private readonly histories = new Map<string, RouteHistory>();

  observe(point: OpportunityTracePoint): void {
    if (!Number.isFinite(point.observedAtMs) || point.observedAtMs < 0) return;
    const history = this.histories.get(point.routeKey) ?? {
      firstSeenAtMs: null,
      lastSeenAtMs: null,
      activeSinceMs: null,
      wasActive: false,
      observations: 0,
      activeObservations: 0,
      recurrences: 0,
      disappearances: 0,
      completedLifetimesMs: []
    };
    if (
      history.lastSeenAtMs !== null &&
      point.observedAtMs < history.lastSeenAtMs
    ) {
      return;
    }
    history.observations += 1;
    if (point.active) {
      history.activeObservations += 1;
      if (!history.wasActive) {
        if (history.firstSeenAtMs !== null) history.recurrences += 1;
        history.activeSinceMs = point.observedAtMs;
        history.firstSeenAtMs ??= point.observedAtMs;
      }
      history.lastSeenAtMs = point.observedAtMs;
    } else if (history.wasActive) {
      history.disappearances += 1;
      history.completedLifetimesMs.push(
        Math.max(0, point.observedAtMs - (history.activeSinceMs ?? point.observedAtMs))
      );
      history.activeSinceMs = null;
      history.lastSeenAtMs = point.observedAtMs;
    } else {
      history.lastSeenAtMs = point.observedAtMs;
    }
    history.wasActive = point.active;
    this.histories.set(point.routeKey, history);
  }

  /**
   * Record one complete decision cycle. Routes seen in prior cycles but absent
   * now receive an explicit inactive observation, so disappearance evidence is
   * not lost merely because discovery stopped returning the route.
   */
  observeCycle(
    points: Array<{ routeKey: string; active: boolean }>,
    observedAtMs: number
  ): void {
    if (!Number.isFinite(observedAtMs) || observedAtMs < 0) return;
    const current = new Map<string, boolean>();
    for (const point of points) {
      current.set(point.routeKey, (current.get(point.routeKey) ?? false) || point.active);
    }
    for (const routeKey of this.histories.keys()) {
      if (!current.has(routeKey)) {
        this.observe({ routeKey, observedAtMs, active: false });
      }
    }
    for (const [routeKey, active] of current) {
      this.observe({ routeKey, observedAtMs, active });
    }
  }

  estimate(
    routeKey: string,
    nowMs: number,
    policy: SurvivalPolicy = DEFAULT_SURVIVAL_POLICY
  ): SurvivalEstimate {
    const history = this.histories.get(routeKey);
    if (!history || !Number.isFinite(nowMs) || nowMs < 0) {
      return emptyEstimate(routeKey, policy);
    }
    const continuousAgeMs =
      history.wasActive && history.activeSinceMs !== null
        ? Math.max(0, nowMs - history.activeSinceMs)
        : 0;
    const completed = history.completedLifetimesMs;
    const empiricalSurvival =
      completed.length > 0
        ? completed.filter((duration) => duration >= policy.decisionHorizonMs)
            .length / completed.length
        : null;
    const activeExposureMs =
      completed.reduce((sum, duration) => sum + duration, 0) + continuousAgeMs;
    const disappearanceRate =
      activeExposureMs > 0
        ? history.disappearances / (activeExposureMs / 1_000)
        : null;
    const evidenceFactor =
      empiricalSurvival ??
      clamp01(continuousAgeMs / Math.max(1, policy.decisionHorizonMs));
    const confidence = clamp01(
      history.observations / Math.max(1, policy.minimumObservations)
    );
    return {
      routeKey,
      firstSeenAtMs: history.firstSeenAtMs,
      lastSeenAtMs: history.lastSeenAtMs,
      continuousAgeMs,
      observations: history.observations,
      recurrenceCount: history.recurrences,
      disappearanceCount: history.disappearances,
      disappearanceRatePerSecond: disappearanceRate,
      empiricalSurvivalAtHorizon: empiricalSurvival,
      empiricalHalfLifeMs: median(completed),
      captureFactor: clamp01(
        policy.conservativePriorCaptureFactor * (1 - confidence) +
          evidenceFactor * confidence
      ),
      confidence,
      insufficientHistory:
        history.observations < policy.minimumObservations || completed.length === 0,
      provenance:
        completed.length > 0
          ? "EMPIRICAL_COMPLETED_LIFETIMES"
          : "RIGHT_CENSORED_ACTIVE_AGE_PROXY",
      policy
    };
  }
}

function emptyEstimate(
  routeKey: string,
  policy: SurvivalPolicy
): SurvivalEstimate {
  return {
    routeKey,
    firstSeenAtMs: null,
    lastSeenAtMs: null,
    continuousAgeMs: 0,
    observations: 0,
    recurrenceCount: 0,
    disappearanceCount: 0,
    disappearanceRatePerSecond: null,
    empiricalSurvivalAtHorizon: null,
    empiricalHalfLifeMs: null,
    captureFactor: policy.conservativePriorCaptureFactor,
    confidence: 0,
    insufficientHistory: true,
    provenance: "CONSERVATIVE_PRIOR_NO_HISTORY",
    policy
  };
}

/** Adapter for the lifecycle evidence already carried by ShadowOpportunity. */
export function estimateFromLifecycle(input: {
  routeKey: string;
  firstSeenAt: string;
  lastSeenAt: string;
  durationMs: number;
  observationCount: number;
  policy?: SurvivalPolicy;
}): SurvivalEstimate {
  const policy = input.policy ?? DEFAULT_SURVIVAL_POLICY;
  const durationMs =
    Number.isFinite(input.durationMs) && input.durationMs > 0
      ? input.durationMs
      : 0;
  const observations =
    Number.isSafeInteger(input.observationCount) && input.observationCount > 0
      ? input.observationCount
      : 0;
  const confidence = clamp01(
    observations / Math.max(1, policy.minimumObservations)
  );
  const observedSurvival = clamp01(
    durationMs / Math.max(1, policy.decisionHorizonMs)
  );
  return {
    routeKey: input.routeKey,
    firstSeenAtMs: Number.isFinite(Date.parse(input.firstSeenAt))
      ? Date.parse(input.firstSeenAt)
      : null,
    lastSeenAtMs: Number.isFinite(Date.parse(input.lastSeenAt))
      ? Date.parse(input.lastSeenAt)
      : null,
    continuousAgeMs: durationMs,
    observations,
    recurrenceCount: 0,
    disappearanceCount: 0,
    disappearanceRatePerSecond: null,
    empiricalSurvivalAtHorizon: null,
    empiricalHalfLifeMs: null,
    captureFactor: clamp01(
      policy.conservativePriorCaptureFactor * (1 - confidence) +
        observedSurvival * confidence
    ),
    confidence,
    insufficientHistory: observations < policy.minimumObservations,
    provenance: "LIFECYCLE_RIGHT_CENSORED_PROXY",
    policy
  };
}
