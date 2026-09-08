/**
 * Paper-only, venue-normalized market-data state machine.
 *
 * Network clients stay in isolated venue adapters. This module consumes their
 * normalized events, enforces sequence/resync rules, and emits the existing
 * NormalizedSourceSnapshot shape used by discovery and the Paper engine.
 */
import {
  getSourceConfig,
  SHADOW_STALE_MS,
  SHADOW_TRADE_SIZES
} from "@/lib/shadowArbitrage/config";
import { executableVwap, sumDepth } from "@/lib/shadowArbitrage/vwap";
import type {
  BookLevel,
  MarketDataTelemetry,
  MarketDataTransport,
  NormalizedSourceSnapshot,
  ShadowSourceId
} from "@/lib/shadowArbitrage/types";

export type StreamSequencePolicy =
  | "STRICT_INCREMENT"
  | "MONOTONIC_VERSION"
  | "FULL_SNAPSHOT_NO_SEQUENCE";

export type NormalizedBookEvent = {
  sourceId: ShadowSourceId;
  kind: "SNAPSHOT" | "DELTA";
  sequence: number | null;
  sourceEventTimestampMs: number | null;
  receiveTimestampMs: number;
  bids: BookLevel[];
  asks: BookLevel[];
  transport: MarketDataTransport;
  endpoint: string;
};

export type VenueStreamPolicy = {
  sourceId: ShadowSourceId;
  sequencePolicy: StreamSequencePolicy;
};

type VenueState = {
  policy: VenueStreamPolicy;
  bids: Map<number, number>;
  asks: Map<number, number>;
  synchronized: boolean;
  sequence: number | null;
  sourceEventTimestampMs: number | null;
  receiveTimestampMs: number | null;
  transport: MarketDataTransport;
  reconnectCount: number;
  gapCount: number;
  outOfOrderCount: number;
  resyncCount: number;
  latencyEstimateMs: number | null;
  jitterMs: number | null;
  latencySamples: number;
  resyncProvenance: string | null;
};

export type FabricIngestResult = {
  accepted: boolean;
  decisionReady: boolean;
  resyncRequested: boolean;
  reason:
    | "accepted"
    | "awaiting_snapshot"
    | "sequence_gap"
    | "out_of_order"
    | "invalid_book"
    | "invalid_timestamp";
  snapshot: NormalizedSourceSnapshot | null;
};

function orderedLevels(levels: Map<number, number>, side: "bid" | "ask"): BookLevel[] {
  return [...levels]
    .filter(([price, amount]) => price > 0 && amount > 0)
    .sort(([a], [b]) => (side === "bid" ? b - a : a - b))
    .map(([priceToman, amountUsdt]) => ({ priceToman, amountUsdt }));
}

function replaceLevels(target: Map<number, number>, levels: BookLevel[]): void {
  target.clear();
  for (const level of levels) {
    if (level.priceToman > 0 && level.amountUsdt > 0) {
      target.set(level.priceToman, level.amountUsdt);
    }
  }
}

function applyDelta(target: Map<number, number>, levels: BookLevel[]): void {
  for (const level of levels) {
    if (!(level.priceToman > 0) || !Number.isFinite(level.amountUsdt)) continue;
    if (level.amountUsdt <= 0) target.delete(level.priceToman);
    else target.set(level.priceToman, level.amountUsdt);
  }
}

export class PaperMarketDataFabric {
  private readonly states = new Map<ShadowSourceId, VenueState>();

  constructor(policies: VenueStreamPolicy[]) {
    for (const policy of policies) {
      this.states.set(policy.sourceId, {
        policy,
        bids: new Map(),
        asks: new Map(),
        synchronized: false,
        sequence: null,
        sourceEventTimestampMs: null,
        receiveTimestampMs: null,
        transport: "REST_BOOTSTRAP",
        reconnectCount: 0,
        gapCount: 0,
        outOfOrderCount: 0,
        resyncCount: 0,
        latencyEstimateMs: null,
        jitterMs: null,
        latencySamples: 0,
        resyncProvenance: null
      });
    }
  }

