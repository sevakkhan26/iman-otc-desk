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
import { defaultSettings, getSettings } from "@/lib/settings";
import { ttlFromMinutes } from "@/lib/providerCache";
import type {
  DashboardResponse,
  DeskSettings,
  DomesticProviderHealth,
  DomesticQuote,
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

async function buildFreshRecord(
  settings: DeskSettings,
  options?: { bypassListCache?: boolean }
): Promise<MarketSnapshotRecord> {
  const attemptedAt = new Date().toISOString();
  const refreshIntervalMs = ttlFromMinutes(settings.priceRefreshMinutes);
  try {
    // Default: reuse process-local provider cache (fast). Manual force may bypass.
    if (options?.bypassListCache) {
      clearDomesticQuotesCache();
    }
    // Hard cap so multi-LP fan-out cannot block HTTP for 30–60s
    const fetchBudgetMs = Math.max(
      4_000,
      Number(process.env.TETHER_REFRESH_BUDGET_MS ?? 8_000) || 8_000
    );
    const quotesOrTimeout = await Promise.race([
      getDomesticQuotes(settings).then((q) => q as DomesticQuote[] | "timeout"),
      new Promise<"timeout">((resolve) => {
        setTimeout(() => resolve("timeout"), fetchBudgetMs);
      })
    ]);
    if (quotesOrTimeout === "timeout") {
      const previous = await readMarketSnapshot().catch(() => null);
      if (previous) {
        return { ...previous, lastAttemptedRefreshAt: attemptedAt };
      }
      // No prior snapshot — return empty quickly rather than hang
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
        providers: getDomesticProviderHealth(),
        quotes: []
      };
    }
    const quotes = quotesOrTimeout;
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
 * Stale-while-revalidate: if we have any prior snapshot, return it immediately and
 * refresh in the background. First paint never waits on 12s multi-LP fan-out.
 */
export async function getTetherMarketSnapshot(): Promise<TetherMarketSnapshotResponse> {
  let settings: DeskSettings;
  try {
    settings = await getSettings();
  } catch {
    settings = { ...defaultSettings };
  }
  const key = settingsKey(settings);
  const nowMs = Date.now();
  let record: MarketSnapshotRecord | null = null;
  try {
    record = await readMarketSnapshot();
  } catch (error) {
    console.warn(
      "[market-snapshot] read failed (soft)",
      error instanceof Error ? error.message : error
    );
  }

  const needsRefresh =
    !record ||
    record.settingsKey !== key ||
    !Number.isFinite(Date.parse(record.generatedAt)) ||
    nowMs - Date.parse(record.generatedAt) >= record.refreshIntervalMs;

  if (needsRefresh && record) {
    // SWR: paint last snapshot now; refresh without blocking the HTTP response
    if (!getInflightRefresh()) {
      void refreshAndStore(settings).catch((error) => {
        console.warn(
          "[market-snapshot] background refresh failed",
          error instanceof Error ? error.message : error
        );
      });
    }
    return attachMeta(record.tetherMarket, record, Date.now());
  }

  if (needsRefresh && !record) {
    // Cold start only — must wait (capped inside buildFreshRecord)
    try {
      record = await refreshAndStore(settings);
    } catch (error) {
      console.warn(
        "[market-snapshot] cold refresh failed (soft)",
        error instanceof Error ? error.message : error
      );
    }
  }

  if (!record) {
    try {
      record = await buildFreshRecord(settings, { bypassListCache: false });
      await writeMarketSnapshot(record);
    } catch (error) {
      console.warn(
        "[market-snapshot] buildFresh failed (soft)",
        error instanceof Error ? error.message : error
      );
      const empty = calculateTetherMarket([], settings.outlierThresholdPercent);
      const serverNow = new Date().toISOString();
      return {
        ...empty,
        serverNow,
        generatedAt: serverNow,
        isStale: true,
        lastSuccessfulRefreshAt: null,
        lastAttemptedRefreshAt: serverNow,
        refreshIntervalMs: ttlFromMinutes(settings.priceRefreshMinutes)
      };
    }
  }

  return attachMeta(record.tetherMarket, record, Date.now());
}

/** Force a refresh (manual client Refresh / diagnostics). Still server-side only. */
export async function forceRefreshTetherMarketSnapshot(): Promise<TetherMarketSnapshotResponse> {
  const settings = await getSettings();
  // Manual refresh: bypass short list cache so user sees fresh LP pulls
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
