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
  DEFAULT_SURVIVAL_POLICY,
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
import { evaluateCycle } from "../src/lib/shadowArbitrage/paper/engine.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
import {
  seedLocalPaperExecutionLimits
} from "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts";
import {
  STREAM_POLICIES,
  WallexDepthAssembler,
  parseNobitexPublication,
  parseTabdealDepth
} from "../src/lib/shadowArbitrage/streaming/venueAdapters.ts";
import {
  ingestPublicStreamMessage,
  markPublicStreamReconnect,
  paperStreamTelemetry,
  registerRestStreamRecovery,
  subscribePaperMarketDecisions,
  subscribePaperRestRecoveryRequests
} from "../src/lib/shadowArbitrage/streaming/runtime.ts";
import { LIVE_EXECUTION_IMPLEMENTED } from "../src/lib/shadowArbitrage/live/capability.ts";

const replay = JSON.parse(
  readFileSync(
    new URL("../fixtures/shadow-performance-replay.json", import.meta.url),
    "utf8"
  )
) as {
  events: NormalizedBookEvent[];
};

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  if (process.env.ONLY_TEST && !name.startsWith(process.env.ONLY_TEST)) return;
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

let benchmark: {
  event: { p50: number; p95: number; p99: number };
  pollingFloorMs: number;
} | null = null;
let guardBenchmark: {
  options: number;
  nodes: number;
  solveTimeMs: number;
  reason: string | null;
} | null = null;

seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.1 });

const TEST_NOW_ISO = new Date(1_000_030).toISOString();
function paperPolicies() {
  return buildPolicyState(
    [
      ["max_order_size_usdt", 100],
      ["max_venue_exposure_percent", 100],
      ["min_risk_adjusted_edge_percent", 0.01],
      ["max_quote_age_ms", 30_000],
      ["max_slippage_bps", 5],
      ["max_inventory_deviation_percent", 100]
    ].map(([key, value]) => ({
      key: key as never,
      value: value as number,
      provenance: "ADMIN_APPROVED" as const,
      setBy: "task-007-r1-test",
      setAt: TEST_NOW_ISO,
      validForDays: null,
      note: null
    })),
    1_000_030
  );
}

function paperOpportunity(
  id: string,
  buySourceId: "nobitex",
  sellSourceId: "tabdeal" | "wallex"
) {
  return {
    id,
    routeKey: `${buySourceId}->${sellSourceId}`,
    buySourceId,
    sellSourceId,
    buySourceName: buySourceId,
    sellSourceName: sellSourceId,
    sizeUsdt: 10,
    buyVwapToman: 100_000,
    sellVwapToman: 101_000,
    rawSpreadPercent: 1,
    buyFeeToman: 2_500,
    sellFeeToman: 2_525,
    buyFeeBps: 25,
    sellFeeBps: 25,
    totalFeePercent: 0.5,
    slippageBufferToman: 500,
    rebalanceCostToman: 0,
    netProfitToman: 4_475,
    netEdgePercent: 0.4475,
    buyCostToman: 1_000_000,
    sellProceedsToman: 1_010_000,
    eligibility: "EXECUTABLE_NOW" as const,
    blockedReasons: [],
    firstSeenAt: TEST_NOW_ISO,
    lastSeenAt: TEST_NOW_ISO,
    endedAt: null,
    durationMs: 0,
    maxNetEdgePercent: 0.4475,
    maxNetProfitToman: 4_475,
    maxRawSpreadPercent: 1,
    feeUnknown: false,
    observationCount: 1,
    isActive: true,
    buyAgeMs: 0,
    sellAgeMs: 0
  };
}

