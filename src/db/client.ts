/**
 * PostgreSQL client for OTC desk.
 *
 * - Production / Docker: DATABASE_URL=postgres://...
 * - Local without Docker: DATABASE_URL=pglite:.data/pglite (embedded PG-compatible)
 *
 * Fail closed when DATABASE_URL is missing or unreachable — no JSON/Redis runtime fallback.
 *
 * Notes for Next.js:
 * - Use a process-global singleton so HMR / multi-import doesn't open many PGlite handles.
 * - Always await PGlite readiness before first query.
 * - PGlite must stay in serverExternalPackages (see next.config.ts).
 */
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { PGlite } from "@electric-sql/pglite";
import postgres from "postgres";
import * as schema from "@/db/schema";
import path from "node:path";
import { mkdirSync } from "node:fs";

export type DeskDb =
  | ReturnType<typeof drizzlePg<typeof schema>>
  | ReturnType<typeof drizzlePglite<typeof schema>>;

type GlobalDbState = {
  db: DeskDb | null;
  sql: ReturnType<typeof postgres> | null;
  pglite: PGlite | null;
  mode: "postgres" | "pglite" | null;
  initPromise: Promise<DeskDb> | null;
  pgliteQueue: Promise<unknown>;
};

const g = globalThis as typeof globalThis & { __otcDeskDb?: GlobalDbState };

function state(): GlobalDbState {
  if (!g.__otcDeskDb) {
    g.__otcDeskDb = {
      db: null,
      sql: null,
      pglite: null,
      mode: null,
      initPromise: null,
      pgliteQueue: Promise.resolve()
    };
  }
  return g.__otcDeskDb;
}

export class DatabaseUnavailableError extends Error {
  code = "DATABASE_UNAVAILABLE";
  cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "DatabaseUnavailableError";
    this.cause = cause;
  }
}

export function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim() ?? "";
  if (!url) {
    throw new DatabaseUnavailableError(
      "DATABASE_URL is not set. PostgreSQL is required as the single durable store."
    );
  }
  return url;
}

export function isPgliteUrl(url: string): boolean {
  return url.startsWith("pglite:") || url === "pglite" || url.startsWith("file:pglite");
}

function resolvePgliteDataDir(url: string): string {
  if (url === "pglite" || url === "pglite:") {
    return path.resolve(process.cwd(), ".data", "pglite");
  }
  if (url.startsWith("pglite:")) {
    const rest = url.slice("pglite:".length).trim();
    // Absolute path or relative to cwd — always a plain string (never file: URL)
    if (path.isAbsolute(rest)) return rest;
    return path.resolve(process.cwd(), rest || path.join(".data", "pglite"));
  }
  if (url.startsWith("file:pglite")) {
    return path.resolve(process.cwd(), ".data", "pglite");
  }
  return path.resolve(process.cwd(), ".data", "pglite");
}

async function initDb(): Promise<DeskDb> {
  const s = state();
  if (s.db) return s.db;

  const url = getDatabaseUrl();
  const poolMax = Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? 10) || 10);

  if (isPgliteUrl(url)) {
    const dataDir = resolvePgliteDataDir(url);
    mkdirSync(dataDir, { recursive: true });
    try {
      // Prefer create() so WASM / FS is fully ready before first query
      const pglite =
        typeof (PGlite as unknown as { create?: (d: string) => Promise<PGlite> }).create ===
        "function"
          ? await (PGlite as unknown as { create: (d: string) => Promise<PGlite> }).create(dataDir)
          : new PGlite(dataDir);
      // Older/newer APIs expose waitReady
      const ready = (pglite as unknown as { waitReady?: Promise<void> }).waitReady;
      if (ready) await ready;
      s.pglite = pglite;
      s.db = drizzlePglite(pglite, { schema });
      s.mode = "pglite";
      return s.db;
    } catch (error) {
      s.pglite = null;
      s.db = null;
      s.mode = null;
      const msg = error instanceof Error ? error.message : String(error);
      throw new DatabaseUnavailableError(
        `PGlite init failed (${dataDir}): ${msg}. For multi-process use real Postgres (DATABASE_URL=postgres://…).`,
        error
      );
    }
  }

  try {
    s.sql = postgres(url, {
      max: poolMax,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false
    });
    s.db = drizzlePg(s.sql, { schema });
    s.mode = "postgres";
    // smoke probe
    await s.sql`SELECT 1`;
    return s.db;
  } catch (error) {
    if (s.sql) {
      try {
        await s.sql.end({ timeout: 1 });
      } catch {
        /* ignore */
      }
    }
    s.sql = null;
    s.db = null;
    s.mode = null;
    const msg = error instanceof Error ? error.message : String(error);
    throw new DatabaseUnavailableError(`PostgreSQL connection failed: ${msg}`, error);
  }
}

