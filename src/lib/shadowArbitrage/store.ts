/**
 * Read/write helpers over the Shadow Arbitrage tables.
 *
 * The key/value store is used only for two bounded, overwritten caches (the
 * latest matrix for fast UI reads, and the latest certification records).
 * All time-series and 14-day analytics come from the dedicated tables — none of
 * it accumulates inside app_settings.
 */
import { pgGetKv, pgSetKv } from "@/db/repositories/kv";
import {
  countLifecycleEvents,
  countSnapshots,
  getObservation,
  loadActiveOpportunitiesDb,
  loadHistoryDb,
  loadLatestSourceSnapshots,
  loadRouteMetrics,
  loadRunStats,
  loadSourceStats
} from "@/db/repositories/shadowArbitrage";
import {
  SHADOW_RETENTION_DAYS,
  SHADOW_SOURCES,
  getSourceConfig
} from "@/lib/shadowArbitrage/config";
import { getCertification } from "@/lib/shadowArbitrage/certification";
import type {
  BlockedReasonCode,
  LifecycleAnalyticsRow,
  NormalizedSourceSnapshot,
  ShadowAnalytics,
  ShadowOpportunity,
  ShadowSourceId,
  SourcePerformanceRow
} from "@/lib/shadowArbitrage/types";
import { BLOCKED_REASON_FA } from "@/lib/shadowArbitrage/types";
import { round4 } from "@/lib/shadowArbitrage/money";

const KEY_LAST_MATRIX = "shadow_arb_last_matrix_v1";
const KEY_CERT = "shadow_arb_cert_v1";
const KEY_BLOCKED = "shadow_arb_blocked_counts_v1";

const RETENTION_MS = SHADOW_RETENTION_DAYS * 24 * 60 * 60_000;

export async function loadActiveOpportunities(): Promise<ShadowOpportunity[]> {
  return loadActiveOpportunitiesDb();
}

export async function loadHistory(limit = 1000): Promise<ShadowOpportunity[]> {
  return loadHistoryDb(limit);
}

/** Rehydrate a snapshot row into the in-memory shape the UI expects. */
function thinSnapshotFromDb(s: {
  sourceId: string;
  receivedAt: string;
  health: string;
  payload: Record<string, unknown>;
  errorReason: string | null;
  userBuy: number | null;
  userSell: number | null;
  certStatus: string | null;
  latencyMs: number | null;
  maxExecutableUsdt: number | null;
  stale: boolean;
}): NormalizedSourceSnapshot {
  const payload = s.payload ?? {};
  const meta = (payload.meta ?? null) as NormalizedSourceSnapshot["meta"] | null;
  const sourceId = s.sourceId as ShadowSourceId;
  let cfg: ReturnType<typeof getSourceConfig> | null = null;
  try {
    cfg = getSourceConfig(sourceId);
  } catch {
    cfg = null;
  }

  return {
    sourceId,
    sourceName: String(payload.sourceName ?? cfg?.nameFa ?? s.sourceId),
    marketModel:
      (payload.marketModel as NormalizedSourceSnapshot["marketModel"]) ??
      cfg?.marketModel ??
      "ORDER_BOOK",
    accountStatus:
      (payload.accountStatus as NormalizedSourceSnapshot["accountStatus"]) ??
      cfg?.accountStatus ??
      "unknown",
    eligibilityBase:
      (payload.eligibilityBase as NormalizedSourceSnapshot["eligibilityBase"]) ??
      cfg?.eligibilityBase ??
      "ACCOUNT_REQUIRED",
    bestBidToman: s.userSell,
    bestAskToman: s.userBuy,
    userBuyPriceToman: s.userBuy,
    userSellPriceToman: s.userSell,
    sizeExecutables:
      (payload.sizeExecutables as NormalizedSourceSnapshot["sizeExecutables"]) ?? [],
    depthUsdtBid: (payload.depthUsdtBid as number | null) ?? null,
    depthUsdtAsk: (payload.depthUsdtAsk as number | null) ?? null,
    maxExecutableUsdt: s.maxExecutableUsdt,
    marketFeeBps: (payload.feeBps as number | null) ?? cfg?.feeBps ?? null,
    feeStatus:
      (payload.feeStatus as NormalizedSourceSnapshot["feeStatus"]) ?? cfg?.feeStatus ?? "unknown",
    feeLabel: String(payload.feeLabel ?? cfg?.feeLabel ?? ""),
    feeReferenceUrl: cfg?.feeReferenceUrl ?? null,
    feeVerifiedAt: cfg?.feeVerifiedAt ?? null,
    sourceTimestamp: null,
    receivedAt: s.receivedAt,
    ageMs: Math.max(0, Date.now() - Date.parse(s.receivedAt)),
    health: s.health as NormalizedSourceSnapshot["health"],
    errorReason: s.errorReason,
    degradedReason: (payload.degradedReason as string | null) ?? null,
    stale: s.stale,
    meta:
      meta ?? {
        endpoint: null,
        httpStatus: null,
        latencyMs: s.latencyMs,
        attempts: 0,
        rateLimited: false,
        timedOut: false,
        depthAvailable: false,
        directionVerified: false,
        priceUnit: "ambiguous",
        normalizationNote: null
      },
    sourceBlockedReasons:
      (payload.sourceBlockedReasons as BlockedReasonCode[] | undefined) ?? []
  };
}