  onReconnect(sourceId: ShadowSourceId): void {
    const state = this.requireState(sourceId);
    state.reconnectCount += 1;
    state.resyncCount += 1;
    state.synchronized = false;
    // Keep the last exchange/local version as a high-water mark. A REST
    // recovery may replace the book, but it must not make delayed WS versions
    // look new merely by silently erasing sequence provenance.
    state.resyncProvenance = "SOCKET_SESSION_BOUNDARY_VERSION_WATERMARK_PRESERVED";
    state.bids.clear();
    state.asks.clear();
  }

  requestResync(sourceId: ShadowSourceId, provenance: string): void {
    const state = this.requireState(sourceId);
    state.resyncCount += 1;
    state.synchronized = false;
    state.resyncProvenance = provenance;
    state.bids.clear();
    state.asks.clear();
  }

  ingest(event: NormalizedBookEvent): FabricIngestResult {
    const state = this.requireState(event.sourceId);
    const invalidTimestamp =
      !Number.isFinite(event.receiveTimestampMs) ||
      event.receiveTimestampMs < 0 ||
      event.sourceEventTimestampMs === null ||
      !Number.isFinite(event.sourceEventTimestampMs) ||
      event.sourceEventTimestampMs < 0;
    if (
      invalidTimestamp ||
      (event.transport === "WS" &&
        state.policy.sequencePolicy !== "FULL_SNAPSHOT_NO_SEQUENCE" &&
        (event.sequence === null ||
          !Number.isSafeInteger(event.sequence) ||
          event.sequence < 0)) ||
      (event.kind === "SNAPSHOT" && (!event.bids.length || !event.asks.length))
    ) {
      this.requestResync(
        event.sourceId,
        invalidTimestamp
          ? "INVALID_TIMESTAMP_REST_RECOVERY_REQUIRED"
          : "INVALID_BOOK_REST_RECOVERY_REQUIRED"
      );
      return this.result(
        state,
        false,
        invalidTimestamp
          ? "invalid_timestamp"
          : "invalid_book"
      );
    }

    if (event.kind === "DELTA" && !state.synchronized) {
      return this.result(state, false, "awaiting_snapshot");
    }

    if (state.sequence !== null && event.sequence !== null) {
      if (event.sequence <= state.sequence) {
        state.outOfOrderCount += 1;
        return this.result(state, false, "out_of_order");
      }
      if (
        event.kind === "DELTA" &&
        state.policy.sequencePolicy === "STRICT_INCREMENT" &&
        event.sequence !== state.sequence + 1
      ) {
        state.gapCount += 1;
        state.resyncCount += 1;
        state.synchronized = false;
        state.resyncProvenance =
          "STRICT_DELTA_GAP_VERSION_WATERMARK_PRESERVED_REST_RECOVERY_REQUIRED";
        state.bids.clear();
        state.asks.clear();
        return this.result(state, false, "sequence_gap");
      }
    }
    if (
      (state.policy.sequencePolicy === "FULL_SNAPSHOT_NO_SEQUENCE" ||
        event.sequence === null) &&
      state.sourceEventTimestampMs !== null &&
      event.sourceEventTimestampMs !== null &&
      event.sourceEventTimestampMs <= state.sourceEventTimestampMs
    ) {
      state.outOfOrderCount += 1;
      return this.result(state, false, "out_of_order");
    }

    if (event.kind === "SNAPSHOT") {
      replaceLevels(state.bids, event.bids);
      replaceLevels(state.asks, event.asks);
      state.synchronized = true;
    } else {
      applyDelta(state.bids, event.bids);
      applyDelta(state.asks, event.asks);
    }

    // A sequence-less REST snapshot replaces the book but preserves any
    // meaningful WS version watermark. The next WS publication must still be
    // newer. This is the explicit reset policy for fallback/resync.
    if (event.sequence !== null) {
      state.sequence = event.sequence;
    }
    state.sourceEventTimestampMs = event.sourceEventTimestampMs;
    state.receiveTimestampMs = event.receiveTimestampMs;
    state.transport = event.transport;
    if (event.transport !== "WS") {
      state.resyncProvenance =
        state.sequence === null
          ? `${event.transport}_NO_PRIOR_VERSION_WATERMARK`
          : `${event.transport}_BOOK_REPLACED_VERSION_WATERMARK_PRESERVED`;
    } else if (state.resyncProvenance !== null) {
      state.resyncProvenance = "WS_FULL_SNAPSHOT_RESYNCHRONIZED";
    }
    this.updateLatency(state, event);

    if (!state.bids.size || !state.asks.size) {
      state.synchronized = false;
      state.resyncCount += 1;
      state.resyncProvenance = "EMPTY_BOOK_REST_RECOVERY_REQUIRED";
      return this.result(state, false, "invalid_book");
    }
    return this.result(state, true, "accepted", event.endpoint);
  }

