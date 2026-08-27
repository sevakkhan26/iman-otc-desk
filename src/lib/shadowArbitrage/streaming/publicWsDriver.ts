/**
 * Public order-book WebSocket lifecycle for Paper mode.
 *
 * No private channel, authentication header, order command or transfer command
 * exists here. Environments without a standards-compatible WebSocket retain
 * the collector's explicit REST fallback.
 */
import {
  ingestPublicStreamMessage,
  markPublicStreamReconnect
} from "@/lib/shadowArbitrage/streaming/runtime";
import {
  PUBLIC_SUBSCRIPTIONS,
  VENUE_STREAMING_COVERAGE
} from "@/lib/shadowArbitrage/streaming/venueAdapters";

type StreamSourceId = "nobitex" | "wallex" | "tabdeal";

export type PublicWebSocketPolicy = {
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  provenance: string;
};

export const DEFAULT_PUBLIC_WEBSOCKET_POLICY: PublicWebSocketPolicy = {
  reconnectBaseMs: 1_000,
  reconnectMaxMs: 30_000,
  provenance: "PAPER_PUBLIC_MARKET_DATA_V1:deterministic exponential reconnect"
};

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(
    type: "open" | "message" | "close" | "error",
    listener: (event: { data?: unknown }) => void
  ): void;
};

export type PublicWebSocketFactory = (
  endpoint: string
) => WebSocketLike;

export type PublicStreamDriver = {
  started: boolean;
  stop(): void;
};

const WS_COVERAGE = VENUE_STREAMING_COVERAGE.filter(
  (
    row
  ): row is (typeof VENUE_STREAMING_COVERAGE)[number] & {
    sourceId: StreamSourceId;
    publicEndpoint: string;
    mode: "WS_FIRST";
  } =>
    row.mode === "WS_FIRST" &&
    row.publicEndpoint !== null &&
    (row.sourceId === "nobitex" ||
      row.sourceId === "wallex" ||
      row.sourceId === "tabdeal")
);

function decodeMessage(data: unknown): unknown {
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }
  if (data instanceof ArrayBuffer) {
    try {
      return JSON.parse(new TextDecoder().decode(data));
    } catch {
      return null;
    }
  }
  return data;
}

export function startPublicPaperWebSockets(input?: {
  factory?: PublicWebSocketFactory;
  policy?: PublicWebSocketPolicy;
  onError?: (sourceId: StreamSourceId, error: unknown) => void;
}): PublicStreamDriver {
  const NativeWebSocket = globalThis.WebSocket;
  const factory =
    input?.factory ??
    (NativeWebSocket
      ? ((endpoint: string) =>
          new NativeWebSocket(endpoint) as unknown as WebSocketLike)
      : null);
  if (!factory) return { started: false, stop: () => undefined };

  const policy = input?.policy ?? DEFAULT_PUBLIC_WEBSOCKET_POLICY;
  const sockets = new Map<StreamSourceId, WebSocketLike>();
  const timers = new Map<StreamSourceId, ReturnType<typeof setTimeout>>();
  const attempts = new Map<StreamSourceId, number>();
  let stopped = false;

  const subscribe = (
    sourceId: StreamSourceId,
    socket: WebSocketLike,
    connected = false
  ) => {
    if (sourceId === "nobitex") {
      socket.send(
        JSON.stringify(
          connected
            ? PUBLIC_SUBSCRIPTIONS.nobitex.subscribe
            : PUBLIC_SUBSCRIPTIONS.nobitex.connect
        )
      );
      return;
    }
    if (sourceId === "wallex") {
      for (const frame of PUBLIC_SUBSCRIPTIONS.wallex) {
        socket.send(JSON.stringify(frame));
      }
      return;
    }
    socket.send(JSON.stringify(PUBLIC_SUBSCRIPTIONS.tabdeal));
  };

  const connect = (sourceId: StreamSourceId, endpoint: string) => {
    if (stopped) return;
    let socket: WebSocketLike;
    try {
      socket = factory(endpoint);
    } catch (error) {
      input?.onError?.(sourceId, error);
      scheduleReconnect(sourceId, endpoint);
      return;
    }
    sockets.set(sourceId, socket);
    socket.addEventListener("open", () => {
      attempts.set(sourceId, 0);
      subscribe(sourceId, socket);
    });
    socket.addEventListener("message", (event) => {
      const message = decodeMessage(event.data);
      if (message === null) return;
      if (
        sourceId === "nobitex" &&
        typeof message === "object" &&
        message !== null &&
        "id" in message &&
        (message as { id?: unknown }).id === 1
      ) {
        subscribe(sourceId, socket, true);
      }
      ingestPublicStreamMessage({
        sourceId,
        message,
        receivedAtMs: Date.now()
      });
    });
    socket.addEventListener("error", (error) => {
      input?.onError?.(sourceId, error);
    });
    socket.addEventListener("close", () => {
      sockets.delete(sourceId);
      if (!stopped) {
        markPublicStreamReconnect(sourceId);
        scheduleReconnect(sourceId, endpoint);
      }
    });
  };

  function scheduleReconnect(
    sourceId: StreamSourceId,
    endpoint: string
  ): void {
    if (stopped || timers.has(sourceId)) return;
    const attempt = (attempts.get(sourceId) ?? 0) + 1;
    attempts.set(sourceId, attempt);
    const delay = Math.min(
      policy.reconnectMaxMs,
      policy.reconnectBaseMs * 2 ** Math.max(0, attempt - 1)
    );
    const timer = setTimeout(() => {
      timers.delete(sourceId);
      connect(sourceId, endpoint);
    }, delay);
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    timers.set(sourceId, timer);
  }

  for (const coverage of WS_COVERAGE) {
    connect(coverage.sourceId, coverage.publicEndpoint);
  }

  return {
    started: true,
    stop() {
      stopped = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      for (const socket of sockets.values()) socket.close();
      sockets.clear();
    }
  };
}
