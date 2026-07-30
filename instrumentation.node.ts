/**
 * Node-runtime instrumentation: the Shadow Arbitrage collector.
 *
 * Production topology is ONE container: this Next server process serves the app
 * and runs the collector. There is no separate worker service.
 *
 * It runs only when SHADOW_COLLECTOR_ENABLED=true (compose sets it on
 * iman-otc-desk). It never runs in the browser, the edge runtime, `next build`,
 * lint, tests or migrations: this file is imported solely from
 * `instrumentation.ts` behind a `NEXT_RUNTIME === "nodejs"` guard, and the
 * bootstrap hook is not executed during a build.
 *
 * Read-only: public market data in, database rows out. No credentials, orders,
 * balances or transfers.
 */
import { getDbAsync, pingDatabase } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { pollIntervalFromEnv } from "@/lib/shadowArbitrage/config";
import { startShadowCollector } from "@/lib/shadowArbitrage/runner";
import { makeWorkerId } from "@/lib/shadowArbitrage/workerIdentity";

function log(message: string, extra?: unknown) {
  const line = `[shadow-collector ${new Date().toISOString()}] ${message}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

function enabled(): boolean {
  const v = (process.env.SHADOW_COLLECTOR_ENABLED ?? "").trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  // Backwards-compatible flags.
  return process.env.SHADOW_COLLECTOR === "1" || process.env.SHADOW_LOCAL_COLLECTOR === "1";
}

/** Process-level singleton: one collector per Node process, always. */
const g = globalThis as typeof globalThis & { __shadowCollector?: { started: boolean } };

/** Block until the database answers, so the first cycle never races startup. */
async function waitForDatabase(maxAttempts = 30): Promise<boolean> {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await getDbAsync();
      await pingDatabase();
      return true;
    } catch (e) {
      if (attempt === maxAttempts) {
        log("database never became ready", e instanceof Error ? e.message : e);
        return false;
      }
      await new Promise((r) => setTimeout(r, Math.min(5_000, 500 * attempt)));
    }
  }
  return false;
}

async function start(): Promise<void> {
  if (!enabled()) return;
  if (g.__shadowCollector?.started) {
    log("collector already started in this process — ignoring duplicate bootstrap");
    return;
  }
  g.__shadowCollector = { started: true };

  if (!(await waitForDatabase())) {
    g.__shadowCollector.started = false;
    return;
  }

  // The container entrypoint also migrates; this is idempotent and guarantees
  // the shadow tables exist before the first cycle.
  try {
    const migrated = await runMigrations();
    if (migrated.applied.length) log("migrations applied", migrated.applied);
  } catch (e) {
    log("migrations failed — collector not started", e instanceof Error ? e.message : e);
    g.__shadowCollector.started = false;
    return;
  }

  const workerId = makeWorkerId("web");
  const pollMs = pollIntervalFromEnv();
  log(`starting collector workerId=${workerId} pollMs=${pollMs}`);
  log("SHADOW MODE — NO REAL ORDERS OR FUND TRANSFERS");

  // The PostgreSQL lease plus the advisory lock keep a future second replica
  // from collecting at the same time.
  const handle = await startShadowCollector({ workerId, pollIntervalMs: pollMs, log });
  if (!handle.leaseAcquired) {
    log(`another collector holds the lease (${handle.heldBy}) — this process stays passive`);
    return;
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — stopping collector`);
    await handle.stop().catch(() => undefined);
  };
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
}

// Fire and forget: a collector problem must never stop the app from serving.
void start().catch((e) => log("collector failed to start", e instanceof Error ? e.message : e));
