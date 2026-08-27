#!/usr/bin/env npx tsx
/** SHADOW-TASK-006 deterministic Paper portfolio allocator acceptance tests. */
import assert from "node:assert/strict";
import {
  allocatePaperRoutes,
  allocatePaperRoutesGreedy,
  type AllocatorCandidate,
  type PaperAllocatorInput
} from "../src/lib/shadowArbitrage/paper/portfolioAllocator.ts";

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

const MARK = 100_000;
function candidate(input: {
  id: string;
  buy: string;
  sell: string;
  capital: number;
  ra: number;
  economic?: number;
  buyIrt?: number;
  sellUsdtMicros?: number;
  sizeUsdt?: number;
  inventoryImpactPoints?: number;
}): AllocatorCandidate {
  const buyIrt = input.buyIrt ?? Math.floor(input.capital / 2);
  const sellToman = input.capital - buyIrt;
  const sellUsdtMicros =
    input.sellUsdtMicros ?? Math.floor((sellToman / MARK) * 1_000_000);
  const sizeUsdt =
    input.sizeUsdt ?? Math.min(buyIrt / MARK, sellUsdtMicros / 1_000_000);
  return {
    lifecycleId: input.id,
    routeKey: `${input.buy}->${input.sell}`,
    buySourceId: input.buy,
    sellSourceId: input.sell,
    sizeUsdt,
    buyVwapToman: MARK,
    sellVwapToman: MARK + 1_000,
    riskAdjustedPnlToman: input.ra,
    economicNetPnlToman: input.economic ?? input.ra + 1,
    buyNotionalToman: buyIrt,
    buyIrtRequiredToman: buyIrt,
    sellUsdtMicros,
    capitalLockedToman: input.capital,
    buyAcceptedDepthToman: buyIrt,
    sellAcceptedDepthToman: sellToman,
    inventoryImpactPoints: input.inventoryImpactPoints ?? 0,
    readiness: { healthy: true, fresh: true, feeCertain: true }
  };
}

function allocatorInput(
  candidates: AllocatorCandidate[],
  equityToman: number,
  overrides: Partial<PaperAllocatorInput> = {}
): PaperAllocatorInput {
  const venues = new Set(
    candidates.flatMap((row) => [row.buySourceId, row.sellSourceId])
  );
  return {
    candidates,
    equityToman,
    markPriceToman: MARK,
    venueExposureToman: new Map([...venues].map((id) => [id, 0])),
    availableIrtByVenue: new Map(
      [...venues].map((id) => [id, equityToman])
    ),
    availableUsdtMicrosByVenue: new Map(
      [...venues].map((id) => [
        id,
        Math.floor((equityToman / MARK) * 1_000_000)
      ])
    ),
    ...overrides
  };
}

await test("A) 1B with only 100M profitable capacity allocates only 100M", () => {
  const result = allocatePaperRoutes(
    allocatorInput(
      [candidate({ id: "a", buy: "a", sell: "b", capital: 100_000_000, ra: 1_000_000 })],
      1_000_000_000
    )
  );
  assert.equal(result.telemetry.maxDeployableCapitalToman, 900_000_000);
  assert.equal(result.telemetry.allocatedProfitableCapacityToman, 100_000_000);
  assert.equal(result.telemetry.idleCapitalToman, 800_000_000);
  assert.equal(result.selected.length, 1);
});

await test("B) independent q-star routes choose best aggregate combination below 900M", () => {
  const rows = [
    candidate({ id: "a", buy: "a1", sell: "a2", capital: 400_000_000, ra: 70 }),
    candidate({ id: "b", buy: "b1", sell: "b2", capital: 300_000_000, ra: 60 }),
    candidate({ id: "c", buy: "c1", sell: "c2", capital: 250_000_000, ra: 40 })
  ];
  const result = allocatePaperRoutes(allocatorInput(rows, 1_000_000_000));
  assert.deepEqual(
    result.selected.map((row) => row.candidate.lifecycleId).sort(),
    ["a", "b"]
  );
  assert.equal(result.telemetry.engagedCapitalToman, 700_000_000);
  assert.ok(result.telemetry.engagedCapitalToman <= 900_000_000);
});

