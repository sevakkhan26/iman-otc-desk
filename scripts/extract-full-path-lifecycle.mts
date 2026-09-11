import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const ART = process.env.VAL_ART_DIR ?? ".";
const LIFE = process.env.LIFECYCLE_ID ?? "32edb41e41548de0fae6de76";
mkdirSync(path.join(ART, "audit"), { recursive: true });
const db = await getDbAsync();

async function q(query: ReturnType<typeof sql>) {
  const res = await db.execute(query);
  return (res as { rows?: unknown[] }).rows ?? (Array.isArray(res) ? res : []);
}

const out: Record<string, unknown> = { lifecycleId: LIFE, at: new Date().toISOString() };

out.lifecycleCols = await q(sql`SELECT column_name FROM information_schema.columns WHERE table_name='shadow_opportunity_lifecycles' ORDER BY ordinal_position`);
out.ledgerCols = await q(sql`SELECT column_name FROM information_schema.columns WHERE table_name='shadow_paper_ledger' ORDER BY ordinal_position`);
out.residualCols = await q(sql`SELECT column_name FROM information_schema.columns WHERE table_name='shadow_paper_residual_liquidity' ORDER BY ordinal_position`);

out.lifecycle = (await q(sql`SELECT * FROM shadow_opportunity_lifecycles WHERE id = ${LIFE}`))[0] ?? null;
out.ledger = await q(sql`SELECT * FROM shadow_paper_ledger WHERE lifecycle_id = ${LIFE} ORDER BY occurred_at`);
out.residualAll = await q(sql`SELECT * FROM shadow_paper_residual_liquidity ORDER BY created_at`);
out.session = (await q(sql`SELECT * FROM shadow_paper_sessions ORDER BY created_at DESC LIMIT 1`))[0] ?? null;
out.observation = await q(sql`SELECT * FROM shadow_observation_sessions ORDER BY created_at DESC LIMIT 5`);

const traces = await q(sql`SELECT id::text, occurred_at::text, candidates FROM shadow_paper_decision_traces ORDER BY occurred_at`);
const hits: unknown[] = [];
for (const row of traces as Array<{ id: string; occurred_at: string; candidates: unknown }>) {
  for (const c of (row.candidates ?? []) as Array<Record<string, unknown>>) {
    if (c.lifecycleId !== LIFE) continue;
    const le = (c.lifecycleEvidence ?? {}) as Record<string, unknown>;
    hits.push({
      decisionTraceId: row.id,
      at: row.occurred_at,
      status: c.status,
      terminalReason: c.terminalReason,
      reasonCodes: c.reasonCodes,
      sizeUsdt: c.sizeUsdt,
      depthCapUsdt: c.depthCapUsdt,
      capitalCapUsdt: c.capitalCapUsdt,
      delayedBuyVwapToman: c.delayedBuyVwapToman,
      delayedSellVwapToman: c.delayedSellVwapToman,
      delayedNetPnlToman: c.delayedNetPnlToman,
      ledgerId: c.ledgerId,
      funnelStages: c.funnelStages,
      evidence: {
        allocator: le.allocator,
        sizes: le.sizes,
        delayedRecheck: le.delayedRecheck,
        vwap: le.vwap,
        edges: le.edges,
        capitalInventory: le.capitalInventory,
        timestamps: le.timestamps,
        diagnostics: le.diagnostics,
        legs: le.legs,
        venueRoute: le.venueRoute,
        fees: le.fees,
        policy: le.policy,
        outcome: le.outcome,
        ledgerId: le.ledgerId,
        residual: (le as any).residual ?? (le as any).residualLiquidity ?? null,
      },
    });
  }
}
out.traceHits = hits;

// Any later candidates rejected due to residual on same venues after this fill
out.residualRejects = [];
for (const row of traces as Array<{ id: string; occurred_at: string; candidates: unknown }>) {
  for (const c of (row.candidates ?? []) as Array<Record<string, unknown>>) {
    const codes = (c.reasonCodes as string[] | undefined) ?? [];
    if (codes.some((x) => String(x).includes("residual"))) {
      (out.residualRejects as unknown[]).push({
        at: row.occurred_at,
        traceId: row.id,
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        reasonCodes: codes,
        terminalReason: c.terminalReason,
      });
    }
  }
}

writeFileSync(path.join(ART, "audit", "lifecycle-full-extract.json"), JSON.stringify(out, null, 2) + "\n");
const hit = hits.find((h: any) => h.status === "traded") ?? hits[hits.length - 1];
console.log(JSON.stringify({
  sessionId: (out.session as any)?.id,
  observationId: (out.session as any)?.observation_id ?? (out.session as any)?.observationId,
  cycles: (out.session as any)?.cycles_evaluated,
  trades: (out.session as any)?.trades_executed,
  lifecycle: out.lifecycle,
  ledger: out.ledger,
  residualAll: out.residualAll,
  residualRejects: out.residualRejects,
  hitSummary: hit ? {
    decisionTraceId: (hit as any).decisionTraceId,
    at: (hit as any).at,
    status: (hit as any).status,
    sizeUsdt: (hit as any).sizeUsdt,
    depthCapUsdt: (hit as any).depthCapUsdt,
    capitalCapUsdt: (hit as any).capitalCapUsdt,
    ledgerId: (hit as any).ledgerId,
    delayedNet: (hit as any).delayedNetPnlToman,
    allocator: (hit as any).evidence?.allocator,
    sizes: (hit as any).evidence?.sizes,
    timestamps: (hit as any).evidence?.timestamps,
    legs: (hit as any).evidence?.legs,
    outcome: (hit as any).evidence?.outcome,
    evidenceLedgerId: (hit as any).evidence?.ledgerId,
  } : null,
  ledgerCols: out.ledgerCols,
  residualCols: out.residualCols,
}, null, 2));
await closeDb();