export async function loadLastMatrix(): Promise<{
  serverNow: string;
  sources: NormalizedSourceSnapshot[];
  opportunities: ShadowOpportunity[];
} | null> {
  const cached = await pgGetKv<{
    serverNow: string;
    sources: NormalizedSourceSnapshot[];
    opportunities: ShadowOpportunity[];
  }>(KEY_LAST_MATRIX);
  if (cached?.sources?.length) return cached;

  // Rebuild from the last persisted run if the cache is cold.
  const snaps = await loadLatestSourceSnapshots();
  if (!snaps.length) return null;
  const opps = await loadActiveOpportunities();
  const newest = snaps.reduce(
    (acc, s) => (Date.parse(s.receivedAt) > Date.parse(acc) ? s.receivedAt : acc),
    snaps[0]!.receivedAt
  );
  return {
    serverNow: newest,
    sources: snaps.map(thinSnapshotFromDb),
    opportunities: opps
  };
}

export async function saveLastMatrix(input: {
  serverNow: string;
  sources: NormalizedSourceSnapshot[];
  opportunities: ShadowOpportunity[];
}): Promise<void> {
  await pgSetKv(KEY_LAST_MATRIX, input, "shadow-collector");
}

export async function saveCertifications(certs: unknown): Promise<void> {
  await pgSetKv(KEY_CERT, { items: certs, updatedAt: new Date().toISOString() }, "shadow-cert");
}

export async function loadCertificationsStored(): Promise<unknown[] | null> {
  const d = await pgGetKv<{ items: unknown[] }>(KEY_CERT);
  return d?.items ?? null;
}

/**
 * Persist the fast-read caches for the UI.
 * Both keys are single overwritten rows — nothing accumulates here.
 */
export async function persistShadowCycle(input: {
  serverNow: string;
  sources: NormalizedSourceSnapshot[];
  opportunities: ShadowOpportunity[];
  blockedCounts?: Record<string, number>;
}): Promise<void> {
  const active = input.opportunities.filter((o) => o.isActive);
  await saveLastMatrix({
    serverNow: input.serverNow,
    sources: input.sources,
    opportunities: active
  });
  if (input.blockedCounts) {
    await pgSetKv(
      KEY_BLOCKED,
      { counts: input.blockedCounts, updatedAt: input.serverNow },
      "shadow-collector"
    );
  }
}