await test("C) shared venue balance cannot double-spend and better portfolio wins", () => {
  const rows = [
    candidate({ id: "large", buy: "shared", sell: "s1", capital: 400_000_000, buyIrt: 200_000_000, ra: 100 }),
    candidate({ id: "pair-1", buy: "shared", sell: "s2", capital: 200_000_000, buyIrt: 100_000_000, ra: 60 }),
    candidate({ id: "pair-2", buy: "shared", sell: "s3", capital: 200_000_000, buyIrt: 100_000_000, ra: 60 })
  ];
  const result = allocatePaperRoutes(
    allocatorInput(rows, 1_000_000_000, {
      availableIrtByVenue: new Map([
        ["shared", 200_000_000],
        ["s1", 1_000_000_000],
        ["s2", 1_000_000_000],
        ["s3", 1_000_000_000]
      ])
    })
  );
  assert.deepEqual(
    result.selected.map((row) => row.candidate.lifecycleId).sort(),
    ["pair-1", "pair-2"]
  );
  assert.equal(result.telemetry.selectedPortfolioRiskAdjustedPnlToman, 120);
});

await test("D) deep route may exceed legacy 20% venue exposure", () => {
  const result = allocatePaperRoutes(
    allocatorInput(
      [candidate({ id: "deep", buy: "a", sell: "b", capital: 600_000_000, buyIrt: 300_000_000, ra: 1_000 })],
      1_000_000_000
    )
  );
  assert.equal(result.selected.length, 1);
  assert.ok(result.dynamicVenueCaps.every((cap) => cap.failSafeCeilingToman === 650_000_000));
  assert.equal(result.selected[0].candidate.buyIrtRequiredToman, 300_000_000);
});

await test("E) 10B with 1.2B profitable capacity is capacity-limited", () => {
  const result = allocatePaperRoutes(
    allocatorInput(
      [candidate({ id: "capacity", buy: "a", sell: "b", capital: 1_200_000_000, ra: 2_000_000 })],
      10_000_000_000
    )
  );
  assert.equal(result.telemetry.profitableExecutableCapacityToman, 1_200_000_000);
  assert.equal(result.telemetry.allocatedProfitableCapacityToman, 1_200_000_000);
  assert.equal(result.telemetry.idleCapitalToman, 7_800_000_000);
});

await test("F) negative deeper breakpoint never replaces economic q-star", () => {
  const optimum = candidate({
    id: "q-star",
    buy: "a",
    sell: "b",
    capital: 200_000_000,
    sizeUsdt: 1_000,
    ra: 500_000
  });
  const deeper = candidate({
    id: "deeper",
    buy: "a",
    sell: "b",
    capital: 400_000_000,
    sizeUsdt: 2_000,
    ra: -1,
    economic: -1
  });
  const result = allocatePaperRoutes(
    allocatorInput([deeper, optimum], 1_000_000_000)
  );
  assert.deepEqual(
    result.selected.map((row) => row.candidate.lifecycleId),
    ["q-star"]
  );
  assert.ok(result.rejected.some((row) => row.lifecycleId === "deeper" && row.code === "net_non_positive"));
});

await test("G) profitable inventory-repairing route remains eligible", () => {
  const repairing = candidate({
    id: "repair",
    buy: "light-usdt",
    sell: "heavy-usdt",
    capital: 100_000_000,
    ra: 100_000,
    inventoryImpactPoints: -8
  });
  const result = allocatePaperRoutes(
    allocatorInput([repairing], 1_000_000_000, {
      inventoryFeasible: (rows) =>
        rows.every((row) => (row.inventoryImpactPoints ?? 0) <= 0)
    })
  );
  assert.equal(result.selected[0].candidate.lifecycleId, "repair");
});

