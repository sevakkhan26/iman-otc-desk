/**
 * Public market-data protocol adapters only. No account channels, credentials,
 * order methods or transfers are represented here.
 */
import { parseLevelsWithLoss } from "@/lib/shadowArbitrage/vwap";
import type { BookLevel, ShadowSourceId } from "@/lib/shadowArbitrage/types";
import type {
  NormalizedBookEvent,
  StreamSequencePolicy,
  VenueStreamPolicy
} from "@/lib/shadowArbitrage/streaming/eventFabric";

export type VenueStreamingCoverage = {
  sourceId: ShadowSourceId;
  mode: "WS_FIRST" | "REST_FALLBACK_ONLY";
  publicEndpoint: string | null;
  sequencePolicy: StreamSequencePolicy | null;
  reason: string;
};

export const VENUE_STREAMING_COVERAGE: VenueStreamingCoverage[] = [
  {
    sourceId: "nobitex",
    mode: "WS_FIRST",
    publicEndpoint: "wss://ws.nobitex.ir/connection/websocket",
    sequencePolicy: "MONOTONIC_VERSION",
    reason: "Official public Centrifugo full-book publications; offsets are monotonic versions, not delta sequence numbers."
  },
  {
    sourceId: "wallex",
    mode: "WS_FIRST",
    publicEndpoint: "wss://api.wallex.ir/ws",
    sequencePolicy: "MONOTONIC_VERSION",
    reason: "Official public buyDepth/sellDepth channels; adapter emits paired full snapshots."
  },
  {
    sourceId: "tabdeal",
    mode: "WS_FIRST",
    publicEndpoint: "wss://api1.tabdeal.org/stream/",
    sequencePolicy: "FULL_SNAPSHOT_NO_SEQUENCE",
    reason: "Official public usdtirt@depth@2000ms full-depth topic; no exchange sequence documented."
  },
  {
    sourceId: "bitpin",
    mode: "REST_FALLBACK_ONLY",
    publicEndpoint: null,
    sequencePolicy: null,
    reason: "No documented public orderbook WebSocket."
  },
  {
    sourceId: "abantether",
    mode: "REST_FALLBACK_ONLY",
    publicEndpoint: null,
    sequencePolicy: null,
    reason: "OTC quote source; no walkable public orderbook stream."
  },
  {
    sourceId: "ramzinex",
    mode: "REST_FALLBACK_ONLY",
    publicEndpoint: null,
    sequencePolicy: null,
    reason: "No verified public sequence-safe orderbook stream."
  },
  {
    sourceId: "tetherland",
    mode: "REST_FALLBACK_ONLY",
    publicEndpoint: null,
    sequencePolicy: null,
    reason: "No verified public sequence-safe orderbook stream."
  },
  {
    sourceId: "bit24",
    mode: "REST_FALLBACK_ONLY",
    publicEndpoint: null,
    sequencePolicy: null,
    reason: "No documented public orderbook WebSocket."
  },
  {
    sourceId: "arzinja",
    mode: "REST_FALLBACK_ONLY",
    publicEndpoint: null,
    sequencePolicy: null,
    reason: "No verified public sequence-safe orderbook stream."
  }
];

export const STREAM_POLICIES: VenueStreamPolicy[] = VENUE_STREAMING_COVERAGE
  .filter(
    (
      row
    ): row is VenueStreamingCoverage & {
      mode: "WS_FIRST";
      sequencePolicy: StreamSequencePolicy;
    } => row.mode === "WS_FIRST" && row.sequencePolicy !== null
  )
  .map((row) => ({
    sourceId: row.sourceId,
    sequencePolicy: row.sequencePolicy
  }));

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseNobitexPublication(
  message: unknown,
  receiveTimestampMs: number
): NormalizedBookEvent | null {
  if (!Number.isFinite(receiveTimestampMs) || receiveTimestampMs < 0) return null;
  const root = record(message);
  const push = record(root?.push);
  const publication = record(push?.pub);
  if (push?.channel !== "public:orderbook-USDTIRT" || !publication) return null;
  let data: unknown = publication.data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return null;
    }
  }
  const payload = record(data);
  if (!payload) return null;
  const bids = parseLevelsWithLoss(
    Array.isArray(payload.bids) ? payload.bids : [],
    "rial"
  ).levels;
  const asks = parseLevelsWithLoss(
    Array.isArray(payload.asks) ? payload.asks : [],
    "rial"
  ).levels;
  if (!bids.length || !asks.length) return null;
  const sequence = finiteNumber(publication.offset);
  const sourceEventTimestampMs = finiteNumber(payload.lastUpdate);
  if (
    sequence === null ||
    !Number.isSafeInteger(sequence) ||
    sequence < 0 ||
    sourceEventTimestampMs === null ||
    sourceEventTimestampMs < 0
  ) {
    return null;
  }
  return {
    sourceId: "nobitex",
    kind: "SNAPSHOT",
    sequence,
    sourceEventTimestampMs,
    receiveTimestampMs,
    bids,
    asks,
    transport: "WS",
    endpoint: "wss://ws.nobitex.ir/connection/websocket"
  };
}

