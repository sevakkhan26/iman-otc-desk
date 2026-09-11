#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";
const out = process.env.OUT ?? "";
const db = await getDbAsync();
const R: Record<string, unknown> = {};
async function q(label: string, query: ReturnType<typeof sql>) {
  try {
    const r = await db.execute(query);
    R[label] = { ok: true, rows: (r as { rows?: unknown[] }).rows ?? r };
  } catch (e) {
    R[label] = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
await q("session", sql`SELECT id::text, status, mode, observation_id::text, total_capital_toman::text,
  cycles_evaluated, trades_executed, candidates_skipped, started_at::text, last_cycle_at::text
  FROM shadow_paper_sessions ORDER BY created_at DESC LIMIT 1`);
await q("session_cols", sql`SELECT column_name FROM information_schema.columns WHERE table_name='shadow_paper_sessions' ORDER BY 1`);
await q("runs_cols", sql`SELECT column_name FROM information_schema.columns WHERE table_name='shadow_collection_runs' ORDER BY 1`);
await q("runs", sql`SELECT count(*)::int AS n, min(started_at)::text AS first_at, max(started_at)::text AS last_at FROM shadow_collection_runs`);
await q("trace_fp", sql`SELECT policy_fingerprint, deployment_version, observation_id::text, experiment_id::text, paper_session_id::text
  FROM shadow_paper_decision_traces ORDER BY occurred_at DESC LIMIT 3`);
await q("obs", sql`SELECT id::text, status, started_at::text FROM shadow_observations ORDER BY created_at DESC LIMIT 5`);
await closeDb();
const text = JSON.stringify(R, null, 2)+"\n";
console.log(text);
if (out) writeFileSync(out, text);
