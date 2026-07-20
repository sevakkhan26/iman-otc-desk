/**
 * Persistent storage for the canonical market snapshot.
 *
 * Backends (same selection model as price alerts):
 * - file: local / Docker (.data/market-snapshot.json)
 * - upstash: optional Redis REST (Vercel)
 * - memory: last-resort process memory (not multi-instance safe)
 *
 * Not used for browser storage — server only.
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { outboundFetch } from "@/lib/http";
import type { DomesticProviderHealth, DomesticQuote, TetherMarketResponse } from "@/lib/types";

const REDIS_KEY = "otc:market-snapshot:v1";
const REDIS_LOCK_KEY = "otc:market-snapshot:lock:v1";
const LOCK_TTL_MS = 45_000;

export type MarketSnapshotRecord = {
  version: 1;
  /** UTC ISO when this snapshot payload was produced. */
  generatedAt: string;
  /** UTC ISO of last successful provider refresh that produced usable quotes. */
  lastSuccessfulRefreshAt: string | null;
  /** UTC ISO of last refresh attempt (success or failure). */
  lastAttemptedRefreshAt: string | null;
  /** Settings fingerprint used for this snapshot. */
  settingsKey: string;
  refreshIntervalMs: number;
  tetherMarket: TetherMarketResponse;
  providers: DomesticProviderHealth[];
  /** Quotes used to build tetherMarket (for recompute / diagnostics). */
  quotes: DomesticQuote[];
};

type StorageBackend = "file" | "upstash" | "memory";

let memorySnapshot: MarketSnapshotRecord | null = null;
let inflightRefresh: Promise<MarketSnapshotRecord> | null = null;

function isVercel(): boolean {
  return process.env.VERCEL === "1";
}

function hasUpstash(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
  return url.length > 0 && token.length > 0;
}

function resolveBackend(): StorageBackend {
  const explicit = (process.env.MARKET_SNAPSHOT_STORAGE ?? process.env.PRICE_ALERTS_STORAGE ?? "")
    .trim()
    .toLowerCase();
  if (explicit === "upstash") return hasUpstash() ? "upstash" : "memory";
  if (explicit === "file") return isVercel() ? (hasUpstash() ? "upstash" : "memory") : "file";
  if (explicit === "memory" || explicit === "none") return "memory";
  if (hasUpstash()) return "upstash";
  if (isVercel()) return "memory";
  return "file";
}

function snapshotFilePath(): string {
  const fromEnv = process.env.MARKET_SNAPSHOT_DATA_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const dir =
    process.env.MARKET_SNAPSHOT_DATA_DIR?.trim() ||
    process.env.PRICE_ALERTS_DATA_DIR?.trim() ||
    path.join(process.cwd(), ".data");
  return path.join(path.resolve(dir), "market-snapshot.json");
}

function lockFilePath(): string {
  return `${snapshotFilePath()}.lock`;
}

async function upstashCommand(args: unknown[]): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL!.trim();
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const response = await outboundFetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(args),
    cache: "no-store"
  });
  if (!response.ok) {
    throw new Error(`Upstash HTTP ${response.status}`);
  }
  const json = (await response.json()) as { result?: unknown };
  return json.result;
}

function parseRecord(raw: unknown): MarketSnapshotRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<MarketSnapshotRecord>;
  if (o.version !== 1) return null;
  if (typeof o.generatedAt !== "string") return null;
  if (!o.tetherMarket || typeof o.tetherMarket !== "object") return null;
  if (!Array.isArray(o.providers) || !Array.isArray(o.quotes)) return null;
  return {
    version: 1,
    generatedAt: o.generatedAt,
    lastSuccessfulRefreshAt:
      typeof o.lastSuccessfulRefreshAt === "string" ? o.lastSuccessfulRefreshAt : null,
    lastAttemptedRefreshAt:
      typeof o.lastAttemptedRefreshAt === "string" ? o.lastAttemptedRefreshAt : null,
    settingsKey: typeof o.settingsKey === "string" ? o.settingsKey : "",
    refreshIntervalMs:
      typeof o.refreshIntervalMs === "number" && Number.isFinite(o.refreshIntervalMs)
        ? o.refreshIntervalMs
        : 180_000,
    tetherMarket: o.tetherMarket as TetherMarketResponse,
    providers: o.providers as DomesticProviderHealth[],
    quotes: o.quotes as DomesticQuote[]
  };
}

