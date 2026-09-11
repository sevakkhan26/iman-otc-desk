#!/usr/bin/env npx tsx
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const ART = process.env.VAL_ART_DIR ?? ".";
const life = process.env.LIFECYCLE_ID ?? "03c335e2c4017d22aefa6353";
mkdirSync(path.join(ART, "audit"), { recursive: true });
const db = await getDbAsync();

const ledgerRes = await db.execute(sql`SELECT id::text, outcome, rejection_code, decision_trace_id::text, occurred_at::text
  FROM shadow_paper_ledger WHERE lifecycle_id = ${life} ORDER BY occurred_at`);
const ledger = (ledgerRes as { rows?: unknown[] }).rows ?? (ledgerRes as unknown as unknown[]);

const stateRes = await db.execute(sql`SELECT outcome, primary_reason, reason_codes, occurrences, last_seen_at::text
  FROM shadow_paper_candidate_state WHERE lifecycle_id = ${life}`);
const state = (stateRes as { rows?: unknown[] }).rows ?? (stateRes as unknown as unknown[]);

const tracesRes = await db.execute(sql`SELECT id::text, occurred_at::text, candidates FROM shadow_paper_decision_traces ORDER BY occurred_at`);
const rows = (tracesRes as { rows?: Array<{ id: string; occurred_at: string; candidates: unknown }> }).rows
  ?? (tracesRes as unknown as Array<{ id: string; occurred_at: string; candidates: unknown }>);

type Stage = { stage: string; verdict: string; terminalReason?: string | null; observed?: unknown };
const passes: unknown[] = [];
const hist: Record<string, number> = {};
let evals = 0;
for (const row of rows) {
  for (const c of (row.candidates ?? []) as Array<{ lifecycleId?: string; routeKey?: string; status?: string; reasonCodes?: string[]; funnelStages?: Stage[] }>) {
    if (c.lifecycleId !== life) continue;
    evals += 1;
    const net = (c.funnelStages ?? []).find((s) => s.stage === "net_positive");
    const v = net?.verdict ?? "none";
    hist[v] = (hist[v] ?? 0) + 1;
    if (net?.verdict === "passed") {
      passes.push({
        at: row.occurred_at,
        traceId: row.id,
        routeKey: c.routeKey,
        status: c.status,
        reasonCodes: c.reasonCodes,
        netObserved: net.observed,
        funnelStages: c.funnelStages,
      });
    }
  }
}

const lcRes = await db.execute(sql`SELECT id::text, route_key, net_edge_percent::float8 AS net_pct,
  max_net_edge_percent::float8 AS max_net_pct, max_net_profit_toman::float8 AS max_net_profit_toman
  FROM shadow_opportunity_lifecycles WHERE id = ${life}`);
const lc = (lcRes as { rows?: unknown[] }).rows ?? (lcRes as unknown as unknown[]);

const out = { lifecycleId: life, lifecycleRow: lc[0] ?? null, state, ledger, evaluations: evals, netVerdictHistogram: hist, passCount: passes.length, passes };
writeFileSync(path.join(ART, "audit", "candidate-lifecycle-detail.json"), JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify({ passCount: passes.length, hist, state, ledgerRejectionCodes: (ledger as Array<{ rejection_code: string }>).map((r) => r.rejection_code), lifecycleRow: lc[0] ?? null, pass0: passes[0] ?? null }, null, 2));
await closeDb();
