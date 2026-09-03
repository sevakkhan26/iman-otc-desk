import {
  getSourceConfig,
  SHADOW_SOURCES,
  SHADOW_STALE_MS,
  type ShadowSourceConfig
} from "@/lib/shadowArbitrage/config";
import type { NormalizedSourceSnapshot, ShadowSourceId } from "@/lib/shadowArbitrage/types";
import {
  ShadowSourceError,
  snapshotFromResult,
  unavailableSnapshot,
  type AdapterResult
} from "@/lib/shadowArbitrage/adapters/base";
import { fetchNobitexBook } from "@/lib/shadowArbitrage/adapters/nobitex";
import { fetchWallexBook } from "@/lib/shadowArbitrage/adapters/wallex";
import { fetchTabdealBook } from "@/lib/shadowArbitrage/adapters/tabdeal";
import { fetchBitpinBook } from "@/lib/shadowArbitrage/adapters/bitpin";
import { fetchAbanTetherQuote } from "@/lib/shadowArbitrage/adapters/abantether";
import { fetchRamzinexBook } from "@/lib/shadowArbitrage/adapters/ramzinex";
import { fetchTetherlandBook } from "@/lib/shadowArbitrage/adapters/tetherland";
import { fetchBit24Book } from "@/lib/shadowArbitrage/adapters/bit24";
import { fetchArzinjaReference } from "@/lib/shadowArbitrage/adapters/arzinja";
import {
  latestPaperStreamSnapshot,
  paperStreamTelemetry,
  registerRestStreamRecovery
} from "@/lib/shadowArbitrage/streaming/runtime";
import { VENUE_STREAMING_COVERAGE } from "@/lib/shadowArbitrage/streaming/venueAdapters";

type Fetcher = (cfg: ShadowSourceConfig) => Promise<AdapterResult>;

const FETCHERS: Record<ShadowSourceId, Fetcher> = {
  nobitex: fetchNobitexBook,
  wallex: fetchWallexBook,
  tabdeal: fetchTabdealBook,
  bitpin: fetchBitpinBook,
  abantether: fetchAbanTetherQuote,
  ramzinex: fetchRamzinexBook,
  tetherland: fetchTetherlandBook,
  bit24: fetchBit24Book,
  arzinja: fetchArzinjaReference
};
const lastRegularSnapshot = new Map<ShadowSourceId, NormalizedSourceSnapshot>();

/** Deviation from the cross-source median that trips a unit/outlier flag. */
const CROSS_CHECK_TOLERANCE = 0.08;

function refreshedCachedSnapshot(
  snapshot: NormalizedSourceSnapshot,
  nowMs: number
): NormalizedSourceSnapshot | null {
  // Age against the local receive clock — venue sourceEvent clocks are not
  // comparable to Date.now() and must not alone expire a fresh receipt.
  const receiveMs = Date.parse(
    snapshot.marketData?.receiveTimestamp ?? snapshot.receivedAt
  );
  if (!Number.isFinite(nowMs) || !Number.isFinite(receiveMs)) return null;
  const ageMs = Math.max(0, nowMs - receiveMs);
  if (ageMs > SHADOW_STALE_MS) return null;
  const sourceEventMs = Date.parse(
    snapshot.marketData?.sourceEventTimestamp ?? snapshot.sourceTimestamp ?? ""
  );
  const sourceEventAgeMs = Number.isFinite(sourceEventMs)
    ? Math.max(0, nowMs - sourceEventMs)
    : ageMs;
  return {
    ...snapshot,
    ageMs,
    stale: false,
    marketData: snapshot.marketData
      ? { ...snapshot.marketData, sourceEventAgeMs }
      : undefined
  };
}

