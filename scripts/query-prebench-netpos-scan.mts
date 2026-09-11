#!/usr/bin/env npx tsx
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const ART = process.env.VAL_ART_DIR ?? ".";
mkdirSync(path.join(ART, "audit"), { recursive: true });
const db = await getDbAsync();

// Scan all decision traces for any candidate that passed net_positive stage
const traces = await db.execute(sql`
  SELECT id::text, occurred_at::text, candidates
  FROM shadow_paper_decision_traces
  ORDER BY occurred_at
`);
const rows = (traces as { rows?: Array<{ id: string; occurred_at: string; candidates: unknown }> }).rows
  ?? (traces as unknown as Array<{ id: string; occurred_at: string; candidates: unknown }>);

type Cand = {
  routeKey?: string;
  lifecycleId?: string;
  reasonCodes?: string[];
  funnelStages?: Array<{ stage: string; verdict: string; terminalReason?: string | null; observed?: unknown }>;
  status?: string;
};
let passedNet = 0;
let failedNet = 0;
let passedRaw = 0;
const netPassExamples: unknown[] = [];
const closestNet: Array<{ routeKey?: string; lifecycleId?: string; netProfitToman?: number; at?: string }> = [];

for (const row of rows) {
  const cands = (row.candidates ?? []) as Cand[];
  for (const c of cands) {
    const stages = c.funnelStages ?? [];
    const raw = stages.find((s) => s.stage === "raw_positive");
    const net = stages.find((s) => s.stage === "net_positive");
    if (raw?.verdict === "passed") passedRaw += 1;
    if (net?.verdict === "passed") {
      passedNet += 1;
      if (netPassExamples.length < 10) {
        netPassExamples.push({
          traceId: row.id,
          at: row.occurred_at,
          routeKey: c.routeKey,
          lifecycleId: c.lifecycleId,
          reasonCodes: c.reasonCodes,
          netObserved: net.observed,
          laterStages: stages.filter((s) => ["sizing","inventory_capital","coherence_freshness","allocator_selection","arrival_delayed_book_recheck"].includes(s.stage)),
        });
      }
    } else if (net?.verdict === "failed") {
      failedNet += 1;
      const np = (net.observed as { netProfitToman?: number } | null)?.netProfitToman;
      if (typeof np === "number") {
        closestNet.push({ routeKey: c.routeKey, lifecycleId: c.lifecycleId, netProfitToman: np, at: row.occurred_at });
      }
    }
  }
}
closestNet.sort((a, b) => (b.netProfitToman ?? -1e99) - (a.netProfitToman ?? -1e99));

const summary = {
  traces: rows.length,
  passedRawPositiveStages: passedRaw,
  passedNetPositiveStages: passedNet,
  failedNetPositiveStages: failedNet,
  netPassExamples,
  closestNetAttempts: closestNet.slice(0, 15),
};
console.log(JSON.stringify(summary, null, 2));
writeFileSync(path.join(ART, "audit", "netpos-scan.json"), JSON.stringify(summary, null, 2) + "\n");
await closeDb();
