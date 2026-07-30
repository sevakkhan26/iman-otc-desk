#!/usr/bin/env npx tsx
/**
 * `pnpm shadow:local` — one command for the whole local Shadow Arbitrage setup.
 *
 * It starts the Next.js app AND the collector, from a single terminal, and one
 * Ctrl+C stops everything cleanly:
 *
 *   1. identifies whatever holds port 3000 and only stops it if it belongs to
 *      this project (including the launchd KeepAlive agent, which is restored
 *      on exit so the always-on server comes back);
 *   2. runs database migrations and fails loudly if they cannot be applied;
 *   3. builds into an ISOLATED dist dir (.next-local) so it can never corrupt
 *      the `.next` build the launchd server serves;
 *   4. starts the app, and the collector alongside it;
 *   5. streams prefixed [app] / [worker] logs;
 *   6. forwards SIGINT/SIGTERM to every child and waits for a clean exit.
 *
 * Collector placement depends on the database, because PGlite has exactly one
 * safe writer per data directory (two processes silently lose writes):
 *   • PGlite   → collector runs inside the app process via instrumentation.ts
 *   • Postgres → collector runs as a separate `shadow-worker` child process
 *
 * Read-only with respect to exchanges. No credentials, orders, or transfers.
 *
 * Env:
 *   SHADOW_POLL_MS         collector interval (15000–300000, default 30000)
 *   SHADOW_LOCAL_PORT      app port (default 3000)
 *   SHADOW_LOCAL_DIST      isolated dist dir (default .next-local)
 *   SHADOW_LOCAL_SKIP_BUILD=1  reuse the existing isolated build as-is
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLocalEnv } from "./load-env.mts";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// Give this script the same environment the Next app sees (.env.local → .env)
// before anything reads DATABASE_URL. Must run before importing the db client.
const loadedEnvFiles = loadLocalEnv(repoRoot);

const { getDatabaseUrl, isPgliteUrl, closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
const { pollIntervalFromEnv } = await import("../src/lib/shadowArbitrage/config.ts");
const PORT = Number(process.env.SHADOW_LOCAL_PORT ?? 3000) || 3000;
const HOST = "127.0.0.1";
const DIST = process.env.SHADOW_LOCAL_DIST ?? ".next-local";
const LAUNCHD_LABEL = "net.blumarkets.otcdesk";

const PID_FILE = path.join(repoRoot, ".data", "shadow-local.pid");

const children: Array<{ name: string; child: ChildProcess }> = [];
let launchdWasLoaded = false;
let shuttingDown = false;
let pidFileOwned = false;

function stamp(): string {
  return new Date().toISOString().slice(11, 19);
}

function log(scope: string, message: string) {
  console.log(`${stamp()} [${scope}] ${message}`);
}

function fail(message: string): never {
  console.error(`\n${stamp()} [shadow:local] FAILED — ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

function sh(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** Pipe a child's output through a prefixed logger, line by line. */
function pipeLogs(scope: string, child: ChildProcess) {
  const emit = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      const text = line.trimEnd();
      if (!text) continue;
      // Collector lines already identify themselves; route them to [worker].
      const target = text.includes("[shadow-worker") ? "worker" : scope;
      console.log(`${stamp()} [${target}] ${text.replace(/^\[shadow-worker [^\]]+\]\s*/, "")}`);
    }
  };
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
}

/* ── single-instance guard ────────────────────────────────────────────────── */

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse to run twice. Without this, a second `shadow:local` would see port
 * 3000 held by "this project" and terminate the first one.
 */
function claimSingleInstance(): void {
  if (existsSync(PID_FILE)) {
    const existing = Number(readFileSync(PID_FILE, "utf8").trim());
    if (Number.isFinite(existing) && existing > 0 && pidAlive(existing)) {
      fail(
        `shadow:local is already running (pid ${existing}). Stop it with Ctrl+C in its terminal, ` +
          `or \`kill ${existing}\`. Nothing was changed.`
      );
    }
    log("shadow:local", "clearing a stale pidfile from a previous run");
  }
  mkdirSync(path.dirname(PID_FILE), { recursive: true });
  writeFileSync(PID_FILE, `${process.pid}\n`, "utf8");
  pidFileOwned = true;
}

function releaseSingleInstance(): void {
  if (!pidFileOwned) return;
  try {
    rmSync(PID_FILE, { force: true });
  } catch {
    /* ignore */
  }
  pidFileOwned = false;
}

/* ── port 3000 ownership ──────────────────────────────────────────────────── */

type PortOwner = { pid: number; command: string; cwd: string | null };