async function runOne(
  id: ShadowSourceId,
  eventDriven: boolean
): Promise<NormalizedSourceSnapshot> {
  const cfg = getSourceConfig(id);
  const receivedAt = new Date().toISOString();
  if (!cfg.enabled) {
    return unavailableSnapshot(cfg, receivedAt, "منبع در تنظیمات غیرفعال است");
  }
  const streamed = latestPaperStreamSnapshot(id, Date.parse(receivedAt));
  if (streamed) return streamed;
  if (eventDriven) {
    const cached = lastRegularSnapshot.get(id);
    const refreshed = cached
      ? refreshedCachedSnapshot(cached, Date.parse(receivedAt))
      : null;
    return (
      refreshed ??
      unavailableSnapshot(
        cfg,
        receivedAt,
        "event-driven cycle has no coherently fresh cached snapshot"
      )
    );
  }

  try {
    const result = await FETCHERS[id](cfg);
    /*
     * No per-venue clamp lives here any more.
     *
     * Arzinja used to be forced to REFERENCE_ONLY on every cycle regardless of
     * how the probe went, which meant no amount of evidence could ever change
     * its standing. Its endpoint is now documented public, its direction is
     * proved per cycle and its book is walked like any other, so the venue is
     * judged by the same checks as the rest: certification decides, not a
     * hard-coded exception.
     */
    const snapshot = snapshotFromResult(cfg, result, receivedAt);
    const coverage = VENUE_STREAMING_COVERAGE.find((row) => row.sourceId === id);
    const priorStream = paperStreamTelemetry(id, Date.parse(receivedAt));
    const transport =
      coverage?.mode !== "WS_FIRST"
        ? "REST_FALLBACK"
        : priorStream &&
            (priorStream.gapCount > 0 ||
              priorStream.reconnectCount > 0 ||
              priorStream.resyncCount > 0)
          ? "REST_RECOVERY"
          : "REST_BOOTSTRAP";
    return registerRestStreamRecovery(snapshot, transport);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (error instanceof ShadowSourceError) {
      return unavailableSnapshot(cfg, receivedAt, msg, {
        endpoint: error.endpoint,
        httpStatus: error.httpStatus,
        latencyMs: error.latencyMs,
        attempts: error.attempts,
        rateLimited: error.rateLimited,
        timedOut: error.timedOut
      });
    }
    return unavailableSnapshot(cfg, receivedAt, msg);
  }
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * Cross-source sanity pass.
 * A source whose mid sits far from the cross-venue median is far more likely to
 * be a unit or field-mapping error than a real 8%+ dislocation, so it is
 * degraded and flagged instead of feeding the opportunity engine.
 */
export function crossCheckUnits(sources: NormalizedSourceSnapshot[]): NormalizedSourceSnapshot[] {
  const mids: number[] = [];
  for (const s of sources) {
    if (s.health === "unavailable") continue;
    if (s.userBuyPriceToman == null || s.userSellPriceToman == null) continue;
    mids.push((s.userBuyPriceToman + s.userSellPriceToman) / 2);
  }
  const ref = median(mids);
  if (ref === null || mids.length < 3) return sources;

  return sources.map((s) => {
    if (s.health === "unavailable") return s;
    if (s.userBuyPriceToman == null || s.userSellPriceToman == null) return s;
    const mid = (s.userBuyPriceToman + s.userSellPriceToman) / 2;
    const deviation = Math.abs(mid - ref) / ref;
    if (deviation <= CROSS_CHECK_TOLERANCE) return s;
    const note = `انحراف ${(deviation * 100).toFixed(2)}٪ از میانهٔ منابع (${Math.round(ref)}) — واحد/نگاشت مشکوک`;
    return {
      ...s,
      health: "degraded" as const,
      degradedReason: s.degradedReason ? `${s.degradedReason} · ${note}` : note,
      sourceBlockedReasons: [...new Set([...s.sourceBlockedReasons, "units_ambiguous" as const])],
      meta: { ...s.meta, priceUnit: "ambiguous" as const }
    };
  });
}

/**
 * Fetch all configured shadow sources concurrently.
 * Failures are isolated per source: one dead venue cannot abort the cycle.
 */
export async function collectAllShadowSources(input?: {
  eventDriven?: boolean;
}): Promise<NormalizedSourceSnapshot[]> {
  const settled = await Promise.allSettled(
    SHADOW_SOURCES.map((s) => runOne(s.id, Boolean(input?.eventDriven)))
  );
  const results = settled.map((outcome, i) => {
    const cfg = SHADOW_SOURCES[i]!;
    if (outcome.status === "fulfilled") return outcome.value;
    const reason = outcome.reason;
    return unavailableSnapshot(
      cfg,
      new Date().toISOString(),
      reason instanceof Error ? reason.message : String(reason)
    );
  });
  const checked = crossCheckUnits(results);
  if (!input?.eventDriven) {
    for (const snapshot of checked) {
      if (snapshot.health !== "unavailable") {
        lastRegularSnapshot.set(snapshot.sourceId, snapshot);
      }
    }
  }
  return checked;
}
