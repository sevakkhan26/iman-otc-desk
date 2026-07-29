#!/usr/bin/env npx tsx
/**
 * Shadow Arbitrage Phase 2 — standalone background collector.
 *
 *   pnpm shadow:worker
 *   SHADOW_POLL_MS=30000 pnpm shadow:worker      # 15000–300000
 *   SHADOW_MAX_CYCLES=6 pnpm shadow:worker       # bounded run (soak test)
 *
 * Runs with no browser open. Read-only: public market data in, database rows
 * out. It never authenticates to an exchange, never places or cancels an order,
 * and never moves funds. OMPFinex is not part of this worker.
 *
 * IMPORTANT on PGlite: a PGlite data directory has exactly one safe writer. If
 * DATABASE_URL points at a PGlite directory that the local app is also using,
 * run `pnpm shadow:local` instead — it hosts the collector inside the app
 * process. This script refuses to start in that situation rather than risk
 * losing writes.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./load-env.mts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Same environment as the app (.env.local → .env), so an explicit
// DATABASE_URL= prefix is no longer required to hit the right database.
loadLocalEnv(repoRoot);

const { closeDb, getDatabaseUrl, isPgliteUrl } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
const { startShadowCollector } = await import("../src/lib/shadowArbitrage/runner.ts");
const { pollIntervalFromEnv } = await import("../src/lib/shadowArbitrage/config.ts");
const { makeWorkerId } = await import("../src/lib/shadowArbitrage/workerIdentity.ts");

const workerId = makeWorkerId("worker");
const pollMs = pollIntervalFromEnv();
const maxCycles = Number(process.env.SHADOW_MAX_CYCLES ?? 0) || 0;

function log(msg: string, extra?: unknown) {
  const line = `[shadow-worker ${new Date().toISOString()}] ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

/**
 * Refuse to co-own a PGlite directory with another live process.
 * Concurrent PGlite writers silently drop each other's writes, so this is a
 * hard stop rather than a warning.
 */
function pgliteAlreadyHeld(dataDir: string): number | null {
  // `+D` walks the directory: PGlite holds handles on files inside it, not on
  // the directory itself, so a non-recursive lsof would miss the owner.
  const r = spawnSync("lsof", ["-nP", "-t", "+D", dataDir], { encoding: "utf8" });
  const pids = [
    ...new Set(
      (r.stdout ?? "")
        .split("\n")
        .map((l) => Number(l.trim()))
        .filter((p) => Number.isFinite(p) && p > 0 && p !== process.pid)
    )
  ];
  return pids.length ? pids[0]! : null;
}

async function main() {
  log(`start workerId=${workerId} pollMs=${pollMs}${maxCycles ? ` maxCycles=${maxCycles}` : ""}`);
  log("SHADOW MODE — NO REAL ORDERS OR FUND TRANSFERS");

  let url: string;
  try {
    url = getDatabaseUrl();
  } catch (e) {
    log("DATABASE_URL is not usable", e instanceof Error ? e.message : e);
    process.exit(1);
  }

  if (isPgliteUrl(url) && process.env.SHADOW_ALLOW_SHARED_PGLITE !== "1") {
    const rest = url.slice("pglite:".length).trim();
    const dataDir = path.isAbsolute(rest) ? rest : path.resolve(repoRoot, rest || ".data/pglite");
    const holder = pgliteAlreadyHeld(dataDir);
    if (holder) {
      log(
        `refusing to start: PGlite dir ${dataDir} is already open by pid ${holder}. ` +
          `Concurrent PGlite writers lose data — use \`pnpm shadow:local\` (collector runs inside the app), ` +
          `or point DATABASE_URL at real PostgreSQL.`
      );
      process.exit(1);
    }
  }

  try {
    const migrated = await runMigrations();
    if (migrated.applied.length) log("migrations applied", migrated.applied);
  } catch (e) {
    log("migrate failed — cannot collect", e instanceof Error ? e.message : e);
    await closeDb().catch(() => undefined);
    process.exit(1);
  }

  const handle = await startShadowCollector({ workerId, pollIntervalMs: pollMs, maxCycles, log });
  if (!handle.leaseAcquired) {
    await closeDb().catch(() => undefined);
    process.exit(0);
  }

  const stop = (signal: string) => {
    log(`${signal} — finishing current cycle then shutting down`);
    void handle.stop();
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await handle.done;
  log("shutdown complete");
  await closeDb().catch(() => undefined);
}

main().catch(async (e) => {
  console.error(e);
  await closeDb().catch(() => undefined);
  process.exit(1);
});
