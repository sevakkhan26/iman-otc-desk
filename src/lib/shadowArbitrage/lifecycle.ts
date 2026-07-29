import type { OpportunityEligibility, ShadowOpportunity } from "@/lib/shadowArbitrage/types";

export type LifecycleTransition = {
  lifecycleId: string;
  routeKey: string;
  occurredAt: string;
  eventType: "opened" | "eligibility_change" | "closed" | "reappeared";
  fromEligibility: OpportunityEligibility | null;
  toEligibility: OpportunityEligibility | null;
  netEdgePercent: number | null;
  netProfitToman: number | null;
  rawSpreadPercent: number | null;
  blockedReasons: string[];
};

/**
 * Merge this cycle's drafts with previously known lifecycles.
 *
 * A route that is still present keeps its id, firstSeenAt and running maxima —
 * one persistent opportunity stays ONE lifecycle instead of becoming a new row
 * every cycle. A route that disappears is closed (not deleted). A closed route
 * that comes back opens a fresh lifecycle so durations stay meaningful.
 */
export function mergeOpportunityLifecycle(
  previous: ShadowOpportunity[],
  draft: ShadowOpportunity[],
  nowIso: string
): ShadowOpportunity[] {
  return mergeWithTransitions(previous, draft, nowIso).merged;
}

export function mergeWithTransitions(
  previous: ShadowOpportunity[],
  draft: ShadowOpportunity[],
  nowIso: string
): { merged: ShadowOpportunity[]; transitions: LifecycleTransition[] } {
  const prevActive = previous.filter((p) => p.isActive);
  const prevByRoute = new Map(prevActive.map((p) => [p.routeKey, p]));
  const draftByRoute = new Map(draft.map((d) => [d.routeKey, d]));
  const closedByRoute = new Map(previous.filter((p) => !p.isActive).map((p) => [p.routeKey, p]));

  const merged: ShadowOpportunity[] = [];
  const transitions: LifecycleTransition[] = [];
  const nowMs = Date.parse(nowIso);

  for (const d of draft) {
    const prev = prevByRoute.get(d.routeKey);

    if (!prev) {
      const reappeared = closedByRoute.has(d.routeKey);
      merged.push({
        ...d,
        firstSeenAt: nowIso,
        lastSeenAt: nowIso,
        durationMs: 0,
        observationCount: 1
      });
      transitions.push({
        lifecycleId: d.id,
        routeKey: d.routeKey,
        occurredAt: nowIso,
        eventType: reappeared ? "reappeared" : "opened",
        fromEligibility: null,
        toEligibility: d.eligibility,
        netEdgePercent: d.netEdgePercent,
        netProfitToman: d.netProfitToman,
        rawSpreadPercent: d.rawSpreadPercent,
        blockedReasons: d.blockedReasons
      });
      continue;
    }

    const durationMs = Math.max(0, nowMs - Date.parse(prev.firstSeenAt));
    const next: ShadowOpportunity = {
      ...d,
      id: prev.id,
      firstSeenAt: prev.firstSeenAt,
      lastSeenAt: nowIso,
      endedAt: null,
      durationMs,
      maxNetEdgePercent: Math.max(prev.maxNetEdgePercent, d.netEdgePercent),
      maxNetProfitToman: Math.max(prev.maxNetProfitToman, d.netProfitToman),
      maxRawSpreadPercent: Math.max(
        prev.maxRawSpreadPercent ?? prev.rawSpreadPercent,
        d.rawSpreadPercent
      ),
      observationCount: (prev.observationCount ?? 1) + 1,
      isActive: true
    };
    merged.push(next);

    if (prev.eligibility !== d.eligibility) {
      transitions.push({
        lifecycleId: prev.id,
        routeKey: d.routeKey,
        occurredAt: nowIso,
        eventType: "eligibility_change",
        fromEligibility: prev.eligibility,
        toEligibility: d.eligibility,
        netEdgePercent: d.netEdgePercent,
        netProfitToman: d.netProfitToman,
        rawSpreadPercent: d.rawSpreadPercent,
        blockedReasons: d.blockedReasons
      });
    }
  }

  // Close routes that disappeared this cycle.
  for (const prev of prevActive) {
    if (draftByRoute.has(prev.routeKey)) continue;
    merged.push({
      ...prev,
      isActive: false,
      endedAt: nowIso,
      lastSeenAt: prev.lastSeenAt,
      durationMs: Math.max(0, Date.parse(prev.lastSeenAt) - Date.parse(prev.firstSeenAt))
    });
    transitions.push({
      lifecycleId: prev.id,
      routeKey: prev.routeKey,
      occurredAt: nowIso,
      eventType: "closed",
      fromEligibility: prev.eligibility,
      toEligibility: null,
      netEdgePercent: prev.netEdgePercent,
      netProfitToman: prev.netProfitToman,
      rawSpreadPercent: prev.rawSpreadPercent,
      blockedReasons: prev.blockedReasons
    });
  }

  // Carry already-closed history through untouched.
  for (const prev of previous) {
    if (prev.isActive) continue;
    if (merged.some((m) => m.id === prev.id)) continue;
    merged.push(prev);
  }

  return { merged, transitions };
}
