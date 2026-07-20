/**
 * Canonical tether market snapshot persistence in PostgreSQL.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDb, withAdvisoryLock } from "@/db/client";
import { ingestionRuns, marketQuotes, marketSnapshots, sourceHealth } from "@/db/schema";
import type { MarketSnapshotRecord } from "@/lib/marketSnapshotStore";
import type { DomesticProviderHealth, DomesticQuote, TetherMarketResponse } from "@/lib/types";

const TETHER_TYPE = "tether";
/** Arbitrary stable advisory lock key for tether refresh single-flight. */
export const TETHER_REFRESH_LOCK = 74201931;

function contentHash(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function numStr(v: number | null | undefined): string | null {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  return String(v);
}

export async function pgReadLatestTetherSnapshot(): Promise<MarketSnapshotRecord | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(marketSnapshots)
    .where(eq(marketSnapshots.marketType, TETHER_TYPE))
    .orderBy(desc(marketSnapshots.generatedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const payload = row.payload as unknown as {
    tetherMarket?: TetherMarketResponse;
    providers?: DomesticProviderHealth[];
    quotes?: DomesticQuote[];
  };
  if (!payload?.tetherMarket) return null;
  return {
    version: 1,
    generatedAt: row.generatedAt,
    lastSuccessfulRefreshAt: row.lastSuccessfulRefreshAt,
    lastAttemptedRefreshAt: row.lastAttemptedRefreshAt,
    settingsKey: row.settingsKey ?? "",
    refreshIntervalMs: row.refreshIntervalMs ?? 180_000,
    tetherMarket: payload.tetherMarket,
    providers: payload.providers ?? [],
    quotes: payload.quotes ?? []
  };
}

export async function pgWriteTetherSnapshot(record: MarketSnapshotRecord): Promise<string> {
  const db = getDb();
  const hash = contentHash({
    summary: record.tetherMarket.summary,
    exchanges: record.tetherMarket.exchanges,
    settingsKey: record.settingsKey
  });

  // Dedup: if identical content exists, update attempt timestamps only
  const existing = await db
    .select()
    .from(marketSnapshots)
    .where(and(eq(marketSnapshots.contentHash, hash), eq(marketSnapshots.marketType, TETHER_TYPE)))
    .limit(1);

  if (existing[0]) {
    await db
      .update(marketSnapshots)
      .set({
        lastAttemptedRefreshAt: record.lastAttemptedRefreshAt,
        lastSuccessfulRefreshAt: record.lastSuccessfulRefreshAt,
        serverTime: new Date().toISOString(),
        isStale: false
      })
      .where(eq(marketSnapshots.id, existing[0].id));
    return existing[0].id;
  }

  const payload = {
    tetherMarket: record.tetherMarket,
    providers: record.providers,
    quotes: record.quotes
  };

  const snapshotId = randomUUID();
  await db.insert(marketSnapshots).values({
    id: snapshotId,
    marketType: TETHER_TYPE,
    generatedAt: record.generatedAt,
    serverTime: new Date().toISOString(),
    isStale: false,
    summary: record.tetherMarket.summary as unknown as Record<string, unknown>,
    payload: payload as unknown as Record<string, unknown>,
    contentHash: hash,
    settingsKey: record.settingsKey,
    refreshIntervalMs: record.refreshIntervalMs,
    lastSuccessfulRefreshAt: record.lastSuccessfulRefreshAt,
    lastAttemptedRefreshAt: record.lastAttemptedRefreshAt
  });

  // Quotes rows for audit/query
  if (record.quotes.length) {
    await db.insert(marketQuotes).values(
      record.quotes.map((q) => ({
        id: randomUUID(),
        snapshotId,
        sourceCode: q.exchangeId,
        sourceName: q.exchangeName,
        instrument: "USDT/IRT",
        currencyUnit: "IRT",
        buyPrice: numStr(q.buyPrice),
        sellPrice: numStr(q.sellPrice),
        midPrice: numStr(q.midPrice),
        userBuyPrice: numStr(q.sellPrice),
        userSellPrice: numStr(q.buyPrice),
        sourceUpdatedAt: q.lastUpdated,
        sourceStatus: q.sourceStatus,
        sanitizedError: q.errorMessage ?? null,
        metadata: {
          isOutlier: q.isOutlier,
          excludedFromMedian: q.excludedFromMedian
        }
      }))
    );
  }

  // Upsert source health
  for (const p of record.providers) {
    await db
      .insert(sourceHealth)
      .values({
        sourceCode: p.id,
        marketType: TETHER_TYPE,
        status: p.status,
        lastAttemptAt: p.lastAttemptAt,
        lastSuccessAt: p.lastSuccessAt,
        lastError: p.error,
        endpoint: p.endpoint,
        buyPrice: numStr(p.buyPrice),
        sellPrice: numStr(p.sellPrice),
        midPrice: numStr(p.midPrice),
        consecutiveFailures: p.status === "unavailable" ? 1 : 0,
        updatedAt: new Date().toISOString()
      })
      .onConflictDoUpdate({
        target: [sourceHealth.sourceCode, sourceHealth.marketType],
        set: {
          status: p.status,
          lastAttemptAt: p.lastAttemptAt,
          lastSuccessAt: p.lastSuccessAt,
          lastError: p.error,
          endpoint: p.endpoint,
          buyPrice: numStr(p.buyPrice),
          sellPrice: numStr(p.sellPrice),
          midPrice: numStr(p.midPrice),
          updatedAt: new Date().toISOString()
        }
      });
  }

  await db.insert(ingestionRuns).values({
    id: randomUUID(),
    marketType: TETHER_TYPE,
    startedAt: record.lastAttemptedRefreshAt ?? record.generatedAt,
    completedAt: record.generatedAt,
    status: "success",
    sourcesAttempted: record.quotes.length,
    sourcesSucceeded: record.quotes.filter((q) => q.sourceStatus !== "unavailable").length,
    metadata: { snapshotId }
  });

  return snapshotId;
}

export async function pgWithTetherRefreshLock<T>(
  fn: () => Promise<T>
): Promise<{ acquired: boolean; result?: T }> {
  return withAdvisoryLock(TETHER_REFRESH_LOCK, fn);
}
