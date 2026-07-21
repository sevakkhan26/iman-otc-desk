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
  /** Generation bumped on pool reset so in-flight retries re-init cleanly. */
  poolGeneration: number;
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
      pgliteQueue: Promise.resolve(),
      poolGeneration: 0
    };
  }
  return g.__otcDeskDb;
}

/** Transient network / pool failures under Docker Desktop (TCP bridge flakiness). */
export function isTransientDbError(error: unknown): boolean {
  const walk: unknown[] = [error];
  const seen = new Set<unknown>();
  while (walk.length) {
    const cur = walk.shift();
    if (cur == null || seen.has(cur)) continue;
    seen.add(cur);
    if (typeof cur === "object") {
      const o = cur as { code?: unknown; errno?: unknown; message?: unknown; cause?: unknown };
      const code = String(o.code ?? o.errno ?? "");
      if (
        code === "CONNECT_TIMEOUT" ||
        code === "ECONNRESET" ||
        code === "ECONNREFUSED" ||
        code === "ETIMEDOUT" ||
        code === "EPIPE" ||
        code === "57P01" || // admin_shutdown
        code === "57P03" // cannot_connect_now
      ) {
        return true;
      }
      const msg = String(o.message ?? "");
      if (/CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT|connection terminated|not yet accepting/i.test(msg)) {
        return true;
      }
      if ("cause" in o && o.cause) walk.push(o.cause);
    } else if (typeof cur === "string") {
      if (/CONNECT_TIMEOUT|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(cur)) return true;
    }
  }
  return false;
}

async function destroyPgPool(): Promise<void> {
  const s = state();
  const sql = s.sql;
  s.sql = null;
  s.db = null;
  s.mode = null;
  s.initPromise = null;
  s.poolGeneration += 1;
  if (sql) {
    try {
      await sql.end({ timeout: 1 });
    } catch {
      /* ignore */
    }
  }
}

function createPgSql(url: string): ReturnType<typeof postgres> {
  const poolMax = Math.max(1, Number(process.env.DATABASE_POOL_MAX ?? 10) || 10);
  // Prefer fewer sockets under Docker Desktop — less connect churn, more reuse.
  const max = Math.min(poolMax, 6);
  const base = {
    max,
    // Keep idle sockets longer so refresh storms reuse instead of reconnecting
    idle_timeout: 60,
    // Fail faster on dead bridge, then retry with a fresh pool
    connect_timeout: 8,
    max_lifetime: 60 * 15,
    prepare: false as const,
    // Skip catalog type fetch round-trips on each new connection
    fetch_types: false as const,
    connection: {
      application_name: "iman-otc-desk"
    }
  };

  // Prefer explicit Unix socket (shared volume) — no Docker bridge TCP.
  const socket = process.env.OTC_DB_SOCKET?.trim();
  if (socket) {
    let user = process.env.POSTGRES_USER?.trim() || "otc_app";
    let password = process.env.POSTGRES_PASSWORD ?? "";
    let database = process.env.POSTGRES_DB?.trim() || "otc_desk";
    try {
      // Accept postgres://user:pass@host/db or …@localhost/db?host=/socket
      const normalized = url.replace(/^postgres(ql)?:\/\//i, "http://");
      const u = new URL(normalized);
      if (u.username) user = decodeURIComponent(u.username);
      if (u.password) password = decodeURIComponent(u.password);
      const pathDb = u.pathname.replace(/^\//, "");
      if (pathDb) database = pathDb;
    } catch {
      /* use env defaults */
    }
    return postgres({
      ...base,
      host: socket,
      database,
      username: user,
      password
    });
  }

  // Fix empty-host URLs (postgres://user:pass@/db?host=/socket) for WHATWG URL parser
  let connectUrl = url;
  if (/^postgres(ql)?:\/\/[^@]+@\//i.test(url) && /[?&]host=\//i.test(url)) {
    connectUrl = url.replace(/@\//, "@localhost/");
  }

  return postgres(connectUrl, base);
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

async function initDbOnce(): Promise<DeskDb> {
  const s = state();
  if (s.db) return s.db;

  const url = getDatabaseUrl();

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
    s.sql = createPgSql(url);
    s.db = drizzlePg(s.sql, { schema });
    s.mode = "postgres";
    // smoke probe
    await s.sql`SELECT 1`;
    return s.db;
  } catch (error) {
    await destroyPgPool();
    const msg = error instanceof Error ? error.message : String(error);
    throw new DatabaseUnavailableError(`PostgreSQL connection failed: ${msg}`, error);
  }
}

async function initDb(): Promise<DeskDb> {
  const attempts = Math.max(1, Number(process.env.DATABASE_CONNECT_RETRIES ?? 3) || 3);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await initDbOnce();
    } catch (error) {
      last = error;
      if (!isTransientDbError(error) || i === attempts - 1) throw error;
      await destroyPgPool();
      // 50ms, 150ms, 350ms…
      await new Promise((r) => setTimeout(r, 50 + i * 100));
    }
  }
  throw last;
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
 * Run a DB operation; on transient CONNECT_TIMEOUT / reset, rebuild the pool and retry once.
 * Use for critical hot paths (settings, snapshots) under Docker Desktop.
 */
export async function withDbRetry<T>(fn: () => Promise<T>, label = "db"): Promise<T> {
  try {
    await getDbAsync();
    return await fn();
  } catch (error) {
    if (!isTransientDbError(error)) throw error;
    console.warn(
      `[db] transient error on ${label}, resetting pool and retrying once:`,
      error instanceof Error ? error.message : error
    );
    await destroyPgPool();
    await getDbAsync();
    return await fn();
  }
}

/**
 * Sync accessor for call sites that cannot await.
 * - Postgres: construct pool immediately (lazy first query) so hot paths never "still connecting".
 * - PGlite: never open a second WASM handle; kick async init and throw until ready.
 * Prefer await getDbAsync() in new code.
 */
export function getDb(): DeskDb {
  const s = state();
  if (s.db) return s.db;
  const url = getDatabaseUrl();
  if (isPgliteUrl(url)) {
    // Single-flight async init; do not construct PGlite here (aborts WASM under concurrency).
    void getDbAsync();
    throw new DatabaseUnavailableError(
      "Database is initializing — use await getDbAsync() (retry the request)."
    );
  }
  // postgres.js: open pool sync — connection happens on first query (no race throw)
  try {
    s.sql = createPgSql(url);
    s.db = drizzlePg(s.sql, { schema });
    s.mode = "postgres";
    s.initPromise = Promise.resolve(s.db);
    return s.db;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new DatabaseUnavailableError(`PostgreSQL client init failed: ${msg}`, error);
  }
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
  if (s.pglite) {
    try {
      await s.pglite.close();
    } catch {
      /* ignore */
    }
    s.pglite = null;
  }
  await destroyPgPool();
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
