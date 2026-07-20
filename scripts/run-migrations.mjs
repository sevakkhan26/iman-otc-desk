#!/usr/bin/env node
/**
 * Production-safe schema migrator (plain Node, no tsx).
 * Used by Docker entrypoint and CI/CD on Ubuntu.
 *
 * Env:
 *   DATABASE_URL=postgres://...   (required for real Postgres)
 *   SKIP_DB_MIGRATE=1             skip entirely
 *
 * Reads versioned SQL from drizzle/*.sql (or MIGRATIONS_DIR).
 * Idempotent via schema_meta.applied_migrations.
 * Never DROP/TRUNCATE tables.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function log(...args) {
  console.log("[db-migrate]", ...args);
}

function fail(msg) {
  console.error("[db-migrate] FATAL:", msg);
  process.exit(1);
}

async function main() {
  if (process.env.SKIP_DB_MIGRATE === "1") {
    log("SKIP_DB_MIGRATE=1 — skipping");
    return;
  }

  const url = (process.env.DATABASE_URL || "").trim();
  if (!url) {
    fail("DATABASE_URL is not set. Refusing to start without a durable database.");
  }

  // PGlite is local-dev only; this runner is for real Postgres on Ubuntu.
  if (url.startsWith("pglite:") || url === "pglite") {
    log("pglite URL detected — use: pnpm db:migrate (tsx + PGlite). Skipping SQL runner.");
    return;
  }

  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
    fail("DATABASE_URL must be a postgres:// connection string for production.");
  }

  const migrationsDir =
    process.env.MIGRATIONS_DIR?.trim() ||
    path.join(ROOT, "drizzle");

  let files;
  try {
    files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (e) {
    fail(`cannot read migrations dir ${migrationsDir}: ${e instanceof Error ? e.message : e}`);
  }

  if (!files.length) {
    fail(`no .sql files in ${migrationsDir}`);
  }

  const sql = postgres(url, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 20,
    prepare: false
  });

  try {
    log("connecting…");
    await sql`SELECT 1`;
    log("connected");

    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS schema_meta (
        key text PRIMARY KEY NOT NULL,
        value text NOT NULL,
        updated_at timestamptz DEFAULT now() NOT NULL
      );
    `);

    const rows = await sql`
      SELECT value FROM schema_meta WHERE key = 'applied_migrations' LIMIT 1
    `;
    let applied = new Set();
    if (rows[0]?.value) {
      try {
        applied = new Set(JSON.parse(rows[0].value));
      } catch {
        applied = new Set();
      }
    }

    const newly = [];
    for (const file of files) {
      if (applied.has(file)) {
        log("skip (already applied):", file);
        continue;
      }
      const full = path.join(migrationsDir, file);
      const body = await readFile(full, "utf8");
      log("applying:", file);
      // Run whole file (our migrations are IF NOT EXISTS safe)
      await sql.unsafe(body);
      applied.add(file);
      newly.push(file);
    }

    const payload = JSON.stringify([...applied].sort());
    await sql`
      INSERT INTO schema_meta (key, value, updated_at)
      VALUES ('applied_migrations', ${payload}, now())
      ON CONFLICT (key) DO UPDATE
      SET value = EXCLUDED.value, updated_at = now()
    `;

    log("done. newly applied:", newly.length ? newly.join(", ") : "(none)");
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main();
