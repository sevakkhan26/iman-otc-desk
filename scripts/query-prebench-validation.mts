#!/usr/bin/env npx tsx
/**
 * Step 6 bounded real-market validation queries (read-only).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const ART = process.env.VAL_ART_DIR ?? path.resolve(".");
mkdirSync(path.join(ART, "audit"), { recursive: true });

const db = await getDbAsync();
async function q(label: string, query: ReturnType<typeof sql>) {
  try {
    const res = await db.execute(query);
    const rows = (res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []);
    return { ok: true, label, rows };
  } catch (e) {
    return { ok: false, label, error: e instanceof Error ? e.message : String(e), rows: [] };
  }
}

const queries: Array<[string, ReturnType<typeof sql>]> = [
  ["paper_sessions", sql`SELECT id::text, status, mode, total_capital_toman::text,
      started_at::text, stopped_at::text, cycles_evaluated, trades_executed, candidates_skipped,
      last_cycle_at::text
    FROM shadow_paper_sessions ORDER BY created_at DESC LIMIT 5`],
  ["cycle_stats", sql`SELECT count(*)::int AS cycles,
      min(started_at)::text AS first_cycle, max(started_at)::text AS last_cycle,
      count(*) FILTER (WHERE status = 'COMPLETED' OR completed_at IS NOT NULL)::int AS completedish
    FROM shadow_collection_runs`],
  ["fills", sql`SELECT id::text, lifecycle_id::text, route_key, size_usdt::float8,
      decision_trace_id::text,
      detection_snapshot_ref, arrival_snapshot_ref, allocator_decision_ref,
      liquidity_consumption_evidence,
      occurred_at::text, outcome, rejection_code
    FROM shadow_paper_ledger WHERE outcome = 'FILLED' ORDER BY occurred_at`],
  ["fill_decision_trace_nulls", sql`SELECT count(*)::int AS n
    FROM shadow_paper_ledger WHERE outcome = 'FILLED' AND decision_trace_id IS NULL`],
  ["unfilled_net_positive_reasons", sql`SELECT lc.id::text, lc.route_key,
      lc.net_edge_percent::float8 AS net_pct,
      lc.max_net_edge_percent::float8 AS max_net_pct,
      cs.outcome, cs.primary_reason, cs.occurrences
    FROM shadow_opportunity_lifecycles lc
    JOIN shadow_paper_candidate_state cs ON cs.lifecycle_id = lc.id
    WHERE (lc.net_edge_percent::float8 > 0 OR lc.max_net_edge_percent::float8 > 0)
      AND cs.outcome = 'SKIPPED'
    ORDER BY lc.max_net_edge_percent::float8 DESC NULLS LAST
    LIMIT 200`],
  ["reject_histogram", sql`SELECT coalesce(primary_reason, '__NULL__') AS reason, count(*)::int AS n
    FROM shadow_paper_candidate_state GROUP BY 1 ORDER BY n DESC`],
  ["banned_terminals", sql`SELECT coalesce(rejection_code, '__NULL__') AS code, count(*)::int AS n
    FROM shadow_paper_ledger
    WHERE outcome = 'SKIPPED'
      AND (rejection_code IS NULL OR rejection_code IN ('sizing_blocked','unknown'))
    GROUP BY 1`],
  ["residual_liquidity_rows", sql`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE state = 'ACTIVE')::int AS active,
      count(*) FILTER (WHERE outstanding_consumed_micros > 0)::int AS with_outstanding
    FROM shadow_paper_residual_liquidity`],
  ["residual_liquidity_sample", sql`SELECT id::text, paper_session_id::text, venue_id, symbol, side,
      price_level_key, price_toman,
      outstanding_consumed_micros, lifetime_consumed_micros, lifetime_released_micros,
      last_raw_displayed_micros, last_seen_snapshot_generation, last_seen_book_hash, state
    FROM shadow_paper_residual_liquidity ORDER BY updated_at DESC NULLS LAST LIMIT 50`],
  ["residual_events", sql`SELECT count(*)::int AS n,
      count(DISTINCT idempotency_key)::int AS distinct_idem,
      count(*) FILTER (WHERE event_kind ILIKE '%CONSUME%' OR event_kind ILIKE '%consume%')::int AS consumes,
      count(*) FILTER (WHERE event_kind ILIKE '%RELEASE%' OR event_kind ILIKE '%release%')::int AS releases
    FROM shadow_paper_residual_liquidity_events`],
  ["residual_events_by_kind", sql`SELECT event_kind, count(*)::int AS n
    FROM shadow_paper_residual_liquidity_events GROUP BY 1 ORDER BY n DESC`],
  ["residual_event_dupes", sql`SELECT idempotency_key, count(*)::int AS n
    FROM shadow_paper_residual_liquidity_events
    GROUP BY 1 HAVING count(*) > 1 LIMIT 20`],
  ["ledger_dup_fills", sql`SELECT lifecycle_id::text, route_key, count(*)::int AS n
    FROM shadow_paper_ledger WHERE outcome = 'FILLED'
    GROUP BY 1,2 HAVING count(*) > 1 LIMIT 20`],
  ["net_positive_lifecycles", sql`SELECT count(*)::int AS n,
      count(*) FILTER (WHERE max_net_edge_percent::float8 > 0)::int AS ever_pos_net,
      count(*) FILTER (WHERE net_edge_percent::float8 > 0)::int AS pos_net_end
    FROM shadow_opportunity_lifecycles`],
  ["candidate_lifecycle_sample", sql`SELECT cs.lifecycle_id::text, cs.route_key, cs.outcome,
      cs.primary_reason, cs.occurrences,
      lc.net_edge_percent::float8, lc.max_net_edge_percent::float8
    FROM shadow_paper_candidate_state cs
    LEFT JOIN shadow_opportunity_lifecycles lc ON lc.id = cs.lifecycle_id
    WHERE lc.max_net_edge_percent::float8 > 0 OR cs.outcome = 'FILLED'
    ORDER BY lc.max_net_edge_percent::float8 DESC NULLS LAST
    LIMIT 100`],
  ["decision_traces", sql`SELECT count(*)::int AS n FROM shadow_paper_decision_traces`],
  ["ledger_skip_sample", sql`SELECT rejection_code, count(*)::int AS n
    FROM shadow_paper_ledger WHERE outcome = 'SKIPPED' GROUP BY 1 ORDER BY n DESC LIMIT 40`],
  ["repeated_route_candidates", sql`SELECT route_key, count(*)::int AS n,
      count(*) FILTER (WHERE outcome = 'FILLED')::int AS fills,
      count(*) FILTER (WHERE outcome = 'SKIPPED')::int AS skips
    FROM shadow_paper_ledger
    GROUP BY 1 HAVING count(*) > 1
    ORDER BY n DESC LIMIT 30`],
];

const out: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  databaseUrl: (process.env.DATABASE_URL ?? "").slice(0, 160),
  queries: {} as Record<string, unknown>,
};

for (const [label, query] of queries) {
  const r = await q(label, query);
  (out.queries as Record<string, unknown>)[label] = r;
  console.log(JSON.stringify({ label, ok: r.ok, rowCount: Array.isArray(r.rows) ? r.rows.length : 0, error: (r as {error?: string}).error, sample: Array.isArray(r.rows) ? r.rows.slice(0, 2) : null }));
}

writeFileSync(path.join(ART, "audit", "validation-queries.json"), JSON.stringify(out, null, 2) + "\n");
console.log("WROTE", path.join(ART, "audit", "validation-queries.json"));
await closeDb();