export async function readMarketSnapshot(): Promise<MarketSnapshotRecord | null> {
  const backend = resolveBackend();
  try {
    if (backend === "upstash") {
      const raw = await upstashCommand(["GET", REDIS_KEY]);
      if (typeof raw !== "string" || !raw) return memorySnapshot;
      const parsed = parseRecord(JSON.parse(raw));
      if (parsed) memorySnapshot = parsed;
      return parsed ?? memorySnapshot;
    }
    if (backend === "file") {
      try {
        const raw = await readFile(snapshotFilePath(), "utf8");
        const parsed = parseRecord(JSON.parse(raw));
        if (parsed) memorySnapshot = parsed;
        return parsed ?? memorySnapshot;
      } catch {
        return memorySnapshot;
      }
    }
    return memorySnapshot;
  } catch {
    return memorySnapshot;
  }
}

export async function writeMarketSnapshot(record: MarketSnapshotRecord): Promise<void> {
  memorySnapshot = record;
  const backend = resolveBackend();
  try {
    if (backend === "upstash") {
      await upstashCommand(["SET", REDIS_KEY, JSON.stringify(record)]);
      return;
    }
    if (backend === "file") {
      const file = snapshotFilePath();
      const dir = path.dirname(file);
      await mkdir(dir, { recursive: true });
      const tmp = path.join(dir, `.market-snapshot.${process.pid}.${Date.now()}.tmp`);
      const handle = await open(tmp, "w");
      try {
        await handle.writeFile(JSON.stringify(record), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tmp, file);
    }
  } catch (error) {
    console.error(
      "[market-snapshot] write failed",
      error instanceof Error ? error.message : error
    );
  }
}

/** Best-effort distributed / local lock. Returns true if this process holds the lock. */
export async function tryAcquireSnapshotLock(): Promise<boolean> {
  const backend = resolveBackend();
  try {
    if (backend === "upstash") {
      const result = await upstashCommand([
        "SET",
        REDIS_LOCK_KEY,
        `${process.pid}:${Date.now()}`,
        "NX",
        "PX",
        LOCK_TTL_MS
      ]);
      return result === "OK";
    }
    if (backend === "file") {
      const lockPath = lockFilePath();
      await mkdir(path.dirname(lockPath), { recursive: true });
      try {
        // Exclusive create — fails if lock exists
        const handle = await open(lockPath, "wx");
        try {
          await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
        } finally {
          await handle.close();
        }
        return true;
      } catch {
        // Stale lock recovery
        try {
          const raw = await readFile(lockPath, "utf8");
          const parsed = JSON.parse(raw) as { at?: number };
          if (typeof parsed.at === "number" && Date.now() - parsed.at > LOCK_TTL_MS) {
            await unlink(lockPath).catch(() => {});
            const handle = await open(lockPath, "wx");
            try {
              await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
            } finally {
              await handle.close();
            }
            return true;
          }
        } catch {
          /* ignore */
        }
        return false;
      }
    }
    // memory: use inflight promise as lock
    return true;
  } catch {
    return true; // prefer progress over deadlock
  }
}

export async function releaseSnapshotLock(): Promise<void> {
  const backend = resolveBackend();
  try {
    if (backend === "upstash") {
      await upstashCommand(["DEL", REDIS_LOCK_KEY]);
      return;
    }
    if (backend === "file") {
      await unlink(lockFilePath()).catch(() => {});
    }
  } catch {
    /* ignore */
  }
}

/** Process-local single-flight for concurrent snapshot refreshes. */
export function getInflightRefresh(): Promise<MarketSnapshotRecord> | null {
  return inflightRefresh;
}

export function setInflightRefresh(p: Promise<MarketSnapshotRecord> | null): void {
  inflightRefresh = p;
}

export function getSnapshotStorageBackend(): StorageBackend {
  return resolveBackend();
}