function evaluateSyntheticEventDecision(
  buy: NonNullable<ReturnType<PaperMarketDataFabric["snapshot"]>>,
  sell: NonNullable<ReturnType<PaperMarketDataFabric["snapshot"]>>,
  completedAtMs: number,
  tracker?: OpportunitySurvivalTracker
) {
  const sourceIds = [buy.sourceId, sell.sourceId];
  return evaluateCycle({
    opportunities: [
      paperOpportunity(
        `decision-${completedAtMs}`,
        "nobitex",
        sell.sourceId as "tabdeal" | "wallex"
      )
    ],
    sources: [buy, sell],
    venueStates: sourceIds.map((sourceId) => ({
      sourceId,
      executable: true,
      capitalClass: "EXECUTABLE",
      takerFeeBps: 25,
      feeProvenance: "ADMIN_CONFIRMED",
      feeStale: false
    })) as never,
    executedLifecycleIds: new Set(),
    balances: sourceIds.map((sourceId) => ({
      sourceId,
      irtToman: 100_000_000,
      usdtMicros: 1_000_000_000
    })) as never,
    sizing: {
      policies: paperPolicies(),
      allocationTomanBySource: new Map(
        sourceIds.map((sourceId) => [sourceId, 100_000_000])
      ),
      portfolioValueToman: 200_000_000,
      exposureTomanBySource: new Map(sourceIds.map((sourceId) => [sourceId, 0])),
      slippageBufferBps: 5,
      inventoryModel: {
        valuationPriceToman: 100_000,
        targets: sourceIds.map((sourceId) => ({
          sourceId,
          targetUsdtSharePercent: 50
        })),
        maxDeviationPoints: 100
      }
    },
    portfolioLimits: {
      enabled: false,
      equityToman: 200_000_000,
      markPriceToman: 100_000
    },
    decisionTimestampMs: completedAtMs - 2,
    decisionClock: () => completedAtMs,
    survivalTracker: tracker,
    maxCrossVenueSkewMs: 100
  } as never);
}

await test("1) measured synthetic ingest-to-evaluateCycle completion beats polling", () => {
  const measured: number[] = [];
  for (let index = 0; index < 20; index += 1) {
    const shift = index * 10_000;
    const fabric = new PaperMarketDataFabric([
      { sourceId: "nobitex", sequencePolicy: "MONOTONIC_VERSION" },
      { sourceId: "tabdeal", sequencePolicy: "FULL_SNAPSHOT_NO_SEQUENCE" }
    ]);
    const buy = fabric.ingest({
      ...replay.events[0],
      sequence: 1_000 + index,
      sourceEventTimestampMs: 1_000_000 + shift,
      receiveTimestampMs: 1_000_018 + shift
    }).snapshot;
    const sell = fabric.ingest({
      ...replay.events[1],
      sourceEventTimestampMs: 1_000_005 + shift,
      receiveTimestampMs: 1_000_025 + shift
    }).snapshot;
    assert.ok(buy && sell);
    const completedAtMs = 1_000_025 + shift + (index + 1) * 3;
    const evaluation = evaluateSyntheticEventDecision(
      buy,
      sell,
      completedAtMs
    );
    assert.equal(evaluation.marketData.decisionCompletedTimestampMs, completedAtMs);
    assert.deepEqual(evaluation.marketData.sourceEventLatencyMs, [18, 20]);
    assert.ok(evaluation.marketData.receiveAgeMs.length === 2);
    assert.equal(evaluation.marketData.ingestToDecisionLatencyMs.length, 1);
    assert.equal(
      evaluation.marketData.eventToDecisionLatencyMs[0],
      evaluation.marketData.ingestToDecisionLatencyMs[0]
    );
    measured.push(evaluation.marketData.ingestToDecisionLatencyMs[0]);
  }
  benchmark = {
    event: {
      p50: percentile(measured, 0.5),
      p95: percentile(measured, 0.95),
      p99: percentile(measured, 0.99)
    },
    pollingFloorMs: 15_000
  };
  assert.ok(benchmark.event.p95 < benchmark.pollingFloorMs);
  assert.ok(benchmark.event.p99 < benchmark.pollingFloorMs);
});

