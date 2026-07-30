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

/**
 * Enabled by default in the production server process, because the collector is
 * part of the app now. An explicit env value can still force it either way.
 *
 * Defaulting on removes a dependency on Compose env plumbing: the production
 * host may compose this service from an external parent file plus
 * docker-compose.production.yml, in which case variables added to this repo's
 * docker-compose.yml never reach the container.
 */
function enabled(): boolean {
  const raw = (process.env.SHADOW_COLLECTOR_ENABLED ?? "").trim().toLowerCase();
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
  if (process.env.SHADOW_COLLECTOR === "1" || process.env.SHADOW_LOCAL_COLLECTOR === "1") return true;
  // No explicit setting: run in a production server process, stay off elsewhere.
  return process.env.NODE_ENV === "production";
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
  if (!enabled()) {
    log("collector disabled by SHADOW_COLLECTOR_ENABLED");
    return;
  }
  log(
    `bootstrap: NODE_ENV=${process.env.NODE_ENV} NEXT_RUNTIME=${process.env.NEXT_RUNTIME} ` +
      `SHADOW_COLLECTOR_ENABLED=${process.env.SHADOW_COLLECTOR_ENABLED ?? "(unset)"} pid=${process.pid}`
  );
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
  // waitForLease keeps this process retrying through a previous container's
  // still-valid lease and taking over the moment it expires.
  const handle = await startShadowCollector({
    workerId,
    pollIntervalMs: pollMs,
    log,
    waitForLease: true
  });
  if (!handle.leaseAcquired) {
    log("collector stopped before a lease could be acquired");
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