function portOwner(port: number): PortOwner | null {
  const { out } = sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
  const pid = Number(out.split("\n")[0]);
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const command = sh("ps", ["-o", "command=", "-p", String(pid)]).out;
  const cwdOut = sh("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]).out;
  const cwdLine = cwdOut.split("\n").find((l) => l.startsWith("n"));
  return { pid, command, cwd: cwdLine ? cwdLine.slice(1) : null };
}

function launchdLoaded(): boolean {
  const uid = process.getuid?.() ?? 501;
  return sh("launchctl", ["print", `gui/${uid}/${LAUNCHD_LABEL}`]).code === 0;
}

function launchdBootout(): boolean {
  const uid = process.getuid?.() ?? 501;
  const r = sh("launchctl", ["bootout", `gui/${uid}/${LAUNCHD_LABEL}`]);
  return r.code === 0;
}

function launchdBootstrap(): boolean {
  const uid = process.getuid?.() ?? 501;
  const plist = path.join(
    process.env.HOME ?? "",
    "Library/LaunchAgents",
    `${LAUNCHD_LABEL}.plist`
  );
  if (!existsSync(plist)) return false;
  return sh("launchctl", ["bootstrap", `gui/${uid}`, plist]).code === 0;
}

async function waitForPortFree(port: number, timeoutMs = 20_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!portOwner(port)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return !portOwner(port);
}

/**
 * Free the port, but only if the holder is this project. Anything else is left
 * strictly alone and reported as a blocker.
 */
async function ensurePortAvailable(): Promise<void> {
  const owner = portOwner(PORT);
  if (!owner) {
    log("shadow:local", `port ${PORT} is free`);
    return;
  }

  const belongsToProject =
    (owner.cwd !== null && path.resolve(owner.cwd) === path.resolve(repoRoot)) ||
    owner.command.includes(repoRoot);

  log("shadow:local", `port ${PORT} held by pid ${owner.pid} (${owner.command || "unknown"})`);
  log("shadow:local", `  cwd: ${owner.cwd ?? "unknown"}`);

  if (!belongsToProject) {
    fail(
      `port ${PORT} is used by a process that does not belong to this project ` +
        `(pid ${owner.pid}, cwd ${owner.cwd ?? "unknown"}). Nothing was stopped. ` +
        `Free the port or set SHADOW_LOCAL_PORT.`
    );
  }

  // The launchd agent respawns the server, so it must be booted out first.
  if (launchdLoaded()) {
    launchdWasLoaded = true;
    log("shadow:local", `stopping launchd agent ${LAUNCHD_LABEL} (restored automatically on exit)`);
    if (!launchdBootout()) log("shadow:local", "  bootout reported an error — continuing");
  }

  const stillThere = portOwner(PORT);
  if (stillThere) {
    log("shadow:local", `sending SIGTERM to pid ${stillThere.pid} (this project's server)`);
    try {
      process.kill(stillThere.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }

  if (!(await waitForPortFree(PORT))) {
    fail(`port ${PORT} did not become free. Nothing else was changed.`);
  }
  log("shadow:local", `port ${PORT} released`);
}

/* ── isolated build ───────────────────────────────────────────────────────── */

async function newestSourceMtime(): Promise<number> {
  const roots = ["app", "src", "package.json", "next.config.ts", "instrumentation.ts"];
  let newest = 0;
  const walk = async (target: string): Promise<void> => {
    const full = path.join(repoRoot, target);
    if (!existsSync(full)) return;
    const st = statSync(full);
    if (st.isFile()) {
      newest = Math.max(newest, st.mtimeMs);
      return;
    }
    for (const entry of await readdir(full, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      await walk(path.join(target, entry.name));
    }
  };
  for (const r of roots) await walk(r);
  return newest;
}

/**
 * Build into the isolated dist dir when it is missing or stale.
 * `.next` is never touched, so an active launchd server keeps serving its own
 * build while this one is produced.
 */
async function ensureIsolatedBuild(): Promise<void> {
  const buildIdPath = path.join(repoRoot, DIST, "BUILD_ID");
  const skip = process.env.SHADOW_LOCAL_SKIP_BUILD === "1";

  if (existsSync(buildIdPath)) {
    if (skip) {
      log("shadow:local", `reusing existing build in ${DIST} (SHADOW_LOCAL_SKIP_BUILD=1)`);
      return;
    }
    const builtAt = statSync(buildIdPath).mtimeMs;
    const newest = await newestSourceMtime();
    if (builtAt >= newest) {
      log("shadow:local", `build in ${DIST} is current — skipping rebuild`);
      return;
    }
    log("shadow:local", `source is newer than ${DIST}/BUILD_ID — rebuilding`);
  } else {
    log("shadow:local", `no build in ${DIST} — building (first run takes a moment)`);
  }

  const r = spawnSync("npx", ["next", "build"], {
    cwd: repoRoot,
    env: { ...process.env, OTC_NEXT_DIST: DIST },
    stdio: "inherit"
  });
  if (r.status !== 0) {
    fail(`isolated production build into ${DIST} failed (exit ${r.status}). \`.next\` was not touched.`);
  }
  if (!existsSync(buildIdPath)) fail(`build finished but ${DIST}/BUILD_ID is missing`);
  log("shadow:local", `build ready in ${DIST}`);
}

/* ── readiness ────────────────────────────────────────────────────────────── */

async function waitForApp(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://${HOST}:${PORT}/login`;
  while (Date.now() < deadline) {
    if (children.some((c) => c.child.exitCode !== null)) {
      fail("the app process exited before it became ready — see the [app] logs above");
    }
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.status < 500) {
        log("shadow:local", `app is ready → http://${HOST}:${PORT}`);
        return;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 700));
  }
  fail(`app did not respond on http://${HOST}:${PORT} within ${Math.round(timeoutMs / 1000)}s`);
}

/* ── shutdown ─────────────────────────────────────────────────────────────── */

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("");
  log("shadow:local", `${reason} — stopping ${children.length} process(es)`);

  for (const { name, child } of children) {
    if (child.exitCode === null && child.pid) {
      log("shadow:local", `  SIGTERM → ${name} (pid ${child.pid})`);
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
    }
  }

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && children.some((c) => c.child.exitCode === null)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  for (const { name, child } of children) {
    if (child.exitCode === null && child.pid) {
      log("shadow:local", `  ${name} did not exit — SIGKILL`);
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }

  if (launchdWasLoaded) {
    log("shadow:local", `restoring launchd agent ${LAUNCHD_LABEL}`);
    log("shadow:local", launchdBootstrap() ? "  restored" : "  could not restore — start it from /config if needed");
  }

  await closeDb().catch(() => undefined);
  releaseSingleInstance();
  log("shadow:local", "stopped cleanly");
}

/* ── main ─────────────────────────────────────────────────────────────────── */

async function main() {
  console.log("");
  log("shadow:local", "Shadow Arbitrage — unified local environment");
  log("shadow:local", "SHADOW MODE — NO REAL ORDERS OR FUND TRANSFERS");
  if (loadedEnvFiles.length) log("shadow:local", `env loaded from ${loadedEnvFiles.join(", ")}`);

  let databaseUrl: string;
  try {
    databaseUrl = getDatabaseUrl();
  } catch (e) {
    fail(e instanceof Error ? e.message : "DATABASE_URL is not set");
  }
  const pglite = isPgliteUrl(databaseUrl);
  const pollMs = pollIntervalFromEnv();
  log("shadow:local", `database: ${pglite ? "PGlite" : "PostgreSQL"} (${databaseUrl.split("://")[0]})`);
  log(
    "shadow:local",
    pglite
      ? "collector runs inside the app process (PGlite allows one writer per data dir)"
      : "collector runs as a separate worker process"
  );
  log("shadow:local", `collector interval: ${pollMs}ms`);

  claimSingleInstance();
  await ensurePortAvailable();

  // Migrations before anything starts, so a schema problem is obvious.
  try {
    const migrated = await runMigrations();
    log(
      "shadow:local",
      migrated.applied.length
        ? `migrations applied: ${migrated.applied.join(", ")}`
        : `migrations already current (${migrated.skipped.length} present)`
    );
  } catch (e) {
    fail(`database migrations failed: ${e instanceof Error ? e.message : e}`);
  }
  // Release our own handle so the app process is the sole PGlite owner.
  await closeDb().catch(() => undefined);

  await ensureIsolatedBuild();

  const app = spawn("npx", ["next", "start", "-H", HOST, "-p", String(PORT)], {
    cwd: repoRoot,
    env: {
      ...process.env,
      OTC_NEXT_DIST: DIST,
      SHADOW_POLL_MS: String(pollMs),
      // On PGlite the app process hosts the collector; otherwise it stays idle.
      ...(pglite ? { SHADOW_COLLECTOR_ENABLED: "true" } : {})
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  children.push({ name: "app", child: app });
  pipeLogs("app", app);
  app.on("exit", (code, signal) => {
    log("shadow:local", `app exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
    if (!shuttingDown) void shutdown("app exited");
  });

  await waitForApp();

  const inProcess =
    pglite || /^(true|1|yes)$/i.test(process.env.SHADOW_COLLECTOR_ENABLED ?? "");
  if (!inProcess) {
    const worker = spawn("npx", ["--yes", "tsx", "scripts/shadow-worker.mts"], {
      cwd: repoRoot,
      env: { ...process.env, SHADOW_POLL_MS: String(pollMs) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    children.push({ name: "worker", child: worker });
    pipeLogs("worker", worker);
    worker.on("exit", (code, signal) => {
      log("shadow:local", `worker exited (code ${code ?? "null"}, signal ${signal ?? "none"})`);
      if (!shuttingDown) void shutdown("worker exited");
    });
  }

  console.log("");
  log("shadow:local", `app       → http://${HOST}:${PORT}`);
  log("shadow:local", `dashboard → http://${HOST}:${PORT}/shadow-arbitrage  (admin only)`);
  log("shadow:local", "collector → running; cycles appear below as [worker] lines");
  log("shadow:local", "press Ctrl+C once to stop everything");
  console.log("");

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Stay alive until every child is gone.
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (children.every((c) => c.child.exitCode !== null)) {
        clearInterval(timer);
        resolve();
      }
    }, 500);
  });
}

main().catch(async (e) => {
  if (!shuttingDown) await shutdown("fatal error");
  const msg = e instanceof Error ? e.message : String(e);
  if (!/FAILED/.test(msg)) console.error(`${stamp()} [shadow:local] ${msg}`);
  process.exit(process.exitCode === 0 ? 1 : (process.exitCode ?? 1));
});
