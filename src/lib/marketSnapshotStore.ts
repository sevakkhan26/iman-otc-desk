/**
 * Canonical market snapshot store — PostgreSQL only.
 * Fail closed when DATABASE_URL is unavailable.
 */
import { DatabaseUnavailableError, getDatabaseUrl, withDbRetry } from "@/db/client";
import {
  pgReadLatestTetherSnapshot,
  pgWithTetherRefreshLock,
  pgWriteTetherSnapshot
} from "@/db/repositories/marketSnapshots";
import type { DomesticProviderHealth, DomesticQuote, TetherMarketResponse } from "@/lib/types";

export type MarketSnapshotRecord = {
  version: 1;
  generatedAt: string;
  lastSuccessfulRefreshAt: string | null;
  lastAttemptedRefreshAt: string | null;
  settingsKey: string;
  refreshIntervalMs: number;
  tetherMarket: TetherMarketResponse;
  providers: DomesticProviderHealth[];
  quotes: DomesticQuote[];
};

let inflightRefresh: Promise<MarketSnapshotRecord> | null = null;

export async function readMarketSnapshot(): Promise<MarketSnapshotRecord | null> {
  try {
    getDatabaseUrl();
    return await withDbRetry(() => pgReadLatestTetherSnapshot(), "snapshot-read");
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) throw error;
    console.error("[market-snapshot] read failed", error instanceof Error ? error.message : error);
    throw new DatabaseUnavailableError(
      error instanceof Error ? error.message : "PostgreSQL market snapshot read failed"
    );
  }
}

export async function writeMarketSnapshot(record: MarketSnapshotRecord): Promise<void> {
  try {
    getDatabaseUrl();
    // Write failures must not 503 the whole dashboard — log and continue with in-memory payload.
    await withDbRetry(() => pgWriteTetherSnapshot(record), "snapshot-write");
  } catch (error) {
    console.error("[market-snapshot] write failed", error instanceof Error ? error.message : error);
    // Soft-fail: tether response already computed; next refresh retries persistence.
  }
}

export async function tryAcquireSnapshotLock(): Promise<boolean> {
  // Real lock is acquired inside refresh via advisory lock; process-local inflight remains.
  return true;
}

export async function releaseSnapshotLock(): Promise<void> {
  // no-op — advisory unlock handled in withAdvisoryLock
}

export function getInflightRefresh(): Promise<MarketSnapshotRecord> | null {
  return inflightRefresh;
}

export function setInflightRefresh(p: Promise<MarketSnapshotRecord> | null): void {
  inflightRefresh = p;
}

export function getSnapshotStorageBackend(): "postgres" {
  return "postgres";
}

export { pgWithTetherRefreshLock };
