#!/usr/bin/env npx tsx
/**
 * Post-observation SQL/query artifacts for Paper telemetry forensics.
 * Read-only. Writes JSON under TELEMETRY_ART_DIR/audit (or ./telemetry-queries-out).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const ART =
  process.env.TELEMETRY_ART_DIR ??
  path.resolve("telemetry-queries-out");
mkdirSync(path.join(ART, "audit"), { recursive: true });

const db = await getDbAsync();
async function q(label: string, query: ReturnType<typeof sql>) {
  const started = Date.now();
  try {
    const res = await db.execute(query);
    const rows = (res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []);
    return { ok: true, label, ms: Date.now() - started, rows };
  } catch (e) {
    return {
      ok: false,
      label,
      ms: Date.now() - started,
      error: e instanceof Error ? e.message : String(e),
      rows: []
    };
  }
}

const results: Record<string, unknown> = {
  generatedAt: new Date().toISOString(),
  databaseUrl: (process.env.DATABASE_URL ?? "").replace(/:\/\/.*@/, "://***@"),
  queries: {} as Record<string, unknown>
};

const queries: Array<[string, ReturnType<typeof sql>]> = [
  [
    "true_net_positive_totals",
    sql`SELECT
      count(*)::int AS unique_lifecycles,
      count(*) FILTER (WHERE raw_spread_percent::float8 > 0)::int AS pos_raw,
      count(*) FILTER (WHERE net_edge_percent::float8 > 0)::int AS pos_net_end,
      count(*) FILTER (WHERE max_net_edge_percent::float8 > 0)::int AS ever_pos_net_max
    FROM shadow_opportunity_lifecycles`
  ],
  [
    "fills",
    sql`SELECT lifecycle_id, route_key, size_usdt, economic_net_pnl_toman,
               risk_adjusted_pnl_toman, occurred_at::text, binding_constraint
        FROM shadow_paper_ledger WHERE outcome = 'FILLED' ORDER BY occurred_at`
  ],
  [
    "unfilled_net_positive_reasons",
    sql`SELECT lc.id, lc.route_key, lc.net_edge_percent::float8 AS net_pct,
               lc.max_net_edge_percent::float8 AS max_net_pct,
               cs.outcome, cs.primary_reason, cs.occurrences
        FROM shadow_opportunity_lifecycles lc
        JOIN shadow_paper_candidate_state cs ON cs.lifecycle_id = lc.id
        WHERE (lc.net_edge_percent::float8 > 0 OR lc.max_net_edge_percent::float8 > 0)
          AND cs.outcome = 'SKIPPED'
        ORDER BY lc.net_edge_percent::float8 DESC NULLS LAST
        LIMIT 500`
  ],
  [
    "reject_histogram_exact",
    sql`SELECT coalesce(primary_reason, '__NULL__') AS reason, count(*)::int AS n
        FROM shadow_paper_candidate_state GROUP BY 1 ORDER BY n DESC`
  ],
  [
    "banned_or_null_terminals",
    sql`SELECT coalesce(rejection_code, '__NULL__') AS code, count(*)::int AS n
        FROM shadow_paper_ledger
        WHERE outcome = 'SKIPPED'
          AND (rejection_code IS NULL OR rejection_code IN ('sizing_blocked','unknown'))
        GROUP BY 1`
  ],
  [
    "lifecycle_evidence_terminals",
    sql`SELECT coalesce(terminal_reason, '__NULL__') AS reason, outcome, count(*)::int AS n
        FROM shadow_paper_lifecycle_evidence GROUP BY 1, 2 ORDER BY n DESC`
  ],
  [
    "gate_attrition_from_stages",
    sql`SELECT stage_elem->>'stage' AS stage,
               stage_elem->>'verdict' AS verdict,
               count(*)::int AS n
        FROM shadow_paper_lifecycle_evidence,
             lateral jsonb_array_elements(stages) AS stage_elem
        GROUP BY 1, 2 ORDER BY 1, 2`
  ],
  [
    "route_venue_time_pnl",
    sql`SELECT route_key, count(*)::int AS fills,
               sum(economic_net_pnl_toman)::bigint AS sum_econ,
               avg(economic_net_pnl_toman)::float8 AS avg_econ
        FROM shadow_paper_ledger WHERE outcome = 'FILLED'
        GROUP BY 1 ORDER BY sum_econ DESC NULLS LAST`
  ],
  [
    "capital_inventory_constraints",
    sql`SELECT rejection_code, count(*)::int AS n,
               count(*) FILTER (WHERE sizing_audit IS NOT NULL)::int AS with_audit
        FROM shadow_paper_ledger
        WHERE outcome = 'SKIPPED'
          AND rejection_code IN (
            'insufficient_irt','insufficient_usdt','inventory_limit',
            'portfolio_utilization_cap','route_capital_cap','venue_exposure_cap',
            'sizing_size_floor','portfolio_limits_unavailable')
        GROUP BY 1 ORDER BY n DESC`
  ],
  [
    "latency_staleness_disappearing_liq",
    sql`SELECT coalesce(terminal_reason, rejection_code, primary_reason, '__NULL__') AS reason,
               count(*)::int AS n
        FROM (
          SELECT terminal_reason, null::text AS rejection_code, null::text AS primary_reason
          FROM shadow_paper_lifecycle_evidence
          WHERE terminal_reason IN (
            'delayed_liquidity_disappeared','delayed_depth_insufficient',
            'delayed_book_stale','stale_market_data','market_data_time_incoherent')
          UNION ALL
          SELECT null, rejection_code, null FROM shadow_paper_ledger
          WHERE rejection_code IN (
            'delayed_liquidity_disappeared','delayed_depth_insufficient',
            'delayed_book_stale','stale_market_data','market_data_time_incoherent')
          UNION ALL
          SELECT null, null, primary_reason FROM shadow_paper_candidate_state
          WHERE primary_reason IN (
            'delayed_liquidity_disappeared','delayed_depth_insufficient',
            'delayed_book_stale','stale_market_data','market_data_time_incoherent')
        ) x
        GROUP BY 1 ORDER BY n DESC`
  ]
];

for (const [label, query] of queries) {
  (results.queries as Record<string, unknown>)[label] = await q(label, query);
}

writeFileSync(
  path.join(ART, "audit", "post-observation-query-results.json"),
  JSON.stringify(results, null, 2)
);

const sqlDoc = `# Post-observation telemetry queries

Generated: ${results.generatedAt}

See \`post-observation-query-results.json\` for executed results.
Also see forensic \`query-needs.md\` for column-accurate SQL templates.

## Classification guide (legitimate vs FN vs indeterminate)
- **LEGITIMATE_REJECT**: exact terminal with matching evidence (fee_unknown+fee miss, delayed_*, inventory_*, depth_*).
- **FALSE_NEGATIVE candidate**: ever max_net>0, never filled, terminal is coherence/sizing with incomplete evidence → needs replay.
- **INDETERMINATE**: historical \`sizing_blocked\` without sizing_audit (pre-fix rows) — do not back-infer.
`;
writeFileSync(path.join(ART, "audit", "post-observation-queries.md"), sqlDoc);
console.log(JSON.stringify({ ok: true, art: ART, queryCount: queries.length }, null, 2));
await closeDb();
