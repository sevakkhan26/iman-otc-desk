/**
 * In-process Paper stream cache. Socket ownership may live in a worker, while
 * collector and replay fixtures share this deterministic ingestion seam.
 */
import { SHADOW_STALE_MS } from "@/lib/shadowArbitrage/config";
import {
  PaperMarketDataFabric,
  type FabricIngestResult
} from "@/lib/shadowArbitrage/streaming/eventFabric";
import {
  STREAM_POLICIES,
  WallexDepthAssembler,
  parseNobitexPublication,
  parseTabdealDepth
} from "@/lib/shadowArbitrage/streaming/venueAdapters";
import type {
  MarketDataTelemetry,
  NormalizedSourceSnapshot,
  ShadowSourceId
} from "@/lib/shadowArbitrage/types";

const fabric = new PaperMarketDataFabric(STREAM_POLICIES);
const recoverySubscribers = new Set<
  (sourceId: "nobitex" | "wallex" | "tabdeal", reason: string) => void
>();
function requestRestRecovery(
  sourceId: "nobitex" | "wallex" | "tabdeal",
  reason: string
): void {
  fabric.requestResync(sourceId, `${reason.toUpperCase()}_REST_RECOVERY_REQUIRED`);
  for (const subscriber of recoverySubscribers) subscriber(sourceId, reason);
}
const wallex = new WallexDepthAssembler(2_500, (reason) =>
  requestRestRecovery("wallex", reason)
);
const endpoints = new Map<ShadowSourceId, string>();
const decisionSubscribers = new Set<
  (snapshot: NormalizedSourceSnapshot, receivedAtMs: number) => void
>();

/** Event-driven Paper decision hook; subscribers never receive unsynchronized books. */
export function subscribePaperMarketDecisions(
  subscriber: (snapshot: NormalizedSourceSnapshot, receivedAtMs: number) => void
): () => void {
  decisionSubscribers.add(subscriber);
  return () => decisionSubscribers.delete(subscriber);
}

/** Wake the regular REST collection path when stream continuity cannot prove a book. */
export function subscribePaperRestRecoveryRequests(
  subscriber: (
    sourceId: "nobitex" | "wallex" | "tabdeal",
    reason: string
  ) => void
): () => void {
  recoverySubscribers.add(subscriber);
  return () => recoverySubscribers.delete(subscriber);
}

export function ingestPublicStreamMessage(input: {
  sourceId: "nobitex" | "wallex" | "tabdeal";
  message: unknown;
  receivedAtMs: number;
}): FabricIngestResult | null {
  const event =
    input.sourceId === "nobitex"
      ? parseNobitexPublication(input.message, input.receivedAtMs)
      : input.sourceId === "tabdeal"
        ? parseTabdealDepth(input.message, input.receivedAtMs)
        : wallex.ingest(input.message, input.receivedAtMs);
  if (!event) return null;
  endpoints.set(input.sourceId, event.endpoint);
  const result = fabric.ingest(event);
  if (result.decisionReady && result.snapshot) {
    for (const subscriber of decisionSubscribers) {
      subscriber(result.snapshot, input.receivedAtMs);
    }
  }
  return result;
}

export function markPublicStreamReconnect(
  sourceId: "nobitex" | "wallex" | "tabdeal"
): void {
  if (sourceId === "wallex") wallex.reset();
  fabric.onReconnect(sourceId);
  for (const subscriber of recoverySubscribers) {
    subscriber(sourceId, "socket_session_boundary");
  }
}

