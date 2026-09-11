import { writeFileSync } from "node:fs";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";
const out = process.env.OUT ?? "funnel-deep.json";
const db = await getDbAsync();
const traces = await db.execute(sql`SELECT id::text, occurred_at::text, candidates FROM shadow_paper_decision_traces ORDER BY occurred_at`);
const rows = (traces as { rows?: Array<{ id: string; occurred_at: string; candidates: unknown }> }).rows
  ?? (traces as unknown as Array<{ id: string; occurred_at: string; candidates: unknown }>);

const stageOrder = [
  "raw_positive","fee","net_positive","sizing","inventory_capital",
  "coherence_freshness","allocator_selection","arrival_delayed_book_recheck"
];

type Cand = {
  routeKey?: string; lifecycleId?: string; status?: string; reasonCodes?: string[];
  funnelStages?: Array<{ stage: string; verdict: string; terminalReason?: string | null; observed?: Record<string, unknown> | null }>;
};

const interesting: unknown[] = [];
let maxDepth = 0;
let deepest: unknown = null;
const stagePassCounts: Record<string, number> = {};
const terminalReasons: Record<string, number> = {};

for (const row of rows) {
  const cands = (row.candidates ?? []) as Cand[];
  for (const c of cands) {
    const stages = c.funnelStages ?? [];
    for (const s of stages) {
      if (s.verdict === "passed") stagePassCounts[s.stage] = (stagePassCounts[s.stage] ?? 0) + 1;
      if (s.verdict === "failed" && s.terminalReason) {
        terminalReasons[s.terminalReason] = (terminalReasons[s.terminalReason] ?? 0) + 1;
      }
    }
    const passed = stages.filter((s) => s.verdict === "passed").map((s) => s.stage);
    const depth = Math.max(0, ...passed.map((p) => stageOrder.indexOf(p)));
    const reachedSizing = stages.some((s) => s.stage === "sizing" && s.verdict === "passed");
    const reachedInv = stages.some((s) => s.stage === "inventory_capital" && s.verdict === "passed");
    const reachedCoh = stages.some((s) => s.stage === "coherence_freshness");
    const reachedAlloc = stages.some((s) => s.stage === "allocator_selection");
    const reachedArrival = stages.some((s) => s.stage === "arrival_delayed_book_recheck");
    const netPassed = stages.some((s) => s.stage === "net_positive" && s.verdict === "passed");
    if (netPassed || reachedSizing || reachedInv || reachedCoh || reachedAlloc || reachedArrival) {
      const ex = {
        traceId: row.id,
        at: row.occurred_at,
        routeKey: c.routeKey,
        lifecycleId: c.lifecycleId,
        status: c.status,
        reasonCodes: c.reasonCodes,
        stages: stages.map((s) => ({
          stage: s.stage,
          verdict: s.verdict,
          terminalReason: s.terminalReason ?? null,
          observed: s.observed ?? null
        })),
        depthIndex: depth,
        flags: { netPassed, reachedSizing, reachedInv, reachedCoh, reachedAlloc, reachedArrival }
      };
      interesting.push(ex);
      if (depth > maxDepth || (depth === maxDepth && (reachedAlloc || reachedArrival))) {
        maxDepth = depth;
        deepest = ex;
      }
    }
  }
}

const result = {
  at: new Date().toISOString(),
  traces: rows.length,
  interestingCount: interesting.length,
  stagePassCounts,
  terminalReasons,
  maxDepth,
  deepest,
  interesting: interesting.slice(0, 30)
};
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({
  traces: rows.length,
  interestingCount: interesting.length,
  stagePassCounts,
  terminalReasons,
  maxDepth,
  deepestSummary: deepest
    ? {
        routeKey: (deepest as { routeKey?: string }).routeKey,
        lifecycleId: (deepest as { lifecycleId?: string }).lifecycleId,
        at: (deepest as { at?: string }).at,
        flags: (deepest as { flags?: unknown }).flags,
        stages: (deepest as { stages?: unknown }).stages
      }
    : null
}, null, 2));
await closeDb();