await test("G2) complementary repair can legalize a worsening DFS prefix", () => {
  const worsening = candidate({
    id: "worsen-first",
    buy: "a",
    sell: "b",
    capital: 100_000_000,
    ra: 100,
    inventoryImpactPoints: 10
  });
  const repairing = candidate({
    id: "repair-second",
    buy: "c",
    sell: "d",
    capital: 100_000_000,
    ra: 60,
    inventoryImpactPoints: -10
  });
  const result = allocatePaperRoutes(
    allocatorInput([worsening, repairing], 1_000_000_000, {
      inventoryFeasible: (rows) =>
        rows.reduce(
          (sum, row) => sum + (row.inventoryImpactPoints ?? 0),
          0
        ) <= 0
    })
  );
  assert.deepEqual(
    result.selected.map((row) => row.candidate.lifecycleId).sort(),
    ["repair-second", "worsen-first"]
  );
  assert.equal(result.telemetry.selectedPortfolioRiskAdjustedPnlToman, 160);
});

await test("H) existing reservations preserve 90% ceiling and prevent double allocation", () => {
  const rows = [
    candidate({ id: "h1", buy: "shared", sell: "s1", capital: 400_000_000, buyIrt: 200_000_000, ra: 100 }),
    candidate({ id: "h2", buy: "shared", sell: "s2", capital: 400_000_000, buyIrt: 200_000_000, ra: 90 })
  ];
  const result = allocatePaperRoutes(
    allocatorInput(rows, 1_000_000_000, {
      reservedBuyIrtToman: 100_000_000,
      reservedSellUsdtMicros: 1_000_000_000,
      reservedIrtByVenue: new Map([["shared", 100_000_000]]),
      reservedUsdtMicrosByVenue: new Map([["s1", 1_000_000_000]]),
      availableIrtByVenue: new Map([
        ["shared", 300_000_000],
        ["s1", 1_000_000_000],
        ["s2", 1_000_000_000]
      ])
    })
  );
  assert.equal(result.selected.length, 1);
  assert.ok(result.telemetry.utilizationPercent <= 90);
  const selectedIrt = result.selected.reduce(
    (sum, row) => sum + (row.candidate.buyIrtRequiredToman ?? 0),
    100_000_000
  );
  assert.ok(selectedIrt <= 300_000_000);
});

await test("I) identical snapshot produces byte-stable selection and telemetry", () => {
  const input = allocatorInput(
    [
      candidate({ id: "i2", buy: "a", sell: "b", capital: 200_000_000, ra: 20 }),
      candidate({ id: "i1", buy: "c", sell: "d", capital: 200_000_000, ra: 20 })
    ],
    1_000_000_000
  );
  const first = allocatePaperRoutes(input);
  const second = allocatePaperRoutes(input);
  assert.equal(
    JSON.stringify({
      selected: first.selected,
      rejected: first.rejected,
      telemetry: first.telemetry,
      caps: first.dynamicVenueCaps,
      search: first.search
    }),
    JSON.stringify({
      selected: second.selected,
      rejected: second.rejected,
      telemetry: second.telemetry,
      caps: second.dynamicVenueCaps,
      search: second.search
    })
  );
});

await test("J) exact allocator aggregate RA is at least historical greedy", () => {
  const rows = [
    candidate({ id: "greedy-first", buy: "shared", sell: "s1", capital: 600_000_000, buyIrt: 300_000_000, ra: 100 }),
    candidate({ id: "combo-1", buy: "shared", sell: "s2", capital: 300_000_000, buyIrt: 150_000_000, ra: 60 }),
    candidate({ id: "combo-2", buy: "shared", sell: "s3", capital: 300_000_000, buyIrt: 150_000_000, ra: 60 })
  ];
  const input = allocatorInput(rows, 1_000_000_000, {
    availableIrtByVenue: new Map([
      ["shared", 300_000_000],
      ["s1", 1_000_000_000],
      ["s2", 1_000_000_000],
      ["s3", 1_000_000_000]
    ]),
    maxUtilizationPercent: 90,
    minReservePercent: 10,
    maxVenueExposurePercent: 65
  });
  const exact = allocatePaperRoutes(input);
  const greedy = allocatePaperRoutesGreedy(input);
  const greedyRa = greedy.selected.reduce(
    (sum, row) => sum + row.candidate.riskAdjustedPnlToman,
    0
  );
  assert.ok(exact.telemetry.selectedPortfolioRiskAdjustedPnlToman >= greedyRa);
  assert.equal(exact.telemetry.selectedPortfolioRiskAdjustedPnlToman, 120);
  assert.equal(greedyRa, 100);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
