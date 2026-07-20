/**
 * Canonical server-side market snapshot.
 * All authenticated clients must consume this (via API) — never call providers from the browser.
 * Import only from server/API paths (not Client Components).
 */

import {
  getInflightRefresh,
  pgWithTetherRefreshLock,
  readMarketSnapshot,
  setInflightRefresh,
  writeMarketSnapshot,
  type MarketSnapshotRecord
} from "@/lib/marketSnapshotStore";
import {
  clearDomesticQuotesCache,
  getDomesticProviderHealth,
  getDomesticQuotes
} from "@/lib/providers/domestic";
import { calculateTetherMarket } from "@/lib/market";
import { recordMedian } from "@/lib/history";
import { getSettings } from "@/lib/settings";
import { ttlFromMinutes } from "@/lib/providerCache";
import type {
  DashboardResponse,
  DeskSettings,
  DomesticProviderHealth,
  SourceStatus,
  TetherMarketResponse
} from "@/lib/types";

export type AuthoritativeTimeMeta = {
  /** UTC ISO — wall clock of the server at response construction. */
  serverNow: string;
  /** UTC ISO — when the underlying market payload was generated. */
  generatedAt: string;
  /** True when serving a snapshot older than the configured refresh interval. */
  isStale: boolean;
  lastSuccessfulRefreshAt: string | null;
  lastAttemptedRefreshAt: string | null;
  refreshIntervalMs: number;
};

export type TetherMarketSnapshotResponse = TetherMarketResponse & AuthoritativeTimeMeta;

