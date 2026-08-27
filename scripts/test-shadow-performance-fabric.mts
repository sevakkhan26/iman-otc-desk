#!/usr/bin/env npx tsx
/** SHADOW-TASK-007 deterministic Paper performance-fabric acceptance tests. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  PaperMarketDataFabric,
  assessCrossVenueCoherence,
  type NormalizedBookEvent
} from "../src/lib/shadowArbitrage/streaming/eventFabric.ts";
import {
  OpportunitySurvivalTracker,
  estimateFromLifecycle,
  type SurvivalEstimate
} from "../src/lib/shadowArbitrage/paper/opportunitySurvival.ts";
import {
  deriveInventoryShadowPrices,
  scorePaperCandidate,
  type ExecutionScoringPolicy
} from "../src/lib/shadowArbitrage/paper/executionScoring.ts";
import {
  allocatePaperRoutes,
  type AllocatorCandidate,
  type PaperAllocatorInput
} from "../src/lib/shadowArbitrage/paper/portfolioAllocator.ts";
import { LIVE_EXECUTION_IMPLEMENTED } from "../src/lib/shadowArbitrage/live/capability.ts";

const replay = JSON.parse(
  readFileSync(
    new URL("../fixtures/shadow-performance-replay.json", import.meta.url),
    "utf8"
  )
) as {
  events: NormalizedBookEvent[];
  eventDecisionLatencyMs: number[];
  pollingDecisionLatencyMs: number[];
};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.stack ?? error.message : error}`);
    failed += 1;
  }
}

function percentile(values: number[], percentileValue: number): number {
  const ordered = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(ordered.length - 1, Math.ceil(percentileValue * ordered.length) - 1)
  );
  return ordered[index];
}

const benchmark = {
  event: {
    p50: percentile(replay.eventDecisionLatencyMs, 0.5),
    p95: percentile(replay.eventDecisionLatencyMs, 0.95),
    p99: percentile(replay.eventDecisionLatencyMs, 0.99)
  },
  polling: {
    p50: percentile(replay.pollingDecisionLatencyMs, 0.5),
    p95: percentile(replay.pollingDecisionLatencyMs, 0.95),
    p99: percentile(replay.pollingDecisionLatencyMs, 0.99)
  }
};
let guardBenchmark: {
  options: number;
  nodes: number;
  solveTimeMs: number;
  reason: string | null;
} | null = null;

await test("1) event path is faster than 15-30s polling and coherently fresh", () => {
  const fabric = new PaperMarketDataFabric([
    { sourceId: "nobitex", sequencePolicy: "STRICT_INCREMENT" },
    { sourceId: "tabdeal", sequencePolicy: "FULL_SNAPSHOT_NO_SEQUENCE" }
  ]);
  const buy = fabric.ingest(replay.events[0]).snapshot;
  const sell = fabric.ingest(replay.events[1]).snapshot;
  const coherence = assessCrossVenueCoherence({
    buy: buy ?? undefined,
    sell: sell ?? undefined,
    decisionTimestampMs: 1_000_030,
    maxAgeMs: 2_000,
    maxSourceSkewMs: 100
  });
  assert.equal(coherence.coherent, true);
  assert.equal(coherence.eventToDecisionLatencyMs, 5);
  assert.ok(benchmark.event.p95 < 15_000);
  assert.ok(benchmark.event.p99 < benchmark.polling.p50);
});

await test("2) dropped/out-of-order/reconnect blocks until a full snapshot resync", () => {
  const fabric = new PaperMarketDataFabric([
    { sourceId: "nobitex", sequencePolicy: "STRICT_INCREMENT" }
  ]);
  assert.equal(fabric.ingest(replay.events[0]).accepted, true);
  assert.equal(fabric.ingest(replay.events[2]).accepted, true);
  const gap = fabric.ingest(replay.events[3]);
  assert.equal(gap.reason, "sequence_gap");
  assert.equal(gap.decisionReady, false);
  assert.equal(fabric.snapshot("nobitex"), null);
  assert.equal(fabric.ingest(replay.events[4]).reason, "awaiting_snapshot");
  const recovered = fabric.ingest(replay.events[5]);
  assert.equal(recovered.decisionReady, true);
  const outOfOrder = fabric.ingest({
    ...replay.events[2],
    sequence: 199,
    receiveTimestampMs: 1_002_500
  });
  assert.equal(outOfOrder.reason, "out_of_order");
  fabric.onReconnect("nobitex");
  assert.equal(fabric.telemetry("nobitex", 1_002_600).snapshotResyncState, "AWAITING_SNAPSHOT");
  assert.equal(fabric.snapshot("nobitex"), null);
});

const executionPolicy: ExecutionScoringPolicy = {
  freshnessBudgetMs: 10_000,
  latencyBudgetMs: 1_000,
  jitterBudgetMs: 1_000,
  defaultFillConfidence: 1,
  defaultPartialFillRisk: 0,
  provenance: "TASK_007_TEST_POLICY"
};

function lifecycleEstimate(durationMs: number): SurvivalEstimate {
  return estimateFromLifecycle({
    routeKey: "route",
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    durationMs,
    observationCount: 4
  });
}

await test("3) equal raw RA ranks persistent opportunity higher without changing raw economics", () => {
  const fleeting = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 1_000,
    survival: lifecycleEstimate(200),
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 0,
    sellUsdtMicros: 0,
    buySourceId: "a",
    sellSourceId: "b",
    inventoryImpactPoints: 0,
    policy: executionPolicy
  });
  const persistent = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 1_000,
    survival: lifecycleEstimate(4_000),
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 0,
    sellUsdtMicros: 0,
    buySourceId: "a",
    sellSourceId: "b",
    inventoryImpactPoints: 0,
    policy: executionPolicy
  });
  assert.equal(fleeting.canonicalRiskAdjustedPnlToman, 1_000);
  assert.equal(persistent.canonicalRiskAdjustedPnlToman, 1_000);
  assert.ok(persistent.adjustedObjectiveToman > fleeting.adjustedObjectiveToman);
});

await test("4) replay tracker reports recurrence, disappearance and empirical survival", () => {
  const tracker = new OpportunitySurvivalTracker();
  for (const point of [
    { routeKey: "r", observedAtMs: 0, active: true },
    { routeKey: "r", observedAtMs: 3_000, active: false },
    { routeKey: "r", observedAtMs: 4_000, active: true },
    { routeKey: "r", observedAtMs: 7_000, active: false }
  ]) {
    tracker.observe(point);
  }
  const estimate = tracker.estimate("r", 7_000);
  assert.equal(estimate.recurrenceCount, 1);
  assert.equal(estimate.disappearanceCount, 2);
  assert.equal(estimate.empiricalSurvivalAtHorizon, 1);
  assert.equal(estimate.empiricalHalfLifeMs, 3_000);
});

const MARK = 100_000;
function allocatorCandidate(input: {
  id: string;
  routeKey?: string;
  capital: number;
  raw: number;
  adjusted?: number;
  buy?: string;
  sell?: string;
  repairing?: boolean;
}): AllocatorCandidate {
  const buy = input.buy ?? "buy";
  const sell = input.sell ?? "sell";
  const buyIrt = input.capital / 2;
  return {
    lifecycleId: input.id,
    allocationKey: input.id,
    routeKey: input.routeKey ?? input.id,
    buySourceId: buy,
    sellSourceId: sell,
    sizeUsdt: buyIrt / MARK,
    buyVwapToman: MARK,
    sellVwapToman: MARK + 100,
    riskAdjustedPnlToman: input.raw,
    economicNetPnlToman: input.raw + 1,
    adjustedScoreToman: input.adjusted,
    buyNotionalToman: buyIrt,
    buyIrtRequiredToman: buyIrt,
    sellUsdtMicros: (buyIrt / MARK) * 1_000_000,
    capitalLockedToman: input.capital,
    buyAcceptedDepthToman: buyIrt,
    sellAcceptedDepthToman: buyIrt,
    inventoryImpactPoints: input.repairing ? -1 : 1,
    readiness: { healthy: true, fresh: true, feeCertain: true }
  };
}

function allocatorInput(
  candidates: AllocatorCandidate[],
  equityToman: number,
  overrides: Partial<PaperAllocatorInput> = {}
): PaperAllocatorInput {
  const venues = new Set(
    candidates.flatMap((candidate) => [
      candidate.buySourceId,
      candidate.sellSourceId
    ])
  );
  return {
    candidates,
    equityToman,
    markPriceToman: MARK,
    venueExposureToman: new Map([...venues].map((venue) => [venue, 0])),
    availableIrtByVenue: new Map(
      [...venues].map((venue) => [venue, equityToman])
    ),
    availableUsdtMicrosByVenue: new Map(
      [...venues].map((venue) => [venue, (equityToman / MARK) * 1_000_000])
    ),
    ...overrides
  };
}

await test("5) scarce inventory shadow price preserves higher future capacity", () => {
  const prices = deriveInventoryShadowPrices({
    availableUnits: new Map([["shared|IRT", 0]]),
    futureDemand: [
      {
        sourceId: "shared",
        asset: "IRT",
        requiredUnits: 50,
        canonicalRiskAdjustedPnlToman: 100,
        captureConfidence: 1
      }
    ]
  });
  const consuming = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 110,
    survival: lifecycleEstimate(4_000),
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 50,
    sellUsdtMicros: 0,
    buySourceId: "shared",
    sellSourceId: "x",
    inventoryImpactPoints: 1,
    shadowPrices: prices,
    policy: executionPolicy
  });
  const preserving = allocatorCandidate({
    id: "preserve",
    routeKey: "z-preserve",
    capital: 100,
    raw: 80,
    adjusted: 80,
    buy: "other",
    sell: "shared-sell"
  });
  const consume = allocatorCandidate({
    id: "consume",
    routeKey: "a-consume",
    capital: 100,
    raw: 110,
    adjusted: consuming.adjustedObjectiveToman,
    buy: "shared",
    sell: "other-sell"
  });
  const result = allocatePaperRoutes(
    allocatorInput([consume, preserving], 1_000, {
      maxVenueExposurePercent: 100
    })
  );
  assert.equal(result.selected[0].candidate.lifecycleId, "preserve");
});

await test("6) inventory-repairing route gets no fake bonus and no depletion charge", () => {
  const prices = deriveInventoryShadowPrices({
    availableUnits: new Map([["a|IRT", 0]]),
    futureDemand: [
      {
        sourceId: "a",
        asset: "IRT",
        requiredUnits: 100,
        canonicalRiskAdjustedPnlToman: 100,
        captureConfidence: 1
      }
    ]
  });
  const score = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 100,
    survival: lifecycleEstimate(4_000),
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 100,
    sellUsdtMicros: 0,
    buySourceId: "a",
    sellSourceId: "b",
    inventoryImpactPoints: -1,
    shadowPrices: prices,
    policy: executionPolicy
  });
  assert.equal(score.inventoryOpportunityCostToman, 0);
  assert.equal(score.adjustedObjectiveToman, 100);
});

await test("7) partial-fill, latency and age lower score without changing fees/slippage", () => {
  const baseline = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 1_000,
    survival: lifecycleEstimate(4_000),
    fillConfidence: 1,
    partialFillRisk: 0,
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 0,
    sellUsdtMicros: 0,
    buySourceId: "a",
    sellSourceId: "b",
    inventoryImpactPoints: 0,
    policy: executionPolicy
  });
  const impaired = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 1_000,
    survival: lifecycleEstimate(4_000),
    fillConfidence: 0.8,
    partialFillRisk: 0.2,
    sourceAgeMs: 2_000,
    venueLatencyMs: 200,
    venueJitterMs: 100,
    buyIrtRequiredToman: 0,
    sellUsdtMicros: 0,
    buySourceId: "a",
    sellSourceId: "b",
    inventoryImpactPoints: 0,
    policy: executionPolicy
  });
  assert.equal(impaired.canonicalRiskAdjustedPnlToman, baseline.canonicalRiskAdjustedPnlToman);
  assert.ok(impaired.adjustedObjectiveToman < baseline.adjustedObjectiveToman);
});

await test("8) 100M/1B/10B stay deterministic at or below the 90% ceiling", () => {
  for (const equity of [100_000_000, 1_000_000_000, 10_000_000_000]) {
    const rows = [
      allocatorCandidate({
        id: `a-${equity}`,
        capital: equity * 0.45,
        raw: 100,
        buy: `a-buy-${equity}`,
        sell: `a-sell-${equity}`
      }),
      allocatorCandidate({
        id: `b-${equity}`,
        capital: equity * 0.45,
        raw: 90,
        buy: `b-buy-${equity}`,
        sell: `b-sell-${equity}`
      })
    ];
    const first = allocatePaperRoutes(allocatorInput(rows, equity));
    const second = allocatePaperRoutes(allocatorInput(rows, equity));
    assert.ok(first.telemetry.utilizationPercent <= 90);
    assert.deepEqual(
      first.selected.map((row) => row.candidate.lifecycleId),
      second.selected.map((row) => row.candidate.lifecycleId)
    );
  }
});

await test("9) adjusted exact objective is more defensible than Task-006 raw-only tie", () => {
  const fleetingScore = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 100,
    survival: lifecycleEstimate(100),
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 50,
    sellUsdtMicros: 0,
    buySourceId: "shared",
    sellSourceId: "f",
    inventoryImpactPoints: 0,
    policy: executionPolicy
  });
  const persistentScore = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 100,
    survival: lifecycleEstimate(4_000),
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 50,
    sellUsdtMicros: 0,
    buySourceId: "shared",
    sellSourceId: "p",
    inventoryImpactPoints: 0,
    policy: executionPolicy
  });
  const rawRows = [
    allocatorCandidate({
      id: "fleeting",
      routeKey: "a-fleeting",
      capital: 100,
      raw: 100,
      buy: "shared",
      sell: "f"
    }),
    allocatorCandidate({
      id: "persistent",
      routeKey: "z-persistent",
      capital: 100,
      raw: 100,
      buy: "shared",
      sell: "p"
    })
  ];
  const constrained = {
    availableIrtByVenue: new Map([
      ["shared", 50],
      ["f", 1_000],
      ["p", 1_000]
    ])
  };
  const task006 = allocatePaperRoutes(
    allocatorInput(rawRows, 1_000, constrained)
  );
  const adjustedRows = rawRows.map((row) => ({
    ...row,
    adjustedScoreToman:
      row.lifecycleId === "fleeting"
        ? fleetingScore.adjustedObjectiveToman
        : persistentScore.adjustedObjectiveToman
  }));
  const task007 = allocatePaperRoutes(
    allocatorInput(adjustedRows, 1_000, constrained)
  );
  assert.equal(task006.selected[0].candidate.lifecycleId, "fleeting");
  assert.equal(task007.selected[0].candidate.lifecycleId, "persistent");
  assert.ok(
    persistentScore.adjustedObjectiveToman >
      fleetingScore.adjustedObjectiveToman
  );
});

await test("10) exact guard and LIVE=false remain structural", () => {
  const rows = Array.from({ length: 1_000 }, (_, index) =>
    allocatorCandidate({
      id: `guard-${index}`,
      capital: 10,
      raw: 1_000 - index / 1_000,
      buy: "guard-buy",
      sell: "guard-sell"
    })
  );
  const guarded = allocatePaperRoutes(
    allocatorInput(rows, 1_000, {
      searchBudget: { maxOptions: 128, maxNodes: 100 }
    })
  );
  assert.equal(guarded.selected.length, 0);
  assert.equal(guarded.search.proofStatus, "BUDGET_EXHAUSTED_FAIL_CLOSED");
  guardBenchmark = {
    options: guarded.search.optionsConsidered,
    nodes: guarded.search.nodesVisited,
    solveTimeMs: guarded.search.solveTimeMs,
    reason: guarded.search.failClosedReason
  };
  assert.equal(LIVE_EXECUTION_IMPLEMENTED, false);
});

console.log(`\nLatency benchmark ${JSON.stringify(benchmark)}`);
console.log(`Allocator guard benchmark ${JSON.stringify(guardBenchmark)}`);
console.log(`Result: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
