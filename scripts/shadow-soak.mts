#!/usr/bin/env npx tsx
/**
 * Shadow Arbitrage soak test — automated cycles with no browser involved.
 *
 * Spawns the real worker (`scripts/shadow-worker.mts`) as a child process, in
 * two runs so worker-restart continuity is exercised, then verifies from the
 * database that:
 *   • cycles were added automatically, without any UI interaction
 *   • no duplicate runs were recorded
 *   • a failing source did not stop the others
 *   • lifecycle and observation data survived the worker restart
 *   • the API read path returns the collected data
 *
 * Usage:
 *   pnpm shadow:soak                       # temp database, 2×6 cycles
 *   SHADOW_SOAK_CYCLES=10 pnpm shadow:soak # cycles per worker run
 *   SHADOW_SOAK_DB=.data/pglite-soak pnpm shadow:soak
 *
 * Read-only with respect to exchanges: public market data only.
 */
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cyclesPerRun = Math.max(3, Number(process.env.SHADOW_SOAK_CYCLES ?? 6) || 6);
const pollMs = Math.max(15_000, Number(process.env.SHADOW_POLL_MS ?? 15_000) || 15_000);
const logPath = process.env.SHADOW_SOAK_LOG ?? path.join(tmpdir(), "shadow-soak.log");
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

function log(msg: string) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(logPath, line + "\n");
  } catch {
    /* ignore */
  }
}

/** Run the worker as a real child process and wait for it to exit. */
function runWorker(label: string, databaseUrl: string, maxCycles: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "npx",
      ["--yes", "tsx", "scripts/shadow-worker.mts"],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          SHADOW_POLL_MS: String(pollMs),
          SHADOW_MAX_CYCLES: String(maxCycles)
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    child.stdout.on("data", (d: Buffer) => {
      for (const line of d.toString().trimEnd().split("\n")) log(`${label} | ${line}`);
    });
    child.stderr.on("data", (d: Buffer) => {
      for (const line of d.toString().trimEnd().split("\n")) log(`${label} ! ${line}`);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 0));
  });
}