export function registerRestStreamRecovery(
  snapshot: NormalizedSourceSnapshot,
  transport: "REST_BOOTSTRAP" | "REST_RECOVERY" | "REST_FALLBACK"
): NormalizedSourceSnapshot {
  const receiveTimestampMs = Date.parse(snapshot.receivedAt);
  const parsedSourceTimestampMs = snapshot.sourceTimestamp
    ? Date.parse(snapshot.sourceTimestamp)
    : receiveTimestampMs;
  if (
    !Number.isFinite(receiveTimestampMs) ||
    !Number.isFinite(parsedSourceTimestampMs)
  ) {
    const streamPolicy = STREAM_POLICIES.some(
      (policy) => policy.sourceId === snapshot.sourceId
    );
    if (streamPolicy) {
      requestRestRecovery(snapshot.sourceId as "nobitex" | "wallex" | "tabdeal", "invalid_rest_timestamp");
    }
    return {
      ...snapshot,
      stale: true,
      health: "degraded",
      degradedReason: "invalid REST recovery timestamp",
      marketData: {
        transport,
        sequence: null,
        sourceEventTimestamp: null,
        receiveTimestamp: snapshot.receivedAt,
        sourceEventAgeMs: Number.POSITIVE_INFINITY,
        latencyEstimateMs: null,
        jitterMs: null,
        reconnectCount: 0,
        gapCount: 0,
        outOfOrderCount: 0,
        resyncCount: 1,
        resyncProvenance: "INVALID_REST_TIMESTAMP_RECOVERY_REQUIRED",
        snapshotResyncState: "AWAITING_SNAPSHOT"
      }
    };
  }
  if (
    !STREAM_POLICIES.some((policy) => policy.sourceId === snapshot.sourceId) ||
    !snapshot.bookBids?.length ||
    !snapshot.bookAsks?.length
  ) {
    return {
      ...snapshot,
      marketData: {
        transport,
        sequence: null,
        sourceEventTimestamp: snapshot.sourceTimestamp,
        receiveTimestamp: snapshot.receivedAt,
        sourceEventAgeMs: snapshot.ageMs,
        latencyEstimateMs: snapshot.meta.latencyMs,
        jitterMs: null,
        reconnectCount: 0,
        gapCount: 0,
        outOfOrderCount: 0,
        resyncCount: 0,
        resyncProvenance: `${transport}_NON_STREAM_VENUE`,
        snapshotResyncState: "SYNCHRONIZED"
      }
    };
  }
  const result = fabric.ingest({
    sourceId: snapshot.sourceId,
    kind: "SNAPSHOT",
    sequence: null,
    sourceEventTimestampMs: parsedSourceTimestampMs,
    receiveTimestampMs,
    bids: snapshot.bookBids,
    asks: snapshot.bookAsks,
    transport,
    endpoint: snapshot.meta.endpoint ?? "rest-recovery"
  });
  return {
    ...snapshot,
    marketData:
      result.snapshot?.marketData ??
      fabric.telemetry(snapshot.sourceId, Date.parse(snapshot.receivedAt))
  };
}

export function latestPaperStreamSnapshot(
  sourceId: ShadowSourceId,
  nowMs: number
): NormalizedSourceSnapshot | null {
  if (!STREAM_POLICIES.some((policy) => policy.sourceId === sourceId)) return null;
  const snapshot = fabric.snapshot(sourceId, endpoints.get(sourceId));
  if (!snapshot) return null;
  const eventMs = Date.parse(
    snapshot.marketData?.sourceEventTimestamp ??
      snapshot.sourceTimestamp ??
      snapshot.receivedAt
  );
  if (!Number.isFinite(nowMs) || !Number.isFinite(eventMs)) return null;
  const ageMs = Math.max(0, nowMs - eventMs);
  if (ageMs > SHADOW_STALE_MS) return null;
  return {
    ...snapshot,
    ageMs,
    stale: false,
    marketData: snapshot.marketData
      ? { ...snapshot.marketData, sourceEventAgeMs: ageMs }
      : undefined
  };
}

export function paperStreamTelemetry(
  sourceId: ShadowSourceId,
  nowMs: number
): MarketDataTelemetry | null {
  if (!STREAM_POLICIES.some((policy) => policy.sourceId === sourceId)) return null;
  return fabric.telemetry(sourceId, nowMs);
}