  snapshot(sourceId: ShadowSourceId, endpoint = "event-fabric"): NormalizedSourceSnapshot | null {
    const state = this.requireState(sourceId);
    return state.synchronized ? this.buildSnapshot(state, endpoint) : null;
  }

  telemetry(sourceId: ShadowSourceId, nowMs?: number): MarketDataTelemetry {
    const state = this.requireState(sourceId);
    return this.telemetryFor(state, nowMs ?? state.receiveTimestampMs ?? 0);
  }

  private requireState(sourceId: ShadowSourceId): VenueState {
    const state = this.states.get(sourceId);
    if (!state) throw new Error(`missing stream policy for ${sourceId}`);
    return state;
  }

  private updateLatency(state: VenueState, event: NormalizedBookEvent): void {
    if (
      event.sourceEventTimestampMs === null ||
      !Number.isFinite(event.sourceEventTimestampMs)
    ) return;
    const sample = Math.max(0, event.receiveTimestampMs - event.sourceEventTimestampMs);
    const previous = state.latencyEstimateMs;
    state.latencySamples += 1;
    state.latencyEstimateMs =
      previous === null
        ? sample
        : previous + (sample - previous) / state.latencySamples;
    if (previous !== null) {
      const jitterSample = Math.abs(sample - previous);
      const priorJitter = state.jitterMs ?? 0;
      state.jitterMs =
        priorJitter + (jitterSample - priorJitter) / Math.max(1, state.latencySamples - 1);
    }
  }

  private telemetryFor(state: VenueState, nowMs: number): MarketDataTelemetry {
    const eventMs = state.sourceEventTimestampMs ?? state.receiveTimestampMs ?? nowMs;
    return {
      transport: state.transport,
      sequence: state.sequence,
      sourceEventTimestamp:
        state.sourceEventTimestampMs === null
          ? null
          : new Date(state.sourceEventTimestampMs).toISOString(),
      receiveTimestamp: new Date(state.receiveTimestampMs ?? nowMs).toISOString(),
      sourceEventAgeMs: Math.max(0, nowMs - eventMs),
      latencyEstimateMs: state.latencyEstimateMs,
      jitterMs: state.jitterMs,
      reconnectCount: state.reconnectCount,
      gapCount: state.gapCount,
      outOfOrderCount: state.outOfOrderCount,
      resyncCount: state.resyncCount,
      resyncProvenance: state.resyncProvenance,
      snapshotResyncState: state.synchronized ? "SYNCHRONIZED" : "AWAITING_SNAPSHOT"
    };
  }

