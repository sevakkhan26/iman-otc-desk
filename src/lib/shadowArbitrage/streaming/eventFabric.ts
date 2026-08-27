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
    | "invalid_book";
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
        latencySamples: 0
      });
    }
  }

  onReconnect(sourceId: ShadowSourceId): void {
    const state = this.requireState(sourceId);
    state.reconnectCount += 1;
    state.resyncCount += 1;
    state.synchronized = false;
    state.sequence = null;
    state.bids.clear();
    state.asks.clear();
  }

  ingest(event: NormalizedBookEvent): FabricIngestResult {
    const state = this.requireState(event.sourceId);
    if (
      !Number.isFinite(event.receiveTimestampMs) ||
      event.receiveTimestampMs < 0 ||
      (event.kind === "SNAPSHOT" && (!event.bids.length || !event.asks.length))
    ) {
      return this.result(state, false, "invalid_book");
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
        state.sequence = null;
        state.bids.clear();
        state.asks.clear();
        return this.result(state, false, "sequence_gap");
      }
    }

    if (event.kind === "SNAPSHOT") {
      replaceLevels(state.bids, event.bids);
      replaceLevels(state.asks, event.asks);
      state.synchronized = true;
    } else {
      applyDelta(state.bids, event.bids);
      applyDelta(state.asks, event.asks);
    }

    state.sequence = event.sequence;
    state.sourceEventTimestampMs = event.sourceEventTimestampMs;
    state.receiveTimestampMs = event.receiveTimestampMs;
    state.transport = event.transport;
    this.updateLatency(state, event);

    if (!state.bids.size || !state.asks.size) {
      state.synchronized = false;
      state.resyncCount += 1;
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
    if (event.sourceEventTimestampMs === null) return;
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
        latencyMs: state.latencyEstimateMs,
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
        reason === "invalid_book",
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
    | "cross_venue_time_skew";
  sourceSkewMs: number | null;
  eventToDecisionLatencyMs: number | null;
};

/** Both legs must be fresh, synchronized and inside one deterministic time window. */
export function assessCrossVenueCoherence(input: {
  buy: NormalizedSourceSnapshot | undefined;
  sell: NormalizedSourceSnapshot | undefined;
  decisionTimestampMs: number;
  maxAgeMs: number;
  maxSourceSkewMs: number;
}): CoherenceResult {
  const { buy, sell } = input;
  if (!buy || !sell) {
    return {
      coherent: false,
      reason: "missing_snapshot",
      sourceSkewMs: null,
      eventToDecisionLatencyMs: null
    };
  }
  if (
    buy.marketData?.snapshotResyncState === "AWAITING_SNAPSHOT" ||
    sell.marketData?.snapshotResyncState === "AWAITING_SNAPSHOT"
  ) {
    return {
      coherent: false,
      reason: "awaiting_resync",
      sourceSkewMs: null,
      eventToDecisionLatencyMs: null
    };
  }
  const buyEventMs = Date.parse(
    buy.marketData?.sourceEventTimestamp ?? buy.sourceTimestamp ?? buy.receivedAt
  );
  const sellEventMs = Date.parse(
    sell.marketData?.sourceEventTimestamp ?? sell.sourceTimestamp ?? sell.receivedAt
  );
  const buyReceiveMs = Date.parse(buy.marketData?.receiveTimestamp ?? buy.receivedAt);
  const sellReceiveMs = Date.parse(sell.marketData?.receiveTimestamp ?? sell.receivedAt);
  if (
    buy.stale ||
    sell.stale ||
    input.decisionTimestampMs - buyEventMs > input.maxAgeMs ||
    input.decisionTimestampMs - sellEventMs > input.maxAgeMs
  ) {
    return {
      coherent: false,
      reason: "stale_snapshot",
      sourceSkewMs: Math.abs(buyEventMs - sellEventMs),
      eventToDecisionLatencyMs: null
    };
  }
  const sourceSkewMs = Math.abs(buyEventMs - sellEventMs);
  if (sourceSkewMs > input.maxSourceSkewMs) {
    return {
      coherent: false,
      reason: "cross_venue_time_skew",
      sourceSkewMs,
      eventToDecisionLatencyMs: null
    };
  }
  return {
    coherent: true,
    reason: "coherent",
    sourceSkewMs,
    eventToDecisionLatencyMs: Math.max(
      0,
      input.decisionTimestampMs - Math.max(buyReceiveMs, sellReceiveMs)
    )
  };
}
