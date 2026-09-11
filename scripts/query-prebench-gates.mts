#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const out = process.env.OUT ?? "";
const db = await getDbAsync();
const R: Record<string, unknown> = { at: new Date().toISOString() };
async function q(label: string, query: ReturnType<typeof sql>) {
  try {
    const r = await db.execute(query);
    const rows = (r as { rows?: unknown[] }).rows ?? (Array.isArray(r) ? r : []);
    R[label] = { ok: true, rows };
    return rows as Array<Record<string, unknown>>;
  } catch (e) {
    R[label] = { ok: false, error: e instanceof Error ? e.message : String(e) };
    return [];
  }
}
try {
  await q("select1", sql`SELECT 1::int AS one`);
  await q(
    "session",
    sql`SELECT id::text, status, mode, observation_id::text, total_capital_toman::text,
      cycles_evaluated, trades_executed, candidates_skipped,
      started_at::text, last_cycle_at::text, policy_fingerprint
      FROM shadow_paper_sessions ORDER BY created_at DESC LIMIT 1`
  );
  await q(
    "runs",
    sql`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE completed_at IS NOT NULL)::int AS completed,
      min(started_at)::text AS first_at, max(started_at)::text AS last_at
      FROM shadow_collection_runs`
  );
  await q(
    "orphan_success",
    sql`SELECT count(*)::int AS n FROM shadow_collection_runs
      WHERE status = 'SUCCESS' AND id NOT IN (SELECT DISTINCT run_id FROM shadow_source_snapshots WHERE run_id IS NOT NULL)`
  ).catch(() => []);
  // snapshots / counters
  await q(
    "snapshot_counts",
    sql`SELECT count(*)::int AS snapshots FROM shadow_source_snapshots`
  );
  await q(
    "banned",
    sql`SELECT count(*)::int AS n FROM shadow_paper_ledger
      WHERE outcome = 'SKIPPED' AND (rejection_code IS NULL OR rejection_code IN ('sizing_blocked','unknown'))`
  );
  await q(
    "leg_risk_open",
    sql`SELECT count(*)::int AS n FROM shadow_paper_sessions WHERE status = 'PAUSED'`
  );
  await q(
    "fill_null_trace",
    sql`SELECT count(*)::int AS n FROM shadow_paper_ledger WHERE outcome = 'FILLED' AND decision_trace_id IS NULL`
  );
  await q(
    "exact_skip_reasons",
    sql`SELECT rejection_code, count(*)::int AS n FROM shadow_paper_ledger
      WHERE outcome = 'SKIPPED' GROUP BY 1 ORDER BY n DESC`
  );
  await q(
    "decision_traces",
    sql`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE trace_complete)::int AS complete,
      count(*) FILTER (WHERE observation_id IS NOT NULL)::int AS with_obs,
      count(*) FILTER (WHERE experiment_id IS NOT NULL)::int AS with_exp
      FROM shadow_paper_decision_traces`
  );
  await q(
    "candidate_detail",
    sql`SELECT cs.lifecycle_id::text, cs.route_key, cs.outcome, cs.primary_reason,
      lc.net_edge_percent::float8, lc.max_net_edge_percent::float8
      FROM shadow_paper_candidate_state cs
      LEFT JOIN shadow_opportunity_lifecycles lc ON lc.id = cs.lifecycle_id
      WHERE lc.max_net_edge_percent::float8 > 0
      ORDER BY lc.max_net_edge_percent::float8 DESC NULLS LAST LIMIT 20`
  );
  // PGlite write failure / worker markers checked outside
  R.ok = true;
} catch (e) {
  R.ok = false;
  R.error = e instanceof Error ? e.message : String(e);
} finally {
  await closeDb();
}
const text = JSON.stringify(R, null, 2) + "\n";
console.log(text);
if (out) writeFileSync(out, text);