  private buildSnapshot(state: VenueState, endpoint: string): NormalizedSourceSnapshot {
    const bids = orderedLevels(state.bids, "bid");
    const asks = orderedLevels(state.asks, "ask");
    const receivedAt = new Date(state.receiveTimestampMs ?? 0).toISOString();
    const cfg = getSourceConfig(state.policy.sourceId);
    const sourceTimestamp =
      state.sourceEventTimestampMs === null
        ? null
        : new Date(state.sourceEventTimestampMs).toISOString();
    const eventMs = state.sourceEventTimestampMs ?? state.receiveTimestampMs ?? 0;
    const ageMs = Math.max(0, (state.receiveTimestampMs ?? 0) - eventMs);
    const stale = ageMs > SHADOW_STALE_MS;
    const bestBidToman = bids[0]?.priceToman ?? null;
    const bestAskToman = asks[0]?.priceToman ?? null;
    const sizeExecutables = SHADOW_TRADE_SIZES.map((sizeUsdt) => {
      const buy = executableVwap(asks, sizeUsdt, "buy");
      const sell = executableVwap(bids, sizeUsdt, "sell");
      return {
        sizeUsdt,
        userBuyVwapToman: buy.fillable ? buy.vwapToman : null,
        userSellVwapToman: sell.fillable ? sell.vwapToman : null,
        buyFillable: buy.fillable,
        sellFillable: sell.fillable,
        buyFilledUsdt: buy.filledUsdt,
        sellFilledUsdt: sell.filledUsdt
      };
    });
    const snapshot: NormalizedSourceSnapshot = {
      sourceId: cfg.id,
      sourceName: cfg.nameFa,
      marketModel: cfg.marketModel,
      accountStatus: cfg.accountStatus,
      eligibilityBase: cfg.eligibilityBase,
      bestBidToman,
      bestAskToman,
      userBuyPriceToman: bestAskToman,
      userSellPriceToman: bestBidToman,
      sizeExecutables,
      bookBids: bids.slice(0, 60),
      bookAsks: asks.slice(0, 60),
      depthUsdtBid: sumDepth(bids),
      depthUsdtAsk: sumDepth(asks),
      maxExecutableUsdt: Math.min(sumDepth(bids), sumDepth(asks)),
      marketFeeBps: cfg.feeBps,
      feeStatus: cfg.feeStatus,
      feeLabel: cfg.feeLabel,
      feeReferenceUrl: cfg.feeReferenceUrl,
      feeVerifiedAt: cfg.feeVerifiedAt,
      sourceTimestamp,
      receivedAt,
      ageMs,
      health: stale ? "degraded" : "healthy",
      errorReason: null,
      degradedReason: stale ? "event-fabric snapshot is stale" : null,
      stale,
      meta: {
        endpoint,
        httpStatus: null,
        // INTEGER column shadow_source_snapshots.latency_ms — EMA estimate is float.
        latencyMs:
          state.latencyEstimateMs == null || !Number.isFinite(state.latencyEstimateMs)
            ? null
            : Math.round(state.latencyEstimateMs),
        attempts: 1,
        rateLimited: false,
        timedOut: false,
        depthAvailable: true,
        directionVerified: true,
        priceUnit: "IRT",
        normalizationNote: `event fabric; ${state.transport}; ${state.policy.sequencePolicy}`
      },
      sourceBlockedReasons: stale ? ["snapshot_resync"] : []
    };
    return {
      ...snapshot,
      marketData: this.telemetryFor(state, state.receiveTimestampMs ?? 0)
    };
  }

  private result(
    state: VenueState,
    accepted: boolean,
    reason: FabricIngestResult["reason"],
    endpoint?: string
  ): FabricIngestResult {
    const snapshot =
      accepted && state.synchronized
        ? this.buildSnapshot(state, endpoint ?? "event-fabric")
        : null;
    return {
      accepted,
      decisionReady: accepted && state.synchronized,
      resyncRequested:
        reason === "sequence_gap" ||
        reason === "awaiting_snapshot" ||
        reason === "invalid_book" ||
        reason === "invalid_timestamp",
      reason,
      snapshot
    };
  }
}

export type CoherenceResult = {
  coherent: boolean;
  reason:
    | "coherent"
    | "missing_snapshot"
    | "stale_snapshot"
    | "awaiting_resync"
    | "invalid_timestamp"
    | "cross_venue_time_skew";
  /**
   * Comparable-clock skew used by the hard gate: |buyReceive − sellReceive|.
   * Receive timestamps share the local collector clock; venue server clocks do not.
   */
  sourceSkewMs: number | null;
  /**
   * Raw |buySourceEvent − sellSourceEvent| for diagnostics only. Never the gate —
   * exchanges' clocks are not synchronized with each other or with the desk.
   */
  venueClockSkewMs: number | null;
  eventToDecisionLatencyMs: number | null;
  sourceEventLatencyMs: number | null;
  receiveAgeMs: number | null;
};

function emptyCoherence(
  reason: CoherenceResult["reason"]
): CoherenceResult {
  return {
    coherent: false,
    reason,
    sourceSkewMs: null,
    venueClockSkewMs: null,
    eventToDecisionLatencyMs: null,
    sourceEventLatencyMs: null,
    receiveAgeMs: null
  };
}

