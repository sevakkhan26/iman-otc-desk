#!/usr/bin/env npx tsx
/**
 * Post-run Paper experiment audit — READ-ONLY.
 *
 * Intended to run ONLY after the four-day experiment has ended.
 * Does not mutate sessions, ledgers, experiments or policies.
 *
 * Usage (local / throwaway DB):
 *   DATABASE_URL=postgres://... npx tsx scripts/report-paper-experiment-audit.mts
 *   DATABASE_URL=pglite:/tmp/audit-db npx tsx scripts/report-paper-experiment-audit.mts
 *
 * Environment:
 *   PAPER_EXPERIMENT_RUN_KEY  default paper-experiment-4d-v1
 *   REQUIRE_COMPLETED         if "true", exit 2 when experiment is still ACTIVE
 *
 * Safety: only SELECT queries. Never UPDATE/DELETE/INSERT.
 */
import { sql } from "drizzle-orm";
import { getDbAsync, closeDb } from "../src/db/client.ts";
import { runMigrations } from "../src/db/migrate.ts";
import {
  PAPER_4D_DURATION_MS,
  PAPER_4D_RUN_KEY
} from "../src/lib/shadowArbitrage/paper/experimentPolicy.ts";

const runKey = (process.env.PAPER_EXPERIMENT_RUN_KEY ?? PAPER_4D_RUN_KEY).trim();
const requireCompleted = (process.env.REQUIRE_COMPLETED ?? "").toLowerCase() === "true";

type Row = Record<string, unknown>;