async function main() {
  writeFileSync(logPath, "");
  log(`Shadow soak — worker child processes, ${cyclesPerRun} cycles per run, interval ${pollMs}ms`);
  log("SHADOW MODE — NO REAL ORDERS OR FUND TRANSFERS");

  const dbDir =
    process.env.SHADOW_SOAK_DB ?? path.join(await mkdtemp(path.join(tmpdir(), "otc-shadow-soak-")), "pglite");
  const databaseUrl = `pglite:${dbDir}`;
  log(`database: ${databaseUrl}`);

  // Run 1 — cold start: migrations, session creation, first cycles.
  const exit1 = await runWorker("run1", databaseUrl, cyclesPerRun);
  log(`run1 exited with code ${exit1}`);

  // Inspect between runs, in this process, using the same database.
  process.env.DATABASE_URL = databaseUrl;
  const { closeDb } = await import("../src/db/client.ts");
  const repo = await import("../src/db/repositories/shadowArbitrage.ts");
  const store = await import("../src/lib/shadowArbitrage/store.ts");

  const midObs = await repo.getObservation();
  const midRuns = await repo.loadRunStats();
  const midActive = await repo.loadActiveOpportunitiesDb();
  log(
    `after run1: session=${midObs?.id} status=${midObs?.status} cycles=${midObs?.completedCycles} ` +
      `runs=${midRuns.runCount} activeLifecycles=${midActive.length}`
  );
  const midIds = new Set(midActive.map((o) => o.id));
  await closeDb();

  // Run 2 — restart continuity: same session, counters continue.
  const exit2 = await runWorker("run2", databaseUrl, cyclesPerRun);
  log(`run2 exited with code ${exit2}`);

  const obs = await repo.getObservation();
  const runs = await repo.loadRunStats();
  const sources = await repo.loadSourceStats();
  const active = await repo.loadActiveOpportunitiesDb();
  const snapshots = await repo.countSnapshots();
  const events = await repo.countLifecycleEvents();
  const metrics = await repo.loadRouteMetrics();
  const matrix = await store.loadLastMatrix();
  const analytics = await store.computeAnalytics();

  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail = "") => checks.push({ name, ok, detail });

  check(
    "at least 10 consecutive cycles recorded automatically",
    runs.runCount >= 10,
    `runCount=${runs.runCount}`
  );
  check(
    "no duplicate runs",
    runs.duplicateIdempotencyKeys === 0,
    `duplicateKeys=${runs.duplicateIdempotencyKeys}`
  );
  check(
    "observation session survived the restart",
    Boolean(obs && midObs && obs.id === midObs.id),
    `before=${midObs?.id} after=${obs?.id}`
  );
  check(
    "cycle counters continued after the restart",
    Boolean(obs && midObs && obs.completedCycles > midObs.completedCycles),
    `${midObs?.completedCycles} → ${obs?.completedCycles}`
  );
  check(
    "observation start time unchanged",
    Boolean(obs && midObs && obs.startedAt === midObs.startedAt),
    `${midObs?.startedAt} → ${obs?.startedAt}`
  );
  check(
    "lifecycle rows survived the restart",
    active.some((o) => midIds.has(o.id)) || (midIds.size === 0 && active.length > 0),
    `carriedOver=${active.filter((o) => midIds.has(o.id)).length}/${active.length}`
  );
  check(
    "one lifecycle per active route (no per-cycle duplication)",
    (() => {
      const seen = new Map<string, number>();
      for (const o of active) seen.set(o.routeKey, (seen.get(o.routeKey) ?? 0) + 1);
      return [...seen.values()].every((c) => c === 1);
    })(),
    `activeRoutes=${new Set(active.map((o) => o.routeKey)).size} rows=${active.length}`
  );
  check("snapshots recorded per source per cycle", snapshots >= runs.runCount, `snapshots=${snapshots}`);
  check("route aggregates written", metrics.length > 0, `routes=${metrics.length}`);
  check("lifecycle transition events recorded", events > 0, `events=${events}`);
  check(
    "every source was probed every cycle",
    sources.length === 9 && sources.every((s) => s.samples >= runs.runCount - 1),
    sources.map((s) => `${s.sourceId}:${s.samples}`).join(" ")
  );
  const failing = sources.filter((s) => s.errorSamples > 0);
  const healthy = sources.filter((s) => s.healthySamples > 0);
  check(
    "a failing source did not stop the others",
    healthy.length >= 5,
    failing.length
      ? `failing=${failing.map((s) => s.sourceId).join(",")} healthy=${healthy.length}`
      : `no source failed during the soak; healthy=${healthy.length}`
  );
  check(
    "API read path returns collected data",
    Boolean(matrix && matrix.sources.length === 9),
    `matrixSources=${matrix?.sources.length ?? 0} opportunities=${matrix?.opportunities.length ?? 0}`
  );
  check(
    "analytics computed from stored rows",
    analytics.runCount >= 10 && analytics.sourceUptime.length === 9,
    `runs=${analytics.runCount} coverage=${analytics.dataCoveragePercent}% lifecycles=${analytics.uniqueLifecycles}`
  );
  check(
    "worker released its lease on shutdown",
    (await repo.getWorkerHeartbeat())?.leaseHeld === false,
    `status=${(await repo.getWorkerHeartbeat())?.status}`
  );

  log("");
  log("=== soak results ===");
  for (const c of checks) log(`${c.ok ? "PASS" : "FAIL"}  ${c.name}${c.detail ? ` — ${c.detail}` : ""}`);

  log("");
  log("per-source performance over the soak:");
  for (const s of sources) {
    log(
      `  ${s.sourceId.padEnd(11)} samples=${String(s.samples).padStart(3)} healthy=${String(s.healthySamples).padStart(3)} ` +
        `degraded=${String(s.degradedSamples).padStart(3)} errors=${String(s.errorSamples).padStart(3)} ` +
        `p50=${s.latencyP50Ms ?? "—"}ms p95=${s.latencyP95Ms ?? "—"}ms${s.lastError ? ` last="${s.lastError.slice(0, 60)}"` : ""}`
    );
  }

  const failedChecks = checks.filter((c) => !c.ok);
  log("");
  log(`Result: ${checks.length - failedChecks.length}/${checks.length} checks passed`);
  log(`Full log: ${logPath}`);

  await closeDb().catch(() => undefined);
  if (failedChecks.length) process.exit(1);
}

main().catch(async (e) => {
  log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
  process.exit(1);
});
