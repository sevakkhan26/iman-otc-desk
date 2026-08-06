#!/usr/bin/env npx tsx
/**
 * Decision monitor + local 100M session — pure + PGlite tests.
 * No production contact.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  buildCandidateTraces,
  cycleOutcomeFromTraces
} from "../src/lib/shadowArbitrage/paper/decisionTraceCapture.ts";
import type { PaperDecision } from "../src/lib/shadowArbitrage/paper/engine.ts";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

const skip = (partial: Partial<PaperDecision> & { candidate: PaperDecision extends { candidate: infer C } ? C : never }): PaperDecision =>
  ({
    kind: "SKIP",
    code: "net_non_positive",
    codes: ["net_non_positive"],
    reasonFa: "رد تست",
    requiredRebalance: null,
    ...partial
  }) as PaperDecision;

await test("candidate ranks and statuses map without inventing trades", () => {
  const decisions: PaperDecision[] = [
    skip({
      candidate: {
        lifecycleId: "a",
        routeKey: "n->w",
        buySourceId: "nobitex" as never,
        sellSourceId: "wallex" as never,
        sizeUsdt: 10,
        buyVwapToman: 100,
        sellVwapToman: 101,
        netProfitToman: -1,
        slippageBufferToman: 0,
        buyFeeBps: 10,
        sellFeeBps: 10
      }
    })
  ];
  const traces = buildCandidateTraces({
    decisions,
    evaluation: {
      decisions,
      balancesAfter: [],
      eligibleCandidates: 0,
      executedCount: 0,
      sizing: [],
      reservations: { irtToman: 0, usdtMicros: 0, holds: 0 },
      peakUtilizationPercent: null
    },
    filledLifecycleIds: new Set(),
    venueCount: 2
  });
  assert.equal(traces.length, 1);
  assert.equal(traces[0].status, "rejected");
  assert.notEqual(traces[0].statusFa, "✓ معامله شد");
  assert.equal(traces[0].selected, false);
});

await test("traded checkmark only when lifecycle is in filled set", () => {
  const exec: PaperDecision = {
    kind: "EXECUTE",
    candidate: {
      lifecycleId: "fill-me",
      routeKey: "n->w",
      buySourceId: "nobitex" as never,
      sellSourceId: "wallex" as never,
      sizeUsdt: 25,
      buyVwapToman: 200_000,
      sellVwapToman: 201_000,
      netProfitToman: 1000,
      slippageBufferToman: 10,
      buyFeeBps: 10,
      sellFeeBps: 10
    },
    plan: {
      ok: true,
      buyLeg: {
        sourceId: "nobitex" as never,
        side: "buy",
        sizeUsdt: 25,
        vwapToman: 200_000,
        notionalToman: 5_000_000,
        feeBps: 10,
        feeToman: 5000,
        feeUsdtMicros: 0,
        deltaIrtToman: -5_005_000,
        deltaUsdtMicros: 25_000_000,
        settlement: {
          feeAsset: "IRT",
          debitMode: "ADD_TO_COST",
          provenance: "ADMIN"
        }
      },
      sellLeg: {
        sourceId: "wallex" as never,
        side: "sell",
        sizeUsdt: 25,
        vwapToman: 201_000,
        notionalToman: 5_025_000,
        feeBps: 10,
        feeToman: 0,
        feeUsdtMicros: 25_000,
        deltaIrtToman: 5_025_000,
        deltaUsdtMicros: -25_025_000,
        settlement: {
          feeAsset: "USDT",
          debitMode: "DEDUCT_FROM_PROCEEDS",
          provenance: "ADMIN"
        }
      },
      totalFeeToman: 5000,
      totalFeeUsdtMicros: 25_000,
      slippageBufferToman: 10,
      grossSpreadToman: 25_000,
      markPriceToman: 200_500,
      cashPnlIrtToman: 20_000,
      inventoryDeltaUsdtMicros: 0,
      sellFeeValueToman: 5000,
      economicNetPnlToman: 15_000,
      riskAdjustedPnlToman: 14_000
    } as never,
    balancesAfter: [],
    sizing: {
      status: "SIZED",
      policy: "SMART_CAPITAL_DEPTH",
      sizeUsdtMicros: 25_000_000,
      quote: null,
      economics: null,
      capacity: null,
      selection: null,
      bindingConstraint: "depth_cap",
      inventory: null
    } as never
  };
  const selectedOnly = buildCandidateTraces({
    decisions: [exec],
    evaluation: {
      decisions: [exec],
      balancesAfter: [],
      eligibleCandidates: 1,
      executedCount: 1,
      sizing: [],
      reservations: { irtToman: 0, usdtMicros: 0, holds: 0 },
      peakUtilizationPercent: null
    },
    filledLifecycleIds: new Set(),
    venueCount: 2
  });
  assert.equal(selectedOnly[0].status, "selected");
  assert.notEqual(selectedOnly[0].statusFa.includes("معامله شد"), true);

  const traded = buildCandidateTraces({
    decisions: [exec],
    evaluation: {
      decisions: [exec],
      balancesAfter: [],
      eligibleCandidates: 1,
      executedCount: 1,
      sizing: [],
      reservations: { irtToman: 0, usdtMicros: 0, holds: 0 },
      peakUtilizationPercent: null
    },
    filledLifecycleIds: new Set(["fill-me"]),
    venueCount: 2
  });
  assert.equal(traded[0].status, "traded");
  assert.equal(traded[0].statusFa, "✓ معامله شد");
});

await test("cycle outcome helpers", () => {
  const o = cycleOutcomeFromTraces([], 0);
  assert.equal(o.outcome, "empty");
  const filled = cycleOutcomeFromTraces(
    [
      {
        rank: 1,
        lifecycleId: "x",
        routeKey: "a->b",
        buySourceId: "a",
        sellSourceId: "b",
        sizeUsdt: 1,
        buyVwapToman: 1,
        sellVwapToman: 1,
        grossSpreadToman: 0,
        economicNetPnlToman: 1,
        riskAdjustedPnlToman: 1,
        buyFeeBps: null,
        sellFeeBps: null,
        feeTomanTotal: null,
        slippageBufferToman: null,
        bindingConstraint: null,
        sizingReason: null,
        status: "traded",
        statusFa: "✓ معامله شد",
        reasonFa: null,
        reasonCodes: [],
        selected: true,
        ledgerId: "L",
        capitalCapUsdt: null,
        depthCapUsdt: null
      }
    ],
    1
  );
  assert.equal(filled.outcome, "filled");
});

/* PGlite: 100M session + decision trace append */
const scratch = await mkdtemp(path.join(tmpdir(), "otc-dm-"));
process.env.DATABASE_URL = `pglite:${path.join(scratch, "db")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";
process.env.SHADOW_DECISION_TRACE = "true";
process.env.NODE_ENV = "development";

const { runMigrations } = await import("../src/db/migrate.ts");
const { closeDb } = await import("../src/db/client.ts");
const {
  createPaperSession,
  setPaperSessionStatus,
  getActivePaperSession,
  loadPaperBalances
} = await import("../src/db/repositories/shadowPaper.ts");
const { defaultAllocation } = await import("../src/lib/shadowArbitrage/paper/portfolio.ts");
const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");
const {
  appendDecisionTrace,
  listDecisionTraces,
  decisionTraceEnabled,
  firstCompleteTraceAt
} = await import("../src/db/repositories/shadowDecisionTraces.ts");

await runMigrations();

await test("decision trace enabled in development", () => {
  assert.equal(decisionTraceEnabled(), true);
});

await test("exact 100_000_000 capital session with zero residual", async () => {
  const CAPITAL = 100_000_000;
  const MARK = 200_000;
  const venues = SHADOW_SOURCES.map((s) => s.id);
  const alloc = defaultAllocation(CAPITAL, venues, MARK);
  const total =
    alloc.reduce((s, a) => s + a.irtToman, 0) +
    alloc.reduce((s, a) => s + Math.round(a.usdtUnits * MARK), 0);
  assert.equal(total, CAPITAL);

  const prior = await getActivePaperSession();
  if (prior && prior.status !== "STOPPED") {
    await setPaperSessionStatus(prior.id, "STOPPED");
  }

  const session = await createPaperSession({
    observationId: null,
    name: "test-100m",
    mode: "APPROVED_PLAN",
    totalCapitalToman: CAPITAL,
    valuationPriceToman: MARK,
    openingAllocations: alloc,
    approvalFingerprint: "test",
    createdBy: "test"
  });
  await setPaperSessionStatus(session.id, "RUNNING");
  assert.equal(session.totalCapitalToman, CAPITAL);

  const bals = await loadPaperBalances(session.id);
  assert.equal(bals.length, venues.length);

  // restart simulation: same active session
  const again = await getActivePaperSession();
  assert.equal(again?.id, session.id);
  assert.equal(again?.totalCapitalToman, CAPITAL);

  // no duplicate: second create would be another session but active remains one
  const active = await getActivePaperSession();
  assert.ok(active);
  assert.equal(active!.status, "RUNNING");
});

await test("append and page decision traces; first complete cycle", async () => {
  const session = await getActivePaperSession();
  assert.ok(session);
  const t0 = "2026-08-06T10:00:00.000Z";
  const t1 = "2026-08-06T10:00:30.000Z";
  const baseCand = {
    rank: 1,
    lifecycleId: "L1",
    routeKey: "a->b",
    buySourceId: "a",
    sellSourceId: "b",
    sizeUsdt: 10,
    buyVwapToman: 100,
    sellVwapToman: 101,
    grossSpreadToman: 10,
    economicNetPnlToman: 5,
    riskAdjustedPnlToman: 4,
    buyFeeBps: 10,
    sellFeeBps: 10,
    feeTomanTotal: 1,
    slippageBufferToman: 0,
    bindingConstraint: null as string | null,
    sizingReason: null as string | null,
    status: "traded" as const,
    statusFa: "✓ معامله شد",
    reasonFa: null as string | null,
    reasonCodes: [] as string[],
    selected: true,
    ledgerId: "ledger-1",
    capitalCapUsdt: 100,
    depthCapUsdt: 50
  };
  const w0 = await appendDecisionTrace({
    sessionId: session!.id,
    runId: null,
    occurredAt: t0,
    venuesAvailable: 9,
    routesEvaluated: 1,
    sizesEvaluated: 1,
    candidates: [baseCand],
    selectedLifecycleId: "L1",
    filledCount: 1,
    outcome: "filled",
    outcomeReasonFa: "ok",
    snapshotRef: "snap-0",
    releaseVersion: "local",
    policyFingerprint: "fp",
    traceComplete: true
  });
  assert.ok("id" in w0);
  await appendDecisionTrace({
    sessionId: session!.id,
    runId: null,
    occurredAt: t1,
    venuesAvailable: 9,
    routesEvaluated: 1,
    sizesEvaluated: 1,
    candidates: [{ ...baseCand, lifecycleId: "L2", status: "rejected", statusFa: "رد شد", selected: false, ledgerId: null }],
    selectedLifecycleId: null,
    filledCount: 0,
    outcome: "all_rejected",
    outcomeReasonFa: "none",
    snapshotRef: "snap-1",
    releaseVersion: "local",
    policyFingerprint: "fp",
    traceComplete: true
  });

  const page = await listDecisionTraces({ sessionId: session!.id, limit: 1 });
  assert.equal(page.rows.length, 1);
  assert.ok(page.nextCursor);
  const page2 = await listDecisionTraces({
    sessionId: session!.id,
    limit: 10,
    cursor: page.nextCursor
  });
  assert.ok(page2.rows.length >= 1);
  // candidates belong to their cycle
  for (const row of [...page.rows, ...page2.rows]) {
    for (const c of row.candidates) {
      assert.ok(c.lifecycleId);
      if (c.status === "traded") assert.ok(c.statusFa.includes("معامله"));
      if (c.status === "rejected") assert.notEqual(c.statusFa, "✓ معامله شد");
    }
  }
  const first = await firstCompleteTraceAt(session!.id);
  assert.ok(first);
  assert.equal(Date.parse(first!), Date.parse(t0));
});

await closeDb();
await rm(scratch, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
