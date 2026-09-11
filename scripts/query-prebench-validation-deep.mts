#!/usr/bin/env npx tsx
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const ART = process.env.VAL_ART_DIR ?? ".";
mkdirSync(path.join(ART, "audit"), { recursive: true });
const db = await getDbAsync();
async function q(label: string, query: ReturnType<typeof sql>) {
  try {
    const res = await db.execute(query);
    const rows = (res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []);
    console.log(JSON.stringify({ label, ok: true, n: rows.length, sample: rows.slice(0, 5) }));
    return { ok: true, rows };
  } catch (e) {
    console.log(JSON.stringify({ label, ok: false, error: e instanceof Error ? e.message : String(e) }));
    return { ok: false, rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}

const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), queries: {} as Record<string, unknown> };

(out.queries as Record<string, unknown>)["lifecycle_edge_stats"] = await q(
  "lifecycle_edge_stats",
  sql`SELECT count(*)::int AS n,
    count(*) FILTER (WHERE raw_spread_percent::float8 > 0)::int AS pos_raw,
    count(*) FILTER (WHERE net_edge_percent::float8 > 0)::int AS pos_net,
    count(*) FILTER (WHERE max_net_edge_percent::float8 > 0)::int AS ever_pos_net,
    max(raw_spread_percent::float8) AS max_raw,
    max(net_edge_percent::float8) AS max_net,
    max(max_net_edge_percent::float8) AS max_ever_net
  FROM shadow_opportunity_lifecycles`
);

(out.queries as Record<string, unknown>)["top_raw_lifecycles"] = await q(
  "top_raw_lifecycles",
  sql`SELECT id::text, route_key, raw_spread_percent::float8 AS raw_pct,
    net_edge_percent::float8 AS net_pct, max_net_edge_percent::float8 AS max_net_pct,
    status, first_seen_at::text, last_seen_at::text
  FROM shadow_opportunity_lifecycles
  ORDER BY raw_spread_percent::float8 DESC NULLS LAST
  LIMIT 20`
);

(out.queries as Record<string, unknown>)["candidate_reasons_full"] = await q(
  "candidate_reasons_full",
  sql`SELECT coalesce(primary_reason,'__NULL__') AS reason, outcome, count(*)::int AS n,
    sum(occurrences)::int AS sum_occ
  FROM shadow_paper_candidate_state GROUP BY 1,2 ORDER BY n DESC`
);

(out.queries as Record<string, unknown>)["ledger_reasons_full"] = await q(
  "ledger_reasons_full",
  sql`SELECT outcome, coalesce(rejection_code,'__NULL__') AS code, count(*)::int AS n
  FROM shadow_paper_ledger GROUP BY 1,2 ORDER BY n DESC`
);

(out.queries as Record<string, unknown>)["decision_trace_cols"] = await q(
  "decision_trace_cols",
  sql`SELECT column_name, data_type FROM information_schema.columns
  WHERE table_name = 'shadow_paper_decision_traces' ORDER BY ordinal_position`
);

(out.queries as Record<string, unknown>)["banned_check"] = await q(
  "banned_check",
  sql`SELECT count(*)::int AS banned_or_null
  FROM shadow_paper_candidate_state
  WHERE primary_reason IS NULL OR primary_reason IN ('sizing_blocked','unknown')`
);

(out.queries as Record<string, unknown>)["banned_ledger"] = await q(
  "banned_ledger",
  sql`SELECT count(*)::int AS banned_or_null
  FROM shadow_paper_ledger
  WHERE outcome='SKIPPED' AND (rejection_code IS NULL OR rejection_code IN ('sizing_blocked','unknown'))`
);

(out.queries as Record<string, unknown>)["cycle_summaries"] = await q(
  "cycle_summaries",
  sql`SELECT * FROM shadow_paper_cycle_summaries ORDER BY created_at DESC LIMIT 3`
);

(out.queries as Record<string, unknown>)["cycle_summaries_cols"] = await q(
  "cycle_summaries_cols",
  sql`SELECT column_name FROM information_schema.columns WHERE table_name='shadow_paper_cycle_summaries'`
);

writeFileSync(path.join(ART, "audit", "validation-deep.json"), JSON.stringify(out, null, 2) + "\n");
console.log("WROTE deep audit");
await closeDb();