await test("2) production parsers enforce snapshot+monotonic and timestamp policies", () => {
  const nobitexPolicy = STREAM_POLICIES.find((row) => row.sourceId === "nobitex");
  assert.equal(nobitexPolicy?.sequencePolicy, "MONOTONIC_VERSION");
  const nobitexMessage = (offset: number, lastUpdate: number) => ({
    push: {
      channel: "public:orderbook-USDTIRT",
      pub: {
        offset,
        data: {
          lastUpdate,
          bids: [["1000000", "100"]],
          asks: [["1001000", "100"]]
        }
      }
    }
  });
  const first = parseNobitexPublication(
    nobitexMessage(100, 2_000_000),
    2_000_010
  );
  const laterFullSnapshot = parseNobitexPublication(
    nobitexMessage(102, 2_000_020),
    2_000_030
  );
  assert.equal(first?.kind, "SNAPSHOT");
  assert.equal(laterFullSnapshot?.kind, "SNAPSHOT");
  const fabric = new PaperMarketDataFabric([
    { sourceId: "nobitex", sequencePolicy: "MONOTONIC_VERSION" }
  ]);
  assert.equal(fabric.ingest(first!).accepted, true);
  // A skipped offset is valid because every publication is a complete book.
  assert.equal(fabric.ingest(laterFullSnapshot!).accepted, true);
  assert.equal(
    fabric.ingest(
      parseNobitexPublication(nobitexMessage(101, 2_000_015), 2_000_040)!
    ).reason,
    "out_of_order"
  );
  assert.equal(
    parseNobitexPublication(nobitexMessage(103, Number.NaN), 2_000_050),
    null
  );

  const tabdealMessage = (eventMs?: number) => ({
    data: {
      e: "depthUpdate",
      s: "USDTIRT",
      ...(eventMs === undefined ? {} : { E: eventMs }),
      b: [["101000", "100"]],
      a: [["101100", "100"]]
    }
  });
  const tabdeal = new PaperMarketDataFabric([
    { sourceId: "tabdeal", sequencePolicy: "FULL_SNAPSHOT_NO_SEQUENCE" }
  ]);
  assert.equal(parseTabdealDepth(tabdealMessage(), 3_000_000), null);
  assert.equal(
    tabdeal.ingest(parseTabdealDepth(tabdealMessage(3_000_000), 3_000_010)!)
      .accepted,
    true
  );
  assert.equal(
    tabdeal.ingest(parseTabdealDepth(tabdealMessage(2_999_999), 3_000_020)!)
      .reason,
    "out_of_order"
  );
  const runtimeNobitex = ingestPublicStreamMessage({
    sourceId: "nobitex",
    message: nobitexMessage(900_000, 9_000_000),
    receivedAtMs: 9_000_010
  });
  assert.equal(runtimeNobitex?.accepted, true);
  assert.equal(
    ingestPublicStreamMessage({
      sourceId: "nobitex",
      message: nobitexMessage(899_999, 9_000_001),
      receivedAtMs: 9_000_020
    })?.reason,
    "out_of_order"
  );
  const runtimeTabdeal = ingestPublicStreamMessage({
    sourceId: "tabdeal",
    message: tabdealMessage(9_000_000),
    receivedAtMs: 9_000_010
  });
  assert.equal(runtimeTabdeal?.accepted, true);
  assert.equal(
    ingestPublicStreamMessage({
      sourceId: "tabdeal",
      message: tabdealMessage(8_999_999),
      receivedAtMs: 9_000_020
    })?.reason,
    "out_of_order"
  );
});

