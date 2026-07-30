#!/usr/bin/env npx tsx
/**
 * Read-only storage-growth report for every Shadow table.
 *
 *   pnpm ops:storage             # report only
 *   pnpm ops:storage --retention # additionally show a DRY-RUN retention plan
 *
 * It runs SELECTs only. There is no DELETE, no DROP, no TRUNCATE and no ALTER
 * anywhere in this file: the retention section prints what *would* be removed
 * and stops there. Deleting observation history is a decision a human makes
 * with a backup in hand, not something a report does on the way past.
 */
import { loadLocalEnv } from "./load-env.mts";

const repoRoot = new URL("..", import.meta.url).pathname;
loadLocalEnv(repoRoot);

const { getDbAsync, closeDb, getDatabaseUrl, isPgliteUrl } = await import("../src/db/client.ts");
const { sql } = await import("drizzle-orm");

/** Every Shadow table, with the column that carries its record time. */
const SHADOW_TABLES: Array<{ table: string; timeColumn: string | null }> = [
  { table: "shadow_observation_sessions", timeColumn: "created_at" },
  { table: "shadow_collection_runs", timeColumn: "started_at" },
  { table: "shadow_source_snapshots", timeColumn: "received_at" },
  { table: "shadow_opportunity_lifecycles", timeColumn: "last_seen_at" },
  { table: "shadow_opportunity_events", timeColumn: "occurred_at" },
  { table: "shadow_source_health_events", timeColumn: "occurred_at" },
  { table: "shadow_route_metrics", timeColumn: "last_seen_at" },
  { table: "shadow_worker_heartbeat", timeColumn: "last_heartbeat_at" },
  { table: "shadow_fee_confirmations", timeColumn: "confirmed_at" },
  { table: "shadow_capital_plans", timeColumn: "created_at" },
  { table: "shadow_capital_approvals", timeColumn: "approved_at" },
  { table: "shadow_paper_sessions", timeColumn: "created_at" },
  { table: "shadow_paper_balances", timeColumn: "updated_at" },
  { table: "shadow_paper_ledger", timeColumn: "occurred_at" },
  { table: "shadow_paper_candidate_state", timeColumn: "last_seen_at" },
  { table: "shadow_paper_cycle_summaries", timeColumn: "occurred_at" },
  { table: "shadow_live_attestations", timeColumn: "confirmed_at" },
  { table: "shadow_live_risk_policies", timeColumn: "set_at" },
  { table: "shadow_live_readiness_reviews", timeColumn: "reviewed_at" }
];

const RETENTION_FLAG = process.argv.includes("--retention");

function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

const db = await getDbAsync();
const pglite = isPgliteUrl(getDatabaseUrl());

console.log("\nShadow storage report — READ ONLY, nothing is deleted\n");
console.log(
  "  table                             rows      oldest record         newest record         size"
);
console.log("  " + "-".repeat(96));

let totalRows = 0;
const perTable: Array<{ table: string; rows: number; oldest: string | null; newest: string | null }> = [];

for (const { table, timeColumn } of SHADOW_TABLES) {
  let rows = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  let size = "n/a";

  try {
    const countResult = await db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
    rows = Number(rowsOf<{ n: number }>(countResult)[0]?.n ?? 0);

    if (timeColumn && rows > 0) {
      const rangeResult = await db.execute(
        sql.raw(
          `SELECT min(${timeColumn})::text AS oldest, max(${timeColumn})::text AS newest FROM ${table}`
        )
      );
      const range = rowsOf<{ oldest: string | null; newest: string | null }>(rangeResult)[0];
      oldest = range?.oldest ?? null;
      newest = range?.newest ?? null;
    }

    if (!pglite) {
      const sizeResult = await db.execute(
        sql.raw(`SELECT pg_size_pretty(pg_total_relation_size('${table}')) AS s`)
      );
      size = String(rowsOf<{ s: string }>(sizeResult)[0]?.s ?? "n/a");
    }
  } catch {
    console.log(`  ${table.padEnd(34)} (not present)`);
    continue;
  }

  totalRows += rows;
  perTable.push({ table, rows, oldest, newest });
  console.log(
    `  ${table.padEnd(34)}${fmt(rows).padStart(8)}  ${(oldest ?? "—").slice(0, 19).padEnd(22)}${(newest ?? "—").slice(0, 19).padEnd(22)}${size}`
  );
}

console.log("  " + "-".repeat(96));
console.log(`  ${"TOTAL".padEnd(34)}${fmt(totalRows).padStart(8)}\n`);

if (!pglite) {
  try {
    const dbSize = await db.execute(
      sql.raw("SELECT pg_size_pretty(pg_database_size(current_database())) AS s")
    );
    console.log(`  database size: ${rowsOf<{ s: string }>(dbSize)[0]?.s ?? "unknown"}\n`);
  } catch {
    /* size is a nicety, not a requirement */
  }
}

/* ── growth projection ────────────────────────────────────────────────────── */
const runs = perTable.find((t) => t.table === "shadow_collection_runs");
if (runs && runs.oldest && runs.newest && runs.rows > 1) {
  const spanMs = Date.parse(runs.newest) - Date.parse(runs.oldest);
  if (spanMs > 0) {
    const perDay = (totalRows * 86_400_000) / spanMs;
    console.log(
      `  observed growth: ~${fmt(Math.round(perDay))} rows/day across all Shadow tables ` +
        `(over ${(spanMs / 86_400_000).toFixed(1)} days)\n`
    );
  }
}

/* ── retention: DRY RUN ONLY ──────────────────────────────────────────────── */
if (RETENTION_FLAG) {
  const days = Number(process.env.SHADOW_RETENTION_REPORT_DAYS ?? "");
  if (!Number.isFinite(days) || days <= 0) {
    console.log(
      "  retention dry run: set SHADOW_RETENTION_REPORT_DAYS to the window you want to evaluate.\n" +
        "  No default window is assumed — choosing how much history to discard is your decision.\n"
    );
  } else {
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    console.log(`  RETENTION DRY RUN — records older than ${cutoff.slice(0, 19)} (${days} days)`);
    console.log("  Nothing below is deleted. This report has no DELETE or DROP path at all.\n");
    for (const { table, timeColumn } of SHADOW_TABLES) {
      if (!timeColumn) continue;
      try {
        const r = await db.execute(
          sql.raw(`SELECT count(*)::int AS n FROM ${table} WHERE ${timeColumn} < '${cutoff}'`)
        );
        const n = Number(rowsOf<{ n: number }>(r)[0]?.n ?? 0);
        if (n > 0) console.log(`    ${table.padEnd(34)}${fmt(n).padStart(8)} rows would be in scope`);
      } catch {
        /* table absent — already reported above */
      }
    }
    console.log(
      "\n  To act on this, take a verified backup first (scripts/backup-production-db.sh),\n" +
        "  rehearse the restore (scripts/restore-drill.sh), and then delete deliberately.\n" +
        "  Immutable ledgers and readiness audit trails should normally be archived, not deleted.\n"
    );
  }
}

await closeDb().catch(() => undefined);
