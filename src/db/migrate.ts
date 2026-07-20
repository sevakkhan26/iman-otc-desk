/**
 * Apply versioned SQL migrations from /drizzle.
 * Usage: DATABASE_URL=pglite:.data/pglite pnpm db:migrate
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { closeDb, execRaw, getDatabaseUrl, getDbAsync, isPgliteUrl, pingDatabase } from "@/db/client";

async function ensureMeta(): Promise<void> {
  await execRaw(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key text PRIMARY KEY NOT NULL,
      value text NOT NULL,
      updated_at timestamp with time zone DEFAULT now() NOT NULL
    );
  `);
}

async function getApplied(): Promise<Set<string>> {
  try {
    await ensureMeta();
    // Use a simple SELECT via execRaw-compatible path
    const { sql } = await import("drizzle-orm");
    const db = await getDbAsync();
    const result = await db.execute(
      sql`SELECT value FROM schema_meta WHERE key = 'applied_migrations'`
    );
    // drizzle/postgres-js returns array-like; pglite may differ
    const rows = Array.isArray(result)
      ? result
      : (((result as unknown as { rows?: Array<Record<string, unknown>> }).rows) ?? []);
    const first = rows[0] as { value?: string } | undefined;
    const value = first?.value ?? "[]";
    try {
      return new Set(JSON.parse(value) as string[]);
    } catch {
      return new Set();
    }
  } catch {
    return new Set();
  }
}

async function setApplied(names: string[]): Promise<void> {
  const payload = JSON.stringify(names);
  await execRaw(`
    INSERT INTO schema_meta (key, value, updated_at)
    VALUES ('applied_migrations', '${payload.replace(/'/g, "''")}', now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
  `);
}

function prepareSql(sqlText: string, pglite: boolean): string {
  let out = sqlText;
  if (pglite) {
    // PGlite may not have gen_random_uuid in older builds
    out = out.replace(/DEFAULT gen_random_uuid\(\)/g, "");
  }
  return out;
}

export async function runMigrations(): Promise<{ applied: string[]; skipped: string[] }> {
  const url = getDatabaseUrl();
  const pglite = isPgliteUrl(url);
  // Ensure connection
  await getDbAsync();
  await pingDatabase();
  await ensureMeta();

  const dir = path.join(process.cwd(), "drizzle");
  const files = (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const appliedSet = await getApplied();
  const newly: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    if (appliedSet.has(file)) {
      skipped.push(file);
      continue;
    }
    const raw = await readFile(path.join(dir, file), "utf8");
    const sqlText = prepareSql(raw, pglite);
    await execRaw(sqlText);
    appliedSet.add(file);
    newly.push(file);
  }

  await setApplied([...appliedSet].sort());
  return { applied: newly, skipped };
}

async function main() {
  try {
    console.log("DATABASE_URL mode:", getDatabaseUrl().split(":")[0]);
    const result = await runMigrations();
    console.log("Migrations applied:", result.applied);
    console.log("Already present:", result.skipped);
    await pingDatabase();
    console.log("Database ping OK");
  } finally {
    await closeDb();
  }
}

const isMain =
  typeof process.argv[1] === "string" &&
  (process.argv[1].includes("migrate") || process.argv[1].endsWith("migrate.ts"));
if (isMain) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