/**
 * Both legs must be fresh on the local receive clock and observed inside one
 * deterministic receive-time window. Venue `sourceEventTimestamp` values are
 * NEVER compared across exchanges — unsynchronized server clocks produced
 * TASK-008 false negatives (e.g. tabdeal→ramzinex lifecycle 527f37cb…).
 * The 2500ms max skew budget itself is unchanged; only the compared clocks are.
 */
export function assessCrossVenueCoherence(input: {
  buy: NormalizedSourceSnapshot | undefined;
  sell: NormalizedSourceSnapshot | undefined;
  decisionTimestampMs: number;
  maxAgeMs: number;
  maxSourceSkewMs: number;
}): CoherenceResult {
  const { buy, sell } = input;
  if (!buy || !sell) {
    return emptyCoherence("missing_snapshot");
  }
  if (
    buy.marketData?.snapshotResyncState === "AWAITING_SNAPSHOT" ||
    sell.marketData?.snapshotResyncState === "AWAITING_SNAPSHOT"
  ) {
    return emptyCoherence("awaiting_resync");
  }
  // Venue-local event times (diagnostic / per-leg latency only).
  const buyEventMs = Date.parse(
    buy.marketData?.sourceEventTimestamp ?? buy.sourceTimestamp ?? ""
  );
  const sellEventMs = Date.parse(
    sell.marketData?.sourceEventTimestamp ?? sell.sourceTimestamp ?? ""
  );
  // Comparable local clock for cross-venue gates.
  const buyReceiveMs = Date.parse(buy.marketData?.receiveTimestamp ?? buy.receivedAt);
  const sellReceiveMs = Date.parse(sell.marketData?.receiveTimestamp ?? sell.receivedAt);
  if (
    !Number.isFinite(input.decisionTimestampMs) ||
    !Number.isFinite(input.maxAgeMs) ||
    !Number.isFinite(input.maxSourceSkewMs) ||
    !Number.isFinite(buyReceiveMs) ||
    !Number.isFinite(sellReceiveMs)
  ) {
    return emptyCoherence("invalid_timestamp");
  }
  const venueClockSkewMs =
    Number.isFinite(buyEventMs) && Number.isFinite(sellEventMs)
      ? Math.abs(buyEventMs - sellEventMs)
      : null;
  const receiveSkewMs = Math.abs(buyReceiveMs - sellReceiveMs);
  const buyReceiveAgeMs = Math.max(0, input.decisionTimestampMs - buyReceiveMs);
  const sellReceiveAgeMs = Math.max(0, input.decisionTimestampMs - sellReceiveMs);
  if (
    buy.stale ||
    sell.stale ||
    buyReceiveAgeMs > input.maxAgeMs ||
    sellReceiveAgeMs > input.maxAgeMs
  ) {
    return {
      coherent: false,
      reason: "stale_snapshot",
      sourceSkewMs: receiveSkewMs,
      venueClockSkewMs,
      eventToDecisionLatencyMs: null,
      sourceEventLatencyMs: null,
      receiveAgeMs: Math.max(buyReceiveAgeMs, sellReceiveAgeMs)
    };
  }
  // Hard gate: books must have been received within maxSourceSkewMs of each other
  // on the local clock — not that two venue servers agree on wall time.
  if (receiveSkewMs > input.maxSourceSkewMs) {
    return {
      coherent: false,
      reason: "cross_venue_time_skew",
      sourceSkewMs: receiveSkewMs,
      venueClockSkewMs,
      eventToDecisionLatencyMs: null,
      sourceEventLatencyMs: null,
      receiveAgeMs: Math.max(buyReceiveAgeMs, sellReceiveAgeMs)
    };
  }
  const sourceEventLatencyMs = Math.max(
    0,
    Number.isFinite(buyEventMs) ? buyReceiveMs - buyEventMs : 0,
    Number.isFinite(sellEventMs) ? sellReceiveMs - sellEventMs : 0
  );
  return {
    coherent: true,
    reason: "coherent",
    sourceSkewMs: receiveSkewMs,
    venueClockSkewMs,
    eventToDecisionLatencyMs: Math.max(
      0,
      input.decisionTimestampMs - Math.max(buyReceiveMs, sellReceiveMs)
    ),
    sourceEventLatencyMs,
    receiveAgeMs: Math.max(buyReceiveAgeMs, sellReceiveAgeMs)
  };
}