export function parseTabdealDepth(
  message: unknown,
  receiveTimestampMs: number
): NormalizedBookEvent | null {
  if (!Number.isFinite(receiveTimestampMs) || receiveTimestampMs < 0) return null;
  const root = record(message);
  const payload = record(root?.data) ?? root;
  if (!payload) return null;
  const symbol = String(payload.s ?? payload.symbol ?? "").toUpperCase();
  const eventType = String(payload.e ?? payload.eventType ?? "");
  if (symbol !== "USDTIRT" || (eventType && eventType !== "depthUpdate")) return null;
  const bids = parseLevelsWithLoss(
    Array.isArray(payload.b) ? payload.b : [],
    "toman"
  ).levels;
  const asks = parseLevelsWithLoss(
    Array.isArray(payload.a) ? payload.a : [],
    "toman"
  ).levels;
  if (!bids.length || !asks.length) return null;
  const sourceEventTimestampMs = finiteNumber(payload.E);
  // Tabdeal documents no sequence/version. A finite exchange event timestamp is
  // therefore mandatory and becomes the fail-closed ordering watermark.
  if (sourceEventTimestampMs === null || sourceEventTimestampMs < 0) return null;
  return {
    sourceId: "tabdeal",
    kind: "SNAPSHOT",
    sequence: null,
    sourceEventTimestampMs,
    receiveTimestampMs,
    bids,
    asks,
    transport: "WS",
    endpoint: "wss://api1.tabdeal.org/stream/"
  };
}

function wallexLevels(value: unknown): BookLevel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((row) => {
    const item = record(row);
    const priceToman = finiteNumber(item?.price);
    const amountUsdt = finiteNumber(item?.quantity);
    return priceToman !== null &&
      amountUsdt !== null &&
      priceToman > 0 &&
      amountUsdt > 0
      ? [{ priceToman, amountUsdt }]
      : [];
  });
}

/**
 * Wallex publishes each side independently and no exchange sequence is
 * documented. Never emit a mixed book: both sides must have arrived inside the
 * configured pairing window, otherwise the adapter requests REST recovery.
 */
export class WallexDepthAssembler {
  private bids: { levels: BookLevel[]; receivedAt: number } | null = null;
  private asks: { levels: BookLevel[]; receivedAt: number } | null = null;
  private version = 0;

  constructor(
    private readonly maxPairSkewMs: number,
    private readonly requestRestRecovery: (reason: string) => void = () => undefined
  ) {}

  /**
   * Socket close/open and explicit session boundaries invalidate both sides.
   * The monotonic local publication counter intentionally survives so a new
   * coherent pair cannot look older than a pair emitted before reconnect.
   */
  reset(): void {
    this.bids = null;
    this.asks = null;
  }

  ingest(message: unknown, receiveTimestampMs: number): NormalizedBookEvent | null {
    if (!Number.isFinite(receiveTimestampMs) || receiveTimestampMs < 0) {
      this.reset();
      this.requestRestRecovery("wallex_invalid_receive_timestamp");
      return null;
    }
    if (!Array.isArray(message) || message.length < 2) return null;
    const channel = String(message[0]);
    const levels = wallexLevels(message[1]);
    if (!levels.length) return null;
    if (channel === "USDTTMN@buyDepth") {
      this.bids = { levels, receivedAt: receiveTimestampMs };
    } else if (channel === "USDTTMN@sellDepth") {
      this.asks = { levels, receivedAt: receiveTimestampMs };
    } else {
      return null;
    }
    if (!this.bids || !this.asks) return null;
    if (Math.abs(this.bids.receivedAt - this.asks.receivedAt) > this.maxPairSkewMs) {
      // Do not leave either unmatched side available for a later publication:
      // that would make the next pair's session/time provenance ambiguous.
      this.reset();
      this.requestRestRecovery("wallex_side_pair_skew");
      return null;
    }
    const bids = this.bids;
    const asks = this.asks;
    this.reset();
    this.version += 1;
    return {
      sourceId: "wallex",
      kind: "SNAPSHOT",
      sequence: this.version,
      // Wallex does not provide a side event timestamp. Local receive time is
      // the explicit coherence proxy, rather than mixing it with null silently.
      sourceEventTimestampMs: Math.max(bids.receivedAt, asks.receivedAt),
      receiveTimestampMs: Math.max(bids.receivedAt, asks.receivedAt),
      bids: bids.levels,
      asks: asks.levels,
      transport: "WS",
      endpoint: "wss://api.wallex.ir/ws"
    };
  }
}

export const PUBLIC_SUBSCRIPTIONS = {
  nobitex: {
    connect: { id: 1, connect: {} },
    subscribe: { id: 2, subscribe: { channel: "public:orderbook-USDTIRT" } }
  },
  wallex: [
    ["subscribe", { channel: "USDTTMN@buyDepth" }],
    ["subscribe", { channel: "USDTTMN@sellDepth" }]
  ],
  tabdeal: {
    method: "SUBSCRIBE",
    params: ["usdtirt@depth@2000ms"],
    id: 1
  }
} as const;
