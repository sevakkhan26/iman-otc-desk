#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const outPath = process.env.VERIFY_OUT ?? "";
const db = await getDbAsync();
const result: Record<string, unknown> = {
  openedAt: new Date().toISOString(),
  databaseUrl: (process.env.DATABASE_URL ?? "").slice(0, 160),
  queries: {} as Record<string, unknown>,
};
let ok = true;
async function q(label: string, query: ReturnType<typeof sql>) {
  try {
    const r = await db.execute(query);
    const rows = (r as { rows?: unknown[] }).rows ?? (Array.isArray(r) ? r : []);
    (result.queries as Record<string, unknown>)[label] = { ok: true, rows };
    return rows;
  } catch (e) {
    ok = false;
    (result.queries as Record<string, unknown>)[label] = {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
    return [];
  }
}

try {
  // First probe: trivial SELECT — proves checkpoint is valid
  await q("select_1", sql`SELECT 1::int AS one`);
  await q("paper_sessions", sql`SELECT id::text, status, mode, cycles_evaluated, trades_executed, candidates_skipped, started_at::text, last_cycle_at::text FROM shadow_paper_sessions`);
  await q("collection_runs", sql`SELECT count(*)::int AS n, min(started_at)::text AS first_at, max(started_at)::text AS last_at FROM shadow_collection_runs`);
  await q("residual_count", sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE outstanding_consumed_micros > 0)::int AS outstanding FROM shadow_paper_residual_liquidity`);
  result.ok = ok && !!(result.queries as Record<string, {ok:boolean}>).select_1?.ok;
  result.checkpointValid = !!(result.queries as Record<string, {ok:boolean}>).select_1?.ok;
} catch (e) {
  result.ok = false;
  result.checkpointValid = false;
  result.fatal = e instanceof Error ? (e.stack ?? e.message) : String(e);
  process.exitCode = 1;
} finally {
  await closeDb();
}
const text = JSON.stringify(result, null, 2) + "\n";
console.log(text);
if (outPath) writeFileSync(outPath, text);
if (!result.ok) process.exitCode = 1;