async function q(query: ReturnType<typeof sql>): Promise<Row[]> {
  const db = await getDbAsync();
  const r = await db.execute(query);
  return (Array.isArray(r) ? r : ((r as { rows?: Row[] }).rows ?? [])) as Row[];
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

console.log("Paper experiment audit (read-only)");
console.log(`run_key=${runKey}`);
console.log(`requireCompleted=${requireCompleted}`);
console.log("---");

await runMigrations();

const expRows = await q(sql`
  SELECT id, run_key, status, policy_set_key, policy_fingerprint, release_version,
         started_at, ends_at, completed_at, session_id, initial_capital_toman,
         target_utilization_percent, max_utilization_percent, min_reserve_percent,
         peak_utilization_percent, utilization_stats, summary, derived_max_order_usdt,
         derived_max_order_reference_price
    FROM shadow_paper_experiments
   WHERE run_key = ${runKey}
   LIMIT 1
`);

if (!expRows.length) {
  console.error("No experiment row for run_key — nothing to audit.");
  await closeDb();
  process.exit(1);
}

const exp = expRows[0];
const status = str(exp.status);
const startedAt = str(exp.started_at)!;
const endsAt = str(exp.ends_at)!;
const startMs = Date.parse(startedAt);
const endMs = Date.parse(endsAt);
const durationMs = endMs - startMs;
const sessionId = str(exp.session_id);
const expId = str(exp.id);

console.log("## Identity");
console.log(JSON.stringify({
  id: expId,
  runKey: str(exp.run_key),
  status,
  policySetKey: str(exp.policy_set_key),
  policyFingerprint: str(exp.policy_fingerprint),
  releaseVersion: str(exp.release_version),
  startedAt,
  endsAt,
  completedAt: str(exp.completed_at),
  sessionId,
  initialCapitalToman: num(exp.initial_capital_toman),
  derivedMaxOrderUsdt: exp.derived_max_order_usdt == null ? null : num(exp.derived_max_order_usdt),
  derivedMaxOrderReferencePrice: exp.derived_max_order_reference_price,
  targetUtilizationPercent: num(exp.target_utilization_percent),
  maxUtilizationPercent: num(exp.max_utilization_percent),
  minReservePercent: num(exp.min_reserve_percent),
  peakUtilizationPercent:
    exp.peak_utilization_percent == null ? null : num(exp.peak_utilization_percent),
  utilizationStats: exp.utilization_stats,
  summary: exp.summary
}, null, 2));

console.log("\n## Clock");
const clockOk = durationMs === PAPER_4D_DURATION_MS;
console.log(JSON.stringify({
  durationMs,
  expectedMs: PAPER_4D_DURATION_MS,
  exact96h: clockOk,
  hours: durationMs / 3_600_000
}, null, 2));

if (requireCompleted && status === "ACTIVE") {
  console.error("\nExperiment still ACTIVE — do not treat as final audit.");
  await closeDb();
  process.exit(2);
}

if (!sessionId) {
  console.log("\nNo session linked — ledger stats skipped.");
  await closeDb();
  process.exit(clockOk ? 0 : 3);
}

const afterEnd = await q(sql`
  SELECT count(*)::int AS n
    FROM shadow_paper_ledger
   WHERE session_id = ${sessionId}
     AND outcome = 'FILLED'
     AND occurred_at > ${endsAt}
`);

const fills = await q(sql`
  SELECT count(*)::int AS n,
         coalesce(sum(size_usdt::numeric), 0) AS volume_usdt,
         coalesce(sum(gross_spread_toman), 0) AS gross,
         coalesce(sum(fee_toman_total), 0) AS fee_irt,
         coalesce(sum(fee_usdt_micros_total), 0) AS fee_usdt_micros,
         coalesce(sum(sell_fee_value_toman), 0) AS fee_usdt_toman,
         coalesce(sum(economic_net_pnl_toman), 0) AS economic_pnl,
         coalesce(sum(cash_pnl_irt_toman), 0) AS cash_pnl
    FROM shadow_paper_ledger
   WHERE session_id = ${sessionId}
     AND outcome = 'FILLED'
`);

const skipped = await q(sql`
  SELECT count(*)::int AS n
    FROM shadow_paper_ledger
   WHERE session_id = ${sessionId}
     AND outcome = 'SKIPPED'
`);

const byRoute = await q(sql`
  SELECT route_key,
         count(*)::int AS trades,
         coalesce(sum(size_usdt::numeric), 0) AS volume_usdt,
         coalesce(sum(economic_net_pnl_toman), 0) AS economic_pnl
    FROM shadow_paper_ledger
   WHERE session_id = ${sessionId}
     AND outcome = 'FILLED'
   GROUP BY route_key
   ORDER BY volume_usdt DESC
`);

const dupIdem = await q(sql`
  SELECT idempotency_key, count(*)::int AS n
    FROM shadow_paper_ledger
   WHERE session_id = ${sessionId}
     AND idempotency_key IS NOT NULL
   GROUP BY idempotency_key
  HAVING count(*) > 1
`);

const collectorGaps = await q(sql`
  SELECT count(*)::int AS cycles,
         min(started_at) AS first_cycle,
         max(started_at) AS last_cycle
    FROM shadow_collection_runs
`);

console.log("\n## Ledger (session-scoped)");
const f = fills[0] ?? {};
console.log(JSON.stringify({
  filledTrades: num(f.n),
  skippedDecisions: num(skipped[0]?.n),
  fillsAfterEndsAt: num(afterEnd[0]?.n),
  noFillsAfterEndsAt: num(afterEnd[0]?.n) === 0,
  volumeUsdt: num(f.volume_usdt),
  grossSpreadToman: num(f.gross),
  feeIrtToman: num(f.fee_irt),
  feeUsdtMicros: num(f.fee_usdt_micros),
  feeUsdtValueToman: num(f.fee_usdt_toman),
  economicRealizedPnlToman: num(f.economic_pnl),
  cashRealizedPnlToman: num(f.cash_pnl),
  // Immediate-fill broker: open residuals normally zero — not re-marked here.
  unrealizedNoteFa:
    "کارگزار اتمیک پوزیشن باز نگه نمی‌دارد؛ unrealized در snapshot پایانی فقط اگر residual ثبت شده باشد معنا دارد.",
  volumeByRoute: byRoute.map((r) => ({
    routeKey: str(r.route_key),
    trades: num(r.trades),
    volumeUsdt: num(r.volume_usdt),
    economicPnl: num(r.economic_pnl)
  })),
  duplicateIdempotencyKeys: dupIdem.map((r) => ({
    key: str(r.idempotency_key),
    count: num(r.n)
  }))
}, null, 2));

console.log("\n## Collector (global, informational)");
console.log(JSON.stringify(collectorGaps[0] ?? {}, null, 2));

console.log("\n## Verdict helpers (not a pass/fail of the experiment)");
console.log(JSON.stringify({
  identityFrozen: true,
  exact96h: clockOk,
  noFillsAfterEndsAt: num(afterEnd[0]?.n) === 0,
  stillActive: status === "ACTIVE",
  noteFa:
    "این گزارش فقط شواهد را جمع می‌کند. ادعای موفقیت اقتصادی قبل از endsAt ممنوع است."
}, null, 2));

await closeDb();
process.exit(clockOk && num(afterEnd[0]?.n) === 0 ? 0 : 3);
