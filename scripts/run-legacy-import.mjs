#!/usr/bin/env node
/**
 * Optional one-shot legacy JSON → Postgres import for production container start.
 *
 * Only runs when AUTO_IMPORT_LEGACY=1 (or RUN_LEGACY_IMPORT=1).
 * Prefer the full tsx importer when host has the git tree:
 *   ./scripts/production-pg-setup.sh
 *
 * This lightweight runner shells out is NOT used if tsx unavailable —
 * entrypoint will try host-style import via node only when flag set and
 * scripts/import is available with tsx; otherwise logs and continues after schema migrate.
 *
 * For Docker production cutover, set once:
 *   AUTO_IMPORT_LEGACY=1
 * then remove after first successful boot.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function log(...a) {
  console.log("[legacy-import]", ...a);
}

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const flag =
    process.env.AUTO_IMPORT_LEGACY === "1" || process.env.RUN_LEGACY_IMPORT === "1";
  if (!flag) {
    log("skipped (set AUTO_IMPORT_LEGACY=1 once to import JSON → Postgres)");
    return;
  }

  if (!process.env.DATABASE_URL?.trim()) {
    log("FATAL: DATABASE_URL required for import");
    process.exit(1);
  }

  const importerTs = path.join(ROOT, "scripts", "import-legacy-to-postgres.mts");
  if (!(await exists(importerTs))) {
    log("import script not in image — run on host: ./scripts/production-pg-setup.sh");
    process.exit(0);
  }

  // Prefer pnpm exec tsx / npx tsx when available (full checkout deploys)
  const tries = [
    ["pnpm", ["exec", "tsx", importerTs, "--skip-migrate"]],
    ["npx", ["--yes", "tsx", importerTs, "--skip-migrate"]]
  ];

  for (const [cmd, args] of tries) {
    const r = spawnSync(cmd, args, {
      cwd: ROOT,
      env: process.env,
      stdio: "inherit"
    });
    if (r.error && r.error.code === "ENOENT") continue;
    if (r.status === 0) {
      log("import finished OK");
      process.exit(0);
    }
    log("import failed with", cmd, "status", r.status);
    process.exit(r.status || 1);
  }

  log("tsx not available in this image — run import on the host after migrate");
  process.exit(0);
}

main();