/** Async-safe DB accessor (preferred). */
export async function getDbAsync(): Promise<DeskDb> {
  const s = state();
  if (s.db) return s.db;
  if (!s.initPromise) {
    s.initPromise = initDb().finally(() => {
      // keep resolved db; allow retry only if init failed (db still null)
      if (!state().db) state().initPromise = null;
    });
  }
  return s.initPromise;
}

/**
 * Sync accessor for call sites that cannot await.
 * Returns existing instance; kicks off init if needed and throws if not ready.
 * Prefer getDbAsync() in new code.
 */
export function getDb(): DeskDb {
  const s = state();
  if (s.db) return s.db;
  // Kick off async init for next tick / concurrent awaiters
  void getDbAsync();
  // Best-effort sync path for PGlite constructor (may still need waitReady)
  const url = getDatabaseUrl();
  if (isPgliteUrl(url)) {
    // Block via deasync is not available — force sync construction + queue
    const dataDir = resolvePgliteDataDir(url);
    mkdirSync(dataDir, { recursive: true });
    try {
      const pglite = new PGlite(dataDir);
      s.pglite = pglite;
      s.db = drizzlePglite(pglite, { schema });
      s.mode = "pglite";
      s.initPromise = Promise.resolve(s.db);
      return s.db;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new DatabaseUnavailableError(`PGlite sync init failed: ${msg}`, error);
    }
  }
  // postgres.js can be constructed sync
  if (!s.initPromise) {
    s.initPromise = initDb();
  }
  throw new DatabaseUnavailableError(
    "PostgreSQL is still connecting — retry the request. Prefer await getDbAsync()."
  );
}

export function getDbMode(): "postgres" | "pglite" | null {
  return state().mode;
}

/** Serialize PGlite work (single-writer FS). No-op for real Postgres. */
export async function withPgliteSerial<T>(fn: () => Promise<T>): Promise<T> {
  const s = state();
  if (s.mode !== "pglite" && !isPgliteUrl(getDatabaseUrl())) {
    return fn();
  }
  const run = s.pgliteQueue.then(fn, fn);
  s.pgliteQueue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

/** Raw SQL for advisory locks / migrations. */
export async function execRaw(sqlText: string): Promise<void> {
  const url = getDatabaseUrl();
  await getDbAsync();
  const s = state();
  if (isPgliteUrl(url)) {
    if (!s.pglite) throw new DatabaseUnavailableError("PGlite not initialized");
    await withPgliteSerial(async () => {
      await s.pglite!.exec(sqlText);
    });
    return;
  }
  if (!s.sql) throw new DatabaseUnavailableError("PostgreSQL not initialized");
  await s.sql.unsafe(sqlText);
}

export async function withAdvisoryLock<T>(
  lockKey: number,
  fn: () => Promise<T>
): Promise<{ acquired: boolean; result?: T }> {
  const url = getDatabaseUrl();
  if (isPgliteUrl(url)) {
    return { acquired: true, result: await withPgliteSerial(fn) };
  }
  await getDbAsync();
  const sql = state().sql!;
  const rows = await sql`SELECT pg_try_advisory_lock(${lockKey}) AS ok`;
  const ok = Boolean(rows[0]?.ok);
  if (!ok) return { acquired: false };
  try {
    const result = await fn();
    return { acquired: true, result };
  } finally {
    await sql`SELECT pg_advisory_unlock(${lockKey})`;
  }
}

export async function closeDb(): Promise<void> {
  const s = state();
  if (s.sql) {
    await s.sql.end({ timeout: 5 });
    s.sql = null;
  }
  if (s.pglite) {
    try {
      await s.pglite.close();
    } catch {
      /* ignore */
    }
    s.pglite = null;
  }
  s.db = null;
  s.mode = null;
  s.initPromise = null;
  s.pgliteQueue = Promise.resolve();
}

/** Health probe — throws if DB unreachable. */
export async function pingDatabase(): Promise<{ ok: true; mode: string }> {
  await getDbAsync();
  const s = state();
  if (s.mode === "pglite" && s.pglite) {
    await withPgliteSerial(async () => {
      await s.pglite!.query("SELECT 1");
    });
    return { ok: true, mode: "pglite" };
  }
  if (!s.sql) throw new DatabaseUnavailableError("PostgreSQL not initialized");
  await s.sql`SELECT 1`;
  return { ok: true, mode: "postgres" };
}

/** Wrap DB errors with a clear operational message (preserve cause). */
export function asDbError(error: unknown, context: string): DatabaseUnavailableError {
  if (error instanceof DatabaseUnavailableError) return error;
  const msg = error instanceof Error ? error.message : String(error);
  return new DatabaseUnavailableError(`${context}: ${msg}`, error);
}
