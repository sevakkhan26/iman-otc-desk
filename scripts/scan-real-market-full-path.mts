#!/usr/bin/env npx tsx
/**
 * Scan decision traces for a real-market lifecycle that reached:
 * net_positive → sizing → inventory → allocator → arrival/delayed → delayed VWAP/net
 * (and residual-liquidity evaluation evidence when present).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const ART = process.env.VAL_ART_DIR ?? ".";
mkdirSync(path.join(ART, "audit"), { recursive: true });

type Stage = { stage: string; verdict: string; terminalReason?: string | null; observed?: unknown };
type Cand = {
  routeKey?: string;
  lifecycleId?: string;
  status?: string;
  reasonCodes?: string[];
  sizeUsdt?: number;
  depthCapUsdt?: number | null;
  capitalCapUsdt?: number | null;
  delayedBuyVwapToman?: number | null;
  delayedSellVwapToman?: number | null;
  delayedNetPnlToman?: number | null;
  ledgerId?: string | null;
  terminalReason?: string | null;
  funnelStages?: Stage[];
  lifecycleEvidence?: Record<string, unknown> | null;
};

const REQUIRED_PASSED = [
  "raw_positive",
  "fee",
  "net_positive",
  "sizing",
  "inventory_capital",
  "allocator_selection",
  "arrival_delayed_book_recheck",
] as const;

function stageMap(stages: Stage[]) {
  const m = new Map<string, Stage>();
  for (const s of stages) m.set(s.stage, s);
  return m;
}

function isFullPath(c: Cand): boolean {
  const m = stageMap(c.funnelStages ?? []);
  for (const s of REQUIRED_PASSED) {
    if (m.get(s)?.verdict !== "passed") return false;
  }
  // delayed VWAP/slippage/net must have been evaluated (passed OR failed with exact reason)
  const delayedNet = m.get("delayed_vwap_slippage_net");
  if (!delayedNet) return false;
  if (delayedNet.verdict !== "passed" && delayedNet.verdict !== "failed") return false;
  return true;
}

function residualExercised(c: Cand): boolean {
  const le = c.lifecycleEvidence ?? {};
  const delayed = le.delayedRecheck as Record<string, unknown> | null | undefined;
  const sizes = le.sizes as Record<string, unknown> | null | undefined;
  const diagnostics = le.diagnostics as Record<string, unknown> | null | undefined;
  // Residual logic is exercised when delayed recheck ran (uses residual-reduced books)
  // OR explicit residual fields / residual reject codes appear.
  const reasons = (c.reasonCodes ?? []).concat(
    Array.isArray(le.reasonCodes) ? (le.reasonCodes as string[]) : []
  );
  if (reasons.some((r) => String(r).includes("residual"))) return true;
  if (delayed && typeof delayed === "object") return true;
  if (c.funnelStages?.some((s) => s.stage === "arrival_delayed_book_recheck" && (s.verdict === "passed" || s.verdict === "failed"))) {
    return true;
  }
  if (sizes && (sizes.depthCapUsdt != null || sizes.effectiveResidualDepthUsdt != null)) return true;
  if (diagnostics && JSON.stringify(diagnostics).includes("residual")) return true;
  return false;
}

const db = await getDbAsync();
const traces = await db.execute(sql`
  SELECT id::text, occurred_at::text, candidates
  FROM shadow_paper_decision_traces
  ORDER BY occurred_at
`);
const rows =
  (traces as { rows?: Array<{ id: string; occurred_at: string; candidates: unknown }> }).rows ??
  (traces as unknown as Array<{ id: string; occurred_at: string; candidates: unknown }>);

const fullPath: unknown[] = [];
const netPassed: unknown[] = [];
const closestNet: Array<{ routeKey?: string; lifecycleId?: string; netProfitToman?: number; at?: string; terminal?: string | null }> = [];
const stagePassCounts: Record<string, number> = {};
const terminalReasons: Record<string, number> = {};
let fills = 0;
let residualRows = 0;

for (const row of rows) {
  for (const c of (row.candidates ?? []) as Cand[]) {
    const stages = c.funnelStages ?? [];
    for (const s of stages) {
      if (s.verdict === "passed") stagePassCounts[s.stage] = (stagePassCounts[s.stage] ?? 0) + 1;
      if (s.verdict === "failed" && s.terminalReason) {
        terminalReasons[s.terminalReason] = (terminalReasons[s.terminalReason] ?? 0) + 1;
      }
    }
    const net = stages.find((s) => s.stage === "net_positive");
    if (net?.verdict === "passed") {
      netPassed.push({
        traceId: row.id,
        at: row.occurred_at,
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
        terminalReason: c.terminalReason,
        reasonCodes: c.reasonCodes,
        stages: stages.map((s) => ({ stage: s.stage, verdict: s.verdict, terminalReason: s.terminalReason ?? null })),
      });
    } else if (net?.verdict === "failed") {
      const np = (net.observed as { netProfitToman?: number } | null)?.netProfitToman;
      if (typeof np === "number") {
        closestNet.push({
          routeKey: c.routeKey,
          lifecycleId: c.lifecycleId,
          netProfitToman: np,
          at: row.occurred_at,
          terminal: c.terminalReason ?? null,
        });
      }
    }
    if (isFullPath(c)) {
      const le = (c.lifecycleEvidence ?? {}) as Record<string, unknown>;
      fullPath.push({
        traceId: row.id,
        decisionTraceId: row.id,
        at: row.occurred_at,
        lifecycleId: c.lifecycleId,
        routeKey: c.routeKey,
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
        residualLogicExercised: residualExercised(c),
        stages,
        evidence: {
          allocator: le.allocator ?? null,
          sizes: le.sizes ?? null,
          delayedRecheck: le.delayedRecheck ?? null,
          vwap: le.vwap ?? null,
          edges: le.edges ?? null,
          capitalInventory: le.capitalInventory ?? null,
          diagnostics: le.diagnostics ?? null,
          timestamps: le.timestamps ?? null,
        },
      });
    }
  }
}

closestNet.sort((a, b) => (b.netProfitToman ?? -1e99) - (a.netProfitToman ?? -1e99));

const fillRes = await db.execute(sql`SELECT count(*)::int AS n FROM shadow_paper_ledger WHERE outcome = 'FILLED'`);
fills = Number(((fillRes as { rows?: Array<{ n: number }> }).rows ?? [{ n: 0 }])[0]?.n ?? 0);

try {
  const rr = await db.execute(sql`SELECT count(*)::int AS n FROM shadow_paper_residual_liquidity`);
  residualRows = Number(((rr as { rows?: Array<{ n: number }> }).rows ?? [{ n: 0 }])[0]?.n ?? 0);
} catch {
  residualRows = -1;
}

const sessionRes = await db.execute(sql`
  SELECT id::text, status, cycles_evaluated, trades_executed, candidates_skipped, observation_id::text,
    total_capital_toman, last_cycle_at::text
  FROM shadow_paper_sessions ORDER BY created_at DESC LIMIT 1
`);
const session = ((sessionRes as { rows?: unknown[] }).rows ?? [])[0] ?? null;

const best = fullPath[0] ?? null;
const summary = {
  at: new Date().toISOString(),
  traces: rows.length,
  fills,
  residualRows,
  session,
  stagePassCounts,
  terminalReasons,
  netPassedCount: netPassed.length,
  fullPathCount: fullPath.length,
  closestNetAttempts: closestNet.slice(0, 10),
  netPassedSample: netPassed.slice(0, 5),
  fullPathSample: fullPath.slice(0, 5),
  REAL_MARKET_FULL_PATH_VALIDATED: fullPath.length > 0 ? "YES" : "NO",
  REAL_MARKET_RESIDUAL_LOGIC_EXERCISED:
    fullPath.some((x) => (x as { residualLogicExercised?: boolean }).residualLogicExercised) ? "YES" : "NO",
  best,
};

writeFileSync(path.join(ART, "audit", "full-path-scan.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({
  traces: summary.traces,
  fills: summary.fills,
  residualRows: summary.residualRows,
  netPassedCount: summary.netPassedCount,
  fullPathCount: summary.fullPathCount,
  stagePassCounts: summary.stagePassCounts,
  closest0: summary.closestNetAttempts[0] ?? null,
  REAL_MARKET_FULL_PATH_VALIDATED: summary.REAL_MARKET_FULL_PATH_VALIDATED,
  REAL_MARKET_RESIDUAL_LOGIC_EXERCISED: summary.REAL_MARKET_RESIDUAL_LOGIC_EXERCISED,
  bestLifecycleId: (best as { lifecycleId?: string } | null)?.lifecycleId ?? null,
}, null, 2));
await closeDb();