function settingsKey(settings: DeskSettings): string {
  const enabled = Object.entries(settings.enabledSources ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}:${v === false ? 0 : 1}`)
    .join("|");
  return `${settings.priceRefreshMinutes}|${settings.outlierThresholdPercent}|${enabled}`;
}

function withProviders(
  market: TetherMarketResponse,
  health: DomesticProviderHealth[],
  serverNowMs: number
): { market: TetherMarketResponse; providers: DomesticProviderHealth[] } {
  const providers = health.map((h) => {
    const q = market.exchanges.find((e) => e.exchangeId === h.id);
    const lastSuccessMs = h.lastSuccessAt ? Date.parse(h.lastSuccessAt) : NaN;
    const staleAgeMs =
      Number.isFinite(lastSuccessMs) && (q || h.midPrice !== null || h.buyPrice !== null)
        ? Math.max(0, serverNowMs - lastSuccessMs)
        : h.staleAgeMs;

    if (!q) {
      return { ...h, staleAgeMs };
    }

    const referenceOnly =
      q.sourceStatus !== "unavailable" &&
      q.midPrice !== null &&
      Number.isFinite(q.midPrice) &&
      q.midPrice > 0 &&
      (q.buyPrice === null || !Number.isFinite(q.buyPrice)) &&
      (q.sellPrice === null || !Number.isFinite(q.sellPrice));

    const status: SourceStatus =
      q.sourceStatus === "unavailable"
        ? "unavailable"
        : q.sourceStatus === "degraded" || referenceOnly
          ? "degraded"
          : q.sourceStatus;

    const next: DomesticProviderHealth = {
      ...h,
      status,
      buyPrice: q.buyPrice,
      sellPrice: q.sellPrice,
      midPrice: q.midPrice,
      error: q.errorMessage ?? h.error,
      staleAgeMs
    };
    return next;
  });

  return {
    market: { ...market, providers },
    providers
  };
}

function recomputeStaleAges(
  providers: DomesticProviderHealth[],
  serverNowMs: number
): DomesticProviderHealth[] {
  return providers.map((h) => {
    const lastSuccessMs = h.lastSuccessAt ? Date.parse(h.lastSuccessAt) : NaN;
    const staleAgeMs = Number.isFinite(lastSuccessMs)
      ? Math.max(0, serverNowMs - lastSuccessMs)
      : h.staleAgeMs;
    return { ...h, staleAgeMs };
  });
}

function attachMeta(
  market: TetherMarketResponse,
  record: MarketSnapshotRecord,
  serverNowMs: number
): TetherMarketSnapshotResponse {
  const ageMs = serverNowMs - Date.parse(record.generatedAt);
  const isStale = !Number.isFinite(ageMs) || ageMs > record.refreshIntervalMs;
  const providers = recomputeStaleAges(record.providers, serverNowMs);
  return {
    ...market,
    providers,
    serverNow: new Date(serverNowMs).toISOString(),
    generatedAt: record.generatedAt,
    isStale,
    lastSuccessfulRefreshAt: record.lastSuccessfulRefreshAt,
    lastAttemptedRefreshAt: record.lastAttemptedRefreshAt,
    refreshIntervalMs: record.refreshIntervalMs
  };
}

async function buildFreshRecord(settings: DeskSettings): Promise<MarketSnapshotRecord> {
  const attemptedAt = new Date().toISOString();
  const refreshIntervalMs = ttlFromMinutes(settings.priceRefreshMinutes);
  try {
    // Snapshot owns refresh cadence — bypass process-local list cache for this fetch.
    clearDomesticQuotesCache();
    const quotes = await getDomesticQuotes(settings);
    const market = calculateTetherMarket(quotes, settings.outlierThresholdPercent);
    market.settings.marketSpreadAlertThresholdPercent = settings.marketSpreadAlertThresholdPercent;
    void recordMedian(market.summary.median).catch(() => {});

    const health = getDomesticProviderHealth();
    const nowMs = Date.now();
    const { market: withHealth, providers } = withProviders(market, health, nowMs);
    const usable = quotes.some(
      (q) =>
        q.sourceStatus !== "unavailable" &&
        (q.midPrice !== null || q.buyPrice !== null || q.sellPrice !== null)
    );
    const generatedAt = new Date(nowMs).toISOString();
    return {
      version: 1,
      generatedAt,
      lastSuccessfulRefreshAt: usable ? generatedAt : null,
      lastAttemptedRefreshAt: attemptedAt,
      settingsKey: settingsKey(settings),
      refreshIntervalMs,
      tetherMarket: withHealth,
      providers,
      quotes
    };
  } catch {
    // Preserve previous snapshot if refresh completely fails
    const previous = await readMarketSnapshot();
    if (previous) {
      return {
        ...previous,
        lastAttemptedRefreshAt: attemptedAt
      };
    }
    const empty = calculateTetherMarket([], settings.outlierThresholdPercent);
    empty.settings.marketSpreadAlertThresholdPercent = settings.marketSpreadAlertThresholdPercent;
    const nowIso = new Date().toISOString();
    return {
      version: 1,
      generatedAt: nowIso,
      lastSuccessfulRefreshAt: null,
      lastAttemptedRefreshAt: attemptedAt,
      settingsKey: settingsKey(settings),
      refreshIntervalMs,
      tetherMarket: empty,
      providers: [],
      quotes: []
    };
  }
}

async function refreshAndStore(settings: DeskSettings): Promise<MarketSnapshotRecord> {
  const existingInflight = getInflightRefresh();
  if (existingInflight) return existingInflight;

  const work = (async () => {
    // PostgreSQL advisory lock: only one process refreshes; others serve last snapshot.
    const lockResult = await pgWithTetherRefreshLock(async () => {
      const current = await readMarketSnapshot();
      const now = Date.now();
      if (
        current &&
        current.settingsKey === settingsKey(settings) &&
        now - Date.parse(current.generatedAt) < current.refreshIntervalMs
      ) {
        return current;
      }
      const record = await buildFreshRecord(settings);
      if (
        record.lastSuccessfulRefreshAt === null &&
        current?.lastSuccessfulRefreshAt &&
        current.quotes.length
      ) {
        const merged: MarketSnapshotRecord = {
          ...current,
          lastAttemptedRefreshAt: record.lastAttemptedRefreshAt
        };
        await writeMarketSnapshot(merged);
        return merged;
      }
      await writeMarketSnapshot(record);
      return record;
    });

    if (!lockResult.acquired) {
      // Another process holds the refresh lock — serve last committed snapshot
      await new Promise((r) => setTimeout(r, 400));
      const shared = await readMarketSnapshot();
      if (shared) return shared;
      // No snapshot yet; wait a bit more and retry read
      await new Promise((r) => setTimeout(r, 800));
      const again = await readMarketSnapshot();
      if (again) return again;
      // Absolute last resort: build without lock (rare race on empty DB)
      const record = await buildFreshRecord(settings);
      await writeMarketSnapshot(record);
      return record;
    }

    return lockResult.result!;
  })();

  setInflightRefresh(work);
  try {
    return await work;
  } finally {
    setInflightRefresh(null);
  }
}

/**
 * Serve the canonical tether market snapshot.
 * Uses persistent store + refresh interval; single-flight across concurrent requests.
 */
export async function getTetherMarketSnapshot(): Promise<TetherMarketSnapshotResponse> {
  const settings = await getSettings();
  const key = settingsKey(settings);
  const nowMs = Date.now();
  let record = await readMarketSnapshot();

  const needsRefresh =
    !record ||
    record.settingsKey !== key ||
    !Number.isFinite(Date.parse(record.generatedAt)) ||
    nowMs - Date.parse(record.generatedAt) >= record.refreshIntervalMs;

  if (needsRefresh) {
    record = await refreshAndStore(settings);
  }

  if (!record) {
    // Absolute fallback — should be rare (empty store + failed lock/refresh)
    record = await buildFreshRecord(settings);
    await writeMarketSnapshot(record);
  }

  return attachMeta(record.tetherMarket, record, Date.now());
}

/** Force a refresh (manual client Refresh / diagnostics). Still server-side only. */
export async function forceRefreshTetherMarketSnapshot(): Promise<TetherMarketSnapshotResponse> {
  const settings = await getSettings();
  const record = await refreshAndStore(settings);
  return attachMeta(record.tetherMarket, record, Date.now());
}

export function attachServerTimeMeta<T extends object>(
  payload: T,
  extras?: Partial<AuthoritativeTimeMeta>
): T & AuthoritativeTimeMeta {
  const serverNow = new Date().toISOString();
  return {
    ...payload,
    serverNow,
    generatedAt: extras?.generatedAt ?? serverNow,
    isStale: extras?.isStale ?? false,
    lastSuccessfulRefreshAt: extras?.lastSuccessfulRefreshAt ?? null,
    lastAttemptedRefreshAt: extras?.lastAttemptedRefreshAt ?? null,
    refreshIntervalMs: extras?.refreshIntervalMs ?? 0
  };
}

/** Attach snapshot meta onto a dashboard payload that already includes tetherMarket. */
export function mergeDashboardWithTetherSnapshot(
  dashboard: DashboardResponse,
  tether: TetherMarketSnapshotResponse
): DashboardResponse & AuthoritativeTimeMeta {
  return {
    ...dashboard,
    tetherMarket: {
      ...tether,
      // keep snapshot meta on tetherMarket as well for nested consumers
      providers: tether.providers
    },
    serverNow: tether.serverNow,
    generatedAt: tether.generatedAt,
    isStale: tether.isStale,
    lastSuccessfulRefreshAt: tether.lastSuccessfulRefreshAt,
    lastAttemptedRefreshAt: tether.lastAttemptedRefreshAt,
    refreshIntervalMs: tether.refreshIntervalMs
  };
}
