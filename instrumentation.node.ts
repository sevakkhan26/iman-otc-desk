/**
 * Node-runtime instrumentation: the in-process Shadow Arbitrage collector.
 *
 * Opt-in, off by default — it only runs when SHADOW_LOCAL_COLLECTOR=1, which
 * `pnpm shadow:local` sets. Every other command, and production, are
 * unaffected; there the standalone `pnpm shadow:worker` process is used.
 *
 * Why in-process at all: a PGlite data directory has exactly one safe writer.
 * Running the app and a separate worker process against the same directory
 * silently loses writes (verified on this machine), so on PGlite the collector
 * must live inside the server process. With real PostgreSQL, `shadow:local`
 * spawns the standalone worker instead and this file does nothing.
 *
 * This executes at server bootstrap, not inside a request handler, so
 * collection never depends on a browser being open.
 */
import { runMigrations } from "@/db/migrate";
import { pollIntervalFromEnv } from "@/lib/shadowArbitrage/config";
import { startShadowCollector } from "@/lib/shadowArbitrage/runner";
import { makeWorkerId } from "@/lib/shadowArbitrage/workerIdentity";

function log(message: string, extra?: unknown) {
  const line = `[shadow-worker ${new Date().toISOString()}] ${message}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

/** Guard against double registration within a single process. */
const globalFlag = globalThis as typeof globalThis & { __shadowCollectorStarted?: boolean };

/**
 * Enabled by `SHADOW_COLLECTOR=1` (production worker container) or
 * `SHADOW_LOCAL_COLLECTOR=1` (`pnpm shadow:local`). Absent → this file does
 * nothing, so the public app container never collects.
 */
function collectorEnabled(): boolean {
  return process.env.SHADOW_COLLECTOR === "1" || process.env.SHADOW_LOCAL_COLLECTOR === "1";
}

async function start(): Promise<void> {
  if (!collectorEnabled()) return;
  if (globalFlag.__shadowCollectorStarted) {
    log("collector already started in this process — skipping duplicate");
    return;
  }
  globalFlag.__shadowCollectorStarted = true;

  try {
    const migrated = await runMigrations();
    if (migrated.applied.length) log("migrations applied", migrated.applied);
  } catch (e) {
    log("migrate failed — collector not started", e instanceof Error ? e.message : e);
    return;
  }

  const workerId = makeWorkerId("inproc");
  const pollMs = pollIntervalFromEnv();
  log(`starting in-process collector workerId=${workerId} pollMs=${pollMs}`);
  log("SHADOW MODE — NO REAL ORDERS OR FUND TRANSFERS");

  const handle = await startShadowCollector({ workerId, pollIntervalMs: pollMs, log });
  if (!handle.leaseAcquired) return;

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — stopping collector`);
    await handle.stop().catch(() => undefined);
  };
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

// Fire and forget: a collector problem must never block the app from serving.
void start().catch((e) => log("collector failed to start", e instanceof Error ? e.message : e));