await test("3) Wallex and runtime never pair a side across reconnect", () => {
  const recoveryReasons: string[] = [];
  const assembler = new WallexDepthAssembler(2_500, (reason) =>
    recoveryReasons.push(reason)
  );
  const buy = (price: number) => [
    "USDTTMN@buyDepth",
    [{ price, quantity: 10 }]
  ];
  const sell = (price: number) => [
    "USDTTMN@sellDepth",
    [{ price, quantity: 10 }]
  ];
  assert.equal(assembler.ingest(buy(100_000), 4_000_000), null);
  assembler.reset();
  assert.equal(assembler.ingest(sell(100_100), 4_001_000), null);
  const coherent = assembler.ingest(buy(100_010), 4_001_001);
  assert.equal(coherent?.bids[0].priceToman, 100_010);
  assert.equal(coherent?.asks[0].priceToman, 100_100);
  assert.equal(assembler.ingest(buy(100_020), 4_010_000), null);
  assert.equal(assembler.ingest(sell(100_120), 4_013_000), null);
  assert.deepEqual(recoveryReasons, ["wallex_side_pair_skew"]);

  const runtimeSnapshots: number[] = [];
  const runtimeRecoveries: string[] = [];
  const unsubscribeDecision = subscribePaperMarketDecisions((snapshot) => {
    if (snapshot.sourceId === "wallex") {
      runtimeSnapshots.push(snapshot.bookBids?.[0]?.priceToman ?? 0);
    }
  });
  const unsubscribeRecovery = subscribePaperRestRecoveryRequests(
    (sourceId, reason) => {
      if (sourceId === "wallex") runtimeRecoveries.push(reason);
    }
  );
  ingestPublicStreamMessage({
    sourceId: "wallex",
    message: buy(99_000),
    receivedAtMs: 5_000_000
  });
  markPublicStreamReconnect("wallex");
  assert.equal(
    ingestPublicStreamMessage({
      sourceId: "wallex",
      message: sell(100_200),
      receivedAtMs: 5_001_000
    }),
    null
  );
  assert.equal(
    paperStreamTelemetry("wallex", 5_001_000)?.snapshotResyncState,
    "AWAITING_SNAPSHOT"
  );
  const runtimeFresh = ingestPublicStreamMessage({
    sourceId: "wallex",
    message: buy(100_100),
    receivedAtMs: 5_001_001
  });
  ingestPublicStreamMessage({
    sourceId: "wallex",
    message: buy(100_110),
    receivedAtMs: 5_010_000
  });
  assert.equal(
    ingestPublicStreamMessage({
      sourceId: "wallex",
      message: sell(100_210),
      receivedAtMs: 5_013_000
    }),
    null
  );
  unsubscribeDecision();
  unsubscribeRecovery();
  assert.equal(runtimeFresh?.decisionReady, true);
  assert.deepEqual(runtimeSnapshots, [100_100]);
  assert.ok(runtimeRecoveries.includes("socket_session_boundary"));
  assert.ok(runtimeRecoveries.includes("wallex_side_pair_skew"));
  const runnerSource = readFileSync(
    new URL("../src/lib/shadowArbitrage/runner.ts", import.meta.url),
    "utf8"
  );
  assert.match(runnerSource, /force:\s*eventDriven \|\| recoveryDriven/);
});