export async function loadLatestBlockedCounts(): Promise<Record<string, number>> {
  const d = await pgGetKv<{ counts: Record<string, number> }>(KEY_BLOCKED);
  return d?.counts ?? {};
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * 14-day analytics computed from the dedicated tables.
 *
 * Integrity rules applied here:
 *  - one row per unique lifecycle, never one per polling cycle;
 *  - a lifecycle whose fees are unverified is counted as raw potential and is
 *    never reported as expected net profit;
 *  - route rankings carry an explicit basis ("net" vs "raw_potential");
 *  - nothing is extrapolated: with too little data the payload says so.
 */
export async function computeAnalytics(windowMs = RETENTION_MS): Promise<ShadowAnalytics> {
  const [history, runStats, sourceStats, routeMetrics, snapshotCount, eventCount, observation, blocked] =
    await Promise.all([
      loadHistory(2000),
      loadRunStats(windowMs),
      loadSourceStats(windowMs),
      loadRouteMetrics(windowMs),
      countSnapshots(windowMs),
      countLifecycleEvents(windowMs),
      getObservation(),
      loadLatestBlockedCounts()
    ]);

  const lifecycles: LifecycleAnalyticsRow[] = history.map((o) => ({
    lifecycleId: o.id,
    routeKey: o.routeKey,
    buySourceId: o.buySourceId,
    sellSourceId: o.sellSourceId,
    sizeUsdt: o.sizeUsdt,
    rawEdgePercent: o.rawSpreadPercent,
    netEdgePercent: o.netEdgePercent,
    estimatedNetProfitToman: o.netProfitToman,
    maxRawSpreadPercent: o.maxRawSpreadPercent ?? o.rawSpreadPercent,
    maxNetEdgePercent: o.maxNetEdgePercent,
    firstSeenAt: o.firstSeenAt,
    lastSeenAt: o.lastSeenAt,
    durationMs: o.durationMs,
    observationCount: o.observationCount ?? 1,
    eligibility: o.eligibility,
    feeUnknown: o.feeUnknown || o.blockedReasons.includes("fee_unknown"),
    blockedReasons: o.blockedReasons
  }));

  const netPositive = lifecycles.filter(
    (o) => !o.feeUnknown && o.estimatedNetProfitToman > 0 && o.eligibility !== "BLOCKED"
  );
  const rawPotentialOnly = lifecycles.filter((o) => o.feeUnknown && o.maxRawSpreadPercent > 0);

  const durations = lifecycles.map((o) => o.durationMs).filter((d) => d > 0);
  const edges = netPositive.map((o) => o.maxNetEdgePercent);

  const pnlBySize: Record<string, number> = {};
  for (const o of netPositive) {
    const k = String(o.sizeUsdt);
    pnlBySize[k] = (pnlBySize[k] ?? 0) + o.estimatedNetProfitToman;
  }

  const lifecycleCountByRoute = new Map<string, number>();
  for (const o of lifecycles) {
    lifecycleCountByRoute.set(o.routeKey, (lifecycleCountByRoute.get(o.routeKey) ?? 0) + 1);
  }

  const routes = routeMetrics
    .map((r) => ({
      routeKey: r.routeKey,
      buySourceId: r.buySourceId,
      sellSourceId: r.sellSourceId,
      sizeUsdt: r.sizeUsdt,
      count: lifecycleCountByRoute.get(r.routeKey) ?? 0,
      samples: r.samples,
      medianEdge: r.avgNetEdgePercent !== null ? round4(r.avgNetEdgePercent) : null,
      maxEdge: r.maxNetEdgePercent !== null ? round4(r.maxNetEdgePercent) : null,
      maxRawSpread: r.maxRawSpreadPercent !== null ? round4(r.maxRawSpreadPercent) : null,
      avgRawSpread: r.avgRawSpreadPercent !== null ? round4(r.avgRawSpreadPercent) : null,
      feeUnknown: r.feeUnknown,
      rankingBasis: (r.feeUnknown ? "raw_potential" : "net") as "net" | "raw_potential"
    }))
    // Evidence-based ranking: observed maximum raw spread, then sample count.
    .sort((a, b) => (b.maxRawSpread ?? -Infinity) - (a.maxRawSpread ?? -Infinity) || b.samples - a.samples)
    .slice(0, 50);

  const sourceUptime: SourcePerformanceRow[] = SHADOW_SOURCES.map((cfg) => {
    const s = sourceStats.find((x) => x.sourceId === cfg.id);
    const cert = getCertification(cfg.id);
    const samples = s?.samples ?? 0;
    const healthy = s?.healthySamples ?? 0;
    const reachable = healthy + (s?.degradedSamples ?? 0);
    const errors = s?.errorSamples ?? 0;
    const stale = s?.staleSamples ?? 0;
    return {
      sourceId: cfg.id,
      sourceName: cfg.nameFa,
      certStatus: cert.status,
      samples,
      healthySamples: healthy,
      uptimePercent: samples ? Math.round((reachable / samples) * 10_000) / 100 : 0,
      errorRatePercent: samples ? Math.round((errors / samples) * 10_000) / 100 : 0,
      latencyP50Ms: s?.latencyP50Ms ?? null,
      latencyP95Ms: s?.latencyP95Ms ?? null,
      freshnessPercent: samples ? Math.round(((samples - stale) / samples) * 10_000) / 100 : 0,
      staleSamples: stale,
      lastErrorAt: s?.lastErrorAt ?? null,
      lastError: s?.lastError ?? null
    };
  });

  const attempted = sourceUptime.reduce((a, s) => a + s.samples, 0);
  const reached = sourceUptime.reduce(
    (a, s) => a + Math.round((s.uptimePercent / 100) * s.samples),
    0
  );
  const dataCoveragePercent = attempted ? Math.round((reached / attempted) * 10_000) / 100 : 0;

  const blockedByReason = Object.entries(blocked)
    .map(([reason, count]) => ({
      reason,
      label: BLOCKED_REASON_FA[reason as BlockedReasonCode] ?? reason,
      count
    }))
    .sort((a, b) => b.count - a.count);

  const insufficientData = runStats.runCount < 10 || lifecycles.length === 0;
  const dataNote = insufficientData
    ? `دادهٔ کافی برای تحلیل نیست (چرخه‌های ثبت‌شده: ${runStats.runCount}). هیچ پیش‌بینی یا برون‌یابی ارائه نمی‌شود.`
    : `بر پایهٔ ${runStats.runCount} چرخهٔ ثبت‌شده و ${snapshotCount} snapshot در ${SHADOW_RETENTION_DAYS} روز اخیر (${eventCount} رخداد چرخهٔ عمر). ارقام با کارمزد نامشخص «پتانسیل خام» هستند نه سود انتظاری.`;

  return {
    collectedFrom: runStats.firstRunAt,
    collectedTo: runStats.lastRunAt,
    windowDays: SHADOW_RETENTION_DAYS,
    runCount: runStats.runCount,
    successfulRuns: runStats.successfulRuns,
    partialRuns: runStats.partialRuns,
    failedRuns: runStats.failedRuns,
    snapshotCount,
    dataCoveragePercent,
    cycleCoveragePercent: observation?.cycleCoveragePercent ?? 0,
    uniqueLifecycles: lifecycles.length,
    uniqueActiveOpportunities: lifecycles.filter((o) => !o.blockedReasons.includes("market_data_missing"))
      .length,
    uniqueNetPositiveAllTime: new Set(netPositive.map((o) => o.routeKey)).size,
    uniqueRawPotentialOnly: new Set(rawPotentialOnly.map((o) => o.routeKey)).size,
    medianDurationMs: median(durations),
    maxDurationMs: durations.length ? Math.max(...durations) : null,
    medianNetEdgePercent: median(edges) !== null ? round4(median(edges)!) : null,
    maxNetEdgePercent: edges.length ? round4(Math.max(...edges)) : null,
    estimatedNetPnlBySize: pnlBySize,
    lifecycles: lifecycles
      .slice()
      .sort((a, b) => b.maxRawSpreadPercent - a.maxRawSpreadPercent)
      .slice(0, 200),
    routes,
    sourceUptime,
    blockedByReason,
    insufficientData,
    dataNote
  };
}

/** Latency percentiles per source, for the certification table. */
export async function getLatencyStats(
  windowMs = RETENTION_MS
): Promise<Record<string, { p50: number | null; p95: number | null; samples: number }>> {
  const stats = await loadSourceStats(windowMs);
  const out: Record<string, { p50: number | null; p95: number | null; samples: number }> = {};
  for (const s of stats) {
    out[s.sourceId] = { p50: s.latencyP50Ms, p95: s.latencyP95Ms, samples: s.samples };
  }
  return out;
}

export { loadSourceStats };
