#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const outPath = process.env.POLL_OUT ?? "poll-out.json";
const db = await getDbAsync();
const result: Record<string, unknown> = { ok: true, at: new Date().toISOString() };
try {
  const sess = await db.execute(sql`SELECT id::text, status, cycles_evaluated, trades_executed, candidates_skipped, last_cycle_at::text FROM shadow_paper_sessions ORDER BY created_at DESC LIMIT 1`);
  const sessRows = (sess as { rows?: unknown[] }).rows ?? (sess as unknown as unknown[]);
  result.session = sessRows[0] ?? null;

  const traces = await db.execute(sql`SELECT id::text, occurred_at::text, candidates FROM shadow_paper_decision_traces ORDER BY occurred_at`);
  const rows = (traces as { rows?: Array<{ id: string; occurred_at: string; candidates: unknown }> }).rows
    ?? (traces as unknown as Array<{ id: string; occurred_at: string; candidates: unknown }>);

  let passedNet = 0, failedNet = 0, passedRaw = 0;
  const netPassExamples: unknown[] = [];
  const closestNet: Array<{ routeKey?: string; lifecycleId?: string; netProfitToman?: number; maxNetEdgePercent?: number; at?: string; terminalReason?: string }> = [];
  const sizingConsidered: unknown[] = [];

  for (const row of rows) {
    const cands = (row.candidates ?? []) as Array<{
      routeKey?: string; lifecycleId?: string; reasonCodes?: string[]; status?: string;
      funnelStages?: Array<{ stage: string; verdict: string; terminalReason?: string | null; observed?: Record<string, unknown> | null }>;
    }>;
    for (const c of cands) {
      const stages = c.funnelStages ?? [];
      const raw = stages.find((s) => s.stage === "raw_positive");
      const net = stages.find((s) => s.stage === "net_positive");
      if (raw?.verdict === "passed") passedRaw += 1;
      if (net?.verdict === "passed") {
        passedNet += 1;
        const later = stages.filter((s) => ["sizing","inventory_capital","coherence_freshness","allocator_selection","arrival_delayed_book_recheck"].includes(s.stage));
        const ex = {
          traceId: row.id, at: row.occurred_at, routeKey: c.routeKey, lifecycleId: c.lifecycleId,
          reasonCodes: c.reasonCodes, netObserved: net.observed, laterStages: later, status: c.status,
        };
        if (netPassExamples.length < 20) netPassExamples.push(ex);
        if (later.length > 0) sizingConsidered.push(ex);
      } else if (net?.verdict === "failed") {
        failedNet += 1;
        const obs = (net.observed ?? {}) as { netProfitToman?: number; netEdgePercent?: number };
        const np = obs.netProfitToman;
        if (typeof np === "number") {
          closestNet.push({
            routeKey: c.routeKey, lifecycleId: c.lifecycleId, netProfitToman: np,
            maxNetEdgePercent: typeof obs.netEdgePercent === "number" ? obs.netEdgePercent : undefined,
            at: row.occurred_at, terminalReason: net.terminalReason ?? undefined,
          });
        }
      }
    }
  }
  closestNet.sort((a, b) => (b.netProfitToman ?? -1e99) - (a.netProfitToman ?? -1e99));

  let lcRows: unknown[] = [];
  try {
    const lc = await db.execute(sql`
      SELECT id::text AS lifecycle_id, route_key,
        net_edge_percent::float8 AS net_pct, max_net_edge_percent::float8 AS max_net_pct,
        max_net_profit_toman::float8 AS max_net_profit_toman,
        status, first_seen_at::text, last_seen_at::text
      FROM shadow_opportunity_lifecycles
      WHERE net_edge_percent::float8 > 0 OR max_net_edge_percent::float8 > 0
      ORDER BY max_net_edge_percent::float8 DESC NULLS LAST LIMIT 50`);
    lcRows = (lc as { rows?: unknown[] }).rows ?? (lc as unknown as unknown[]);
  } catch (e) {
    result.lifecycleQueryError = e instanceof Error ? e.message : String(e);
  }

  const fills = await db.execute(sql`SELECT count(*)::int AS n FROM shadow_paper_ledger WHERE outcome = 'FILLED'`);
  const fillRows = (fills as { rows?: Array<{ n: number }> }).rows ?? (fills as unknown as Array<{ n: number }>);
  const residual = await db.execute(sql`SELECT count(*)::int AS n FROM shadow_paper_residual_liquidity`);
  const resRows = (residual as { rows?: Array<{ n: number }> }).rows ?? (residual as unknown as Array<{ n: number }>);
  const cycles = await db.execute(sql`SELECT count(*)::int AS n FROM shadow_collection_runs`);
  const cycRows = (cycles as { rows?: Array<{ n: number }> }).rows ?? (cycles as unknown as Array<{ n: number }>);

  result.traces = rows.length;
  result.passedRawPositiveStages = passedRaw;
  result.passedNetPositiveStages = passedNet;
  result.failedNetPositiveStages = failedNet;
  result.netPassExamples = netPassExamples;
  result.sizingConsidered = sizingConsidered;
  result.closestNetAttempts = closestNet.slice(0, 10);
  result.lifecyclesNetPos = lcRows;
  result.fills = fillRows[0]?.n ?? 0;
  result.residualRows = resRows[0]?.n ?? 0;
  result.collectionRuns = cycRows[0]?.n ?? 0;
  result.realPostFixCandidate = passedNet > 0 || (Array.isArray(lcRows) && lcRows.length > 0) ? "YES" : "NO";
} catch (e) {
  result.ok = false;
  result.error = e instanceof Error ? e.message : String(e);
}
writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ ok: result.ok, realPostFixCandidate: result.realPostFixCandidate, passedNet: result.passedNetPositiveStages, closest: (result.closestNetAttempts as unknown[])?.[0], fills: result.fills, cycles: result.collectionRuns, err: result.error }, null, 2));
await closeDb();