await test("4) REST recovery preserves version watermark and invalid time fails closed", () => {
  const fabric = new PaperMarketDataFabric([
    { sourceId: "nobitex", sequencePolicy: "MONOTONIC_VERSION" }
  ]);
  assert.equal(fabric.ingest(replay.events[0]).accepted, true);
  fabric.onReconnect("nobitex");
  const rest = fabric.ingest({
    ...replay.events[0],
    sequence: null,
    sourceEventTimestampMs: 1_000_100,
    receiveTimestampMs: 1_000_110,
    transport: "REST_RECOVERY"
  });
  assert.equal(rest.decisionReady, true);
  assert.match(
    fabric.telemetry("nobitex", 1_000_120).resyncProvenance ?? "",
    /VERSION_WATERMARK_PRESERVED/
  );
  assert.equal(
    fabric.ingest({
      ...replay.events[0],
      sequence: 99,
      sourceEventTimestampMs: 1_000_130,
      receiveTimestampMs: 1_000_140
    }).reason,
    "out_of_order"
  );
  const invalid = fabric.ingest({
    ...replay.events[0],
    sequence: 101,
    sourceEventTimestampMs: Number.NaN,
    receiveTimestampMs: 1_000_150
  });
  assert.equal(invalid.reason, "invalid_timestamp");
  assert.equal(invalid.decisionReady, false);
  assert.equal(fabric.snapshot("nobitex"), null);
  const incoherent = assessCrossVenueCoherence({
    buy: {
      ...rest.snapshot!,
      receivedAt: "garbage",
      marketData: {
        ...rest.snapshot!.marketData!,
        receiveTimestamp: "garbage"
      }
    },
    sell: rest.snapshot ?? undefined,
    decisionTimestampMs: 1_000_160,
    maxAgeMs: 2_000,
    maxSourceSkewMs: 100
  });
  assert.equal(incoherent.coherent, false);
  assert.equal(incoherent.reason, "invalid_timestamp");
  const invalidRest = registerRestStreamRecovery(
    { ...rest.snapshot!, receivedAt: "not-a-time" },
    "REST_RECOVERY"
  );
  assert.equal(invalidRest.stale, true);
  assert.equal(
    invalidRest.marketData?.snapshotResyncState,
    "AWAITING_SNAPSHOT"
  );
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

await test("5) equal raw RA scores persistence higher without changing raw economics", () => {
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

await test("6) tracker records full persistence history and conservative low history", () => {
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
  assert.equal(estimate.firstSeenAtMs, 0);
  assert.equal(estimate.lastSeenAtMs, 7_000);
  assert.equal(estimate.continuousAgeMs, 0);
  assert.equal(estimate.observations, 4);
  assert.equal(estimate.recurrenceCount, 1);
  assert.equal(estimate.disappearanceCount, 2);
  assert.equal(estimate.empiricalSurvivalAtHorizon, 1);
  assert.equal(estimate.empiricalHalfLifeMs, 3_000);
  const lowHistory = new OpportunitySurvivalTracker();
  lowHistory.observeCycle([{ routeKey: "new", active: true }], 8_000);
  const conservative = lowHistory.estimate("new", 8_000);
  assert.equal(conservative.insufficientHistory, true);
  assert.equal(conservative.confidence, 0.25);
  assert.ok(
    conservative.captureFactor <=
      DEFAULT_SURVIVAL_POLICY.conservativePriorCaptureFactor
  );
});

await test("7) evaluateCycle ranks equal canonical RA by measured survival only", () => {
  const fabric = new PaperMarketDataFabric([
    { sourceId: "nobitex", sequencePolicy: "MONOTONIC_VERSION" },
    { sourceId: "tabdeal", sequencePolicy: "FULL_SNAPSHOT_NO_SEQUENCE" },
    { sourceId: "wallex", sequencePolicy: "MONOTONIC_VERSION" }
  ]);
  const buy = fabric.ingest(replay.events[0]).snapshot!;
  const tabdeal = fabric.ingest(replay.events[1]).snapshot!;
  const wallex = fabric.ingest({
    ...replay.events[1],
    sourceId: "wallex",
    sequence: 1,
    bids: [...replay.events[1].bids],
    asks: [...replay.events[1].asks]
  }).snapshot!;
  const tracker = new OpportunitySurvivalTracker();
  for (const observedAtMs of [996_000, 997_000, 998_000, 1_000_000]) {
    tracker.observe({
      routeKey: "nobitex->wallex",
      observedAtMs,
      active: true
    });
  }
  for (const point of [
    { observedAtMs: 996_000, active: true },
    { observedAtMs: 996_100, active: false },
    { observedAtMs: 997_000, active: true },
    { observedAtMs: 997_100, active: false },
    { observedAtMs: 1_000_000, active: true }
  ]) {
    tracker.observe({ routeKey: "nobitex->tabdeal", ...point });
  }
  const opportunities = [
    paperOpportunity("persistent", "nobitex", "wallex"),
    paperOpportunity("fleeting", "nobitex", "tabdeal")
  ];
  const sources = [buy, wallex, tabdeal];
  const result = evaluateCycle({
    opportunities,
    sources,
    venueStates: sources.map((source) => ({
      sourceId: source.sourceId,
      executable: true,
      capitalClass: "EXECUTABLE",
      takerFeeBps: 25,
      feeProvenance: "ADMIN_CONFIRMED",
      feeStale: false
    })) as never,
    executedLifecycleIds: new Set(),
    balances: [
      { sourceId: "nobitex", irtToman: 505_000, usdtMicros: 0 },
      { sourceId: "wallex", irtToman: 0, usdtMicros: 10_000_000 },
      { sourceId: "tabdeal", irtToman: 0, usdtMicros: 10_000_000 }
    ],
    sizing: {
      policies: paperPolicies(),
      allocationTomanBySource: new Map([
        ["nobitex", 100_000_000],
        ["wallex", 100_000_000],
        ["tabdeal", 100_000_000]
      ]),
      portfolioValueToman: null,
      exposureTomanBySource: new Map([
        ["nobitex", 0],
        ["wallex", 0],
        ["tabdeal", 0]
      ]),
      slippageBufferBps: 5,
      inventoryModel: {
        valuationPriceToman: 100_000,
        targets: [
          { sourceId: "nobitex", targetUsdtSharePercent: 50 },
          { sourceId: "wallex", targetUsdtSharePercent: 50 },
          { sourceId: "tabdeal", targetUsdtSharePercent: 50 }
        ],
        maxDeviationPoints: 100
      }
    },
    portfolioLimits: {
      enabled: false,
      equityToman: 2_505_000,
      markPriceToman: 100_000
    },
    decisionTimestampMs: 1_000_030,
    decisionClock: () => 1_000_040,
    survivalTracker: tracker,
    maxCrossVenueSkewMs: 100
  } as never);
  const execute = result.decisions.find((decision) => decision.kind === "EXECUTE");
  const skip = result.decisions.find(
    (decision) =>
      decision.kind === "SKIP" && decision.candidate.lifecycleId === "fleeting"
  );
  assert.equal(execute?.candidate.lifecycleId, "persistent");
  assert.equal(skip?.candidate.lifecycleId, "fleeting");
  assert.ok(execute?.candidate.scoring && skip?.candidate.scoring);
  assert.equal(
    execute?.candidate.scoring?.canonicalRiskAdjustedPnlToman,
    skip?.candidate.scoring?.canonicalRiskAdjustedPnlToman
  );
  assert.ok(
    (execute?.candidate.scoring?.captureFactor ?? 0) >
      (skip?.candidate.scoring?.captureFactor ?? 1)
  );
  assert.ok(
    (execute?.candidate.scoring?.adjustedObjectiveToman ?? 0) >
      (skip?.candidate.scoring?.adjustedObjectiveToman ?? 0)
  );
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

await test("8) scarce inventory cost changes allocation and preserves strategic IRT", () => {
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
    capital: 600,
    raw: 80,
    adjusted: 80,
    buy: "other",
    sell: "shared-sell"
  });
  const consume = allocatorCandidate({
    id: "consume",
    routeKey: "a-consume",
    capital: 600,
    raw: 110,
    adjusted: consuming.adjustedObjectiveToman,
    buy: "shared",
    sell: "other-sell"
  });
  const constraints = {
    maxUtilizationPercent: 100,
    minReservePercent: 0,
    maxVenueExposurePercent: 100
  };
  const rawOnly = allocatePaperRoutes(
    allocatorInput(
      [
        { ...consume, adjustedScoreToman: undefined },
        { ...preserving, adjustedScoreToman: undefined }
      ],
      1_000,
      constraints
    )
  );
  const result = allocatePaperRoutes(
    allocatorInput([consume, preserving], 1_000, constraints)
  );
  assert.equal(consuming.canonicalRiskAdjustedPnlToman, 110);
  assert.equal(consuming.inventoryOpportunityCostToman, 100);
  assert.equal(rawOnly.selected[0].candidate.lifecycleId, "consume");
  assert.equal(result.selected[0].candidate.lifecycleId, "preserve");
  assert.equal(result.selected.some((row) => row.candidate.lifecycleId === "consume"), false);
  assert.ok(
    result.rejected.some(
      (row) =>
        row.lifecycleId === "consume" &&
        (row.code === "portfolio_not_selected" ||
          row.code === "portfolio_utilization_cap")
    )
  );
  assert.equal(
    result.selected.some((row) => row.candidate.buySourceId === "shared"),
    false
  );
});

await test("9) inventory-repairing route gets no fake bonus and no depletion charge", () => {
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

await test("10) execution priors are single-source and do not change canonical economics", () => {
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
  const defaulted = scorePaperCandidate({
    canonicalRiskAdjustedPnlToman: 1_000,
    survival: lifecycleEstimate(4_000),
    sourceAgeMs: 0,
    venueLatencyMs: 0,
    venueJitterMs: 0,
    buyIrtRequiredToman: 0,
    sellUsdtMicros: 0,
    buySourceId: "a",
    sellSourceId: "b",
    inventoryImpactPoints: 0
  });
  assert.equal(defaulted.fillConfidence, 0.75);
  assert.equal(defaulted.partialFillRisk, 0);
  assert.match(defaulted.provenance.fill, /single provenance-based/);
});

const capitalScenarios: Array<{
  equityToman: number;
  utilizationPercent: number;
  selected: string[];
  nodesVisited: number;
  solveTimeMs: number;
}> = [];
await test("11) 100M/1B/10B stay deterministic at or below the 90% ceiling", () => {
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
      }),
      allocatorCandidate({
        id: `c-${equity}`,
        capital: equity * 0.01,
        raw: 1,
        buy: `c-buy-${equity}`,
        sell: `c-sell-${equity}`
      })
    ];
    const first = allocatePaperRoutes(allocatorInput(rows, equity));
    const second = allocatePaperRoutes(allocatorInput(rows, equity));
    assert.ok(first.telemetry.utilizationPercent <= 90);
    assert.deepEqual(
      first.selected.map((row) => row.candidate.lifecycleId),
      second.selected.map((row) => row.candidate.lifecycleId)
    );
    assert.equal(
      first.selected.some((row) => row.candidate.lifecycleId === `c-${equity}`),
      false
    );
    assert.ok(
      first.rejected.some(
        (row) =>
          row.lifecycleId === `c-${equity}` &&
          row.code === "portfolio_utilization_cap"
      )
    );
    const lowCapacity = allocatePaperRoutes(
      allocatorInput(
        [
          allocatorCandidate({
            id: `low-${equity}`,
            capital: equity * 0.2,
            raw: 10,
            buy: `low-buy-${equity}`,
            sell: `low-sell-${equity}`
          })
        ],
        equity
      )
    );
    assert.equal(lowCapacity.telemetry.utilizationPercent, 20);
    capitalScenarios.push({
      equityToman: equity,
      utilizationPercent: first.telemetry.utilizationPercent,
      selected: first.selected.map((row) => row.candidate.lifecycleId),
      nodesVisited: first.search.nodesVisited,
      solveTimeMs: first.search.solveTimeMs
    });
  }
});

await test("12) adjusted exact objective is more defensible than Task-006 raw-only tie", () => {
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

await test("13) exact guard, public-only stream path, and LIVE=false remain structural", () => {
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
  const publicStreamSource = [
    "../src/lib/shadowArbitrage/streaming/venueAdapters.ts",
    "../src/lib/shadowArbitrage/streaming/runtime.ts",
    "../src/lib/shadowArbitrage/streaming/publicWsDriver.ts"
  ]
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8"))
    .join("\n");
  assert.doesNotMatch(
    publicStreamSource,
    /\b(fetch|axios|authorization|api[_-]?key|secret|privateChannel|createOrder|placeOrder|withdraw)\b/i
  );
});

console.log(`\nLatency benchmark ${JSON.stringify(benchmark)}`);
console.log(`Capital scenarios ${JSON.stringify(capitalScenarios)}`);
console.log(`Allocator guard benchmark ${JSON.stringify(guardBenchmark)}`);
console.log(`Result: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
