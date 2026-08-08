#!/usr/bin/env npx tsx
/**
 * Step 2 — capital-aware max-safe sizing proofs (100M vs 10B fixtures).
 * Pure: no production, no network.
 */
import assert from "node:assert/strict";
import {
  BASELINE_FIXED_SIZES_USDT,
  BASELINE_POLICY,
  CAPITAL_CAP_PERCENT,
  DEPTH_CAP_PERCENT,
  MIN_EXECUTABLE_USDT_MICROS,
  SMART_SIZING_POLICY,
  computeRouteSize
} from "../src/lib/shadowArbitrage/paper/sizing.ts";
import { buildSmartCandidates } from "../src/lib/shadowArbitrage/paper/smartCandidates.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
import { settlementFor, usdtToMicros, microsToUsdt } from "../src/lib/shadowArbitrage/paper/broker.ts";
import { targetsFromAllocations } from "../src/lib/shadowArbitrage/paper/inventory.ts";
import { defaultAllocation } from "../src/lib/shadowArbitrage/paper/portfolio.ts";
import { SHADOW_SOURCES } from "../src/lib/shadowArbitrage/config.ts";

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

const NOW = Date.parse("2026-08-08T12:00:00.000Z");
const MARK = 200_000;

function policies(over: Partial<Record<string, number | undefined>> = {}) {
  const base: Record<string, number> = {
    max_order_size_usdt: 1_000_000,
    max_venue_exposure_percent: 100,
    min_risk_adjusted_edge_percent: 0,
    max_quote_age_ms: 120_000,
    max_slippage_bps: 500,
    max_inventory_deviation_percent: 100
  };
  const merged: Record<string, number | undefined> = { ...base, ...over };
  return buildPolicyState(
    Object.entries(merged)
      .filter(([, v]) => v !== undefined)
      .map(([key, value]) => ({
        key: key as never,
        value: value as number,
        provenance: "ADMIN_APPROVED" as const,
        setBy: "test",
        setAt: "2026-08-08T00:00:00.000Z",
        validForDays: null,
        note: null
      })),
    NOW
  );
}

function lv(price: number, amt: number) {
  return { priceToman: price, amountUsdt: amt };
}
function ladder(start: number, step: number, n: number, amt: number) {
  return Array.from({ length: n }, (_, i) => lv(start + i * step, amt));
}

function snap(id: string, bids: ReturnType<typeof lv>[], asks: ReturnType<typeof lv>[]) {
  return {
    sourceId: id,
    marketModel: "ORDER_BOOK" as const,
    health: "healthy" as const,
    stale: false,
    ageMs: 1_000,
    bookBids: bids,
    bookAsks: asks,
    userBuyPriceToman: bids[0]?.priceToman ?? null,
    userSellPriceToman: asks[0]?.priceToman ?? null,
    maxExecutableUsdt: null,
    errorReason: null,
    degradedReason: null
  };
}

function sessionBalances(capitalToman: number) {
  const venues = SHADOW_SOURCES.map((s) => s.id);
  const alloc = defaultAllocation(capitalToman, venues, MARK);
  return alloc.map((a) => ({
    sourceId: a.sourceId as never,
    irtToman: a.irtToman,
    usdtMicros: usdtToMicros(a.usdtUnits)
  }));
}

function sizeAtCapital(capitalToman: number, depthUsdtPerLevel = 500, levels = 20) {
  const bals = sessionBalances(capitalToman);
  const buy = bals.find((b) => b.sourceId === "nobitex")!;
  const sell = bals.find((b) => b.sourceId === "wallex")!;
  const allocMap = new Map(
    bals.map((b) => [
      b.sourceId as string,
      b.irtToman + Math.round(microsToUsdt(b.usdtMicros) * MARK)
    ])
  );
  const equity = capitalToman;
  return computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap(
      "nobitex",
      [lv(190_000, 50_000)],
      ladder(192_000, 20, levels, depthUsdtPerLevel)
    ) as never,
    sellSnapshot: snap(
      "wallex",
      ladder(194_000, -20, levels, depthUsdtPerLevel),
      [lv(196_000, 50_000)]
    ) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: [buy, sell],
    buyVenueAllocationToman: allocMap.get("nobitex") ?? null,
    portfolioValueToman: equity,
    buyVenueExposureToman: allocMap.get("nobitex") ?? 0,
    policies: policies(),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: MARK,
      targets: targetsFromAllocations(
        bals.map((b) => ({
          sourceId: b.sourceId as string,
          irtToman: b.irtToman,
          usdtUnits: microsToUsdt(b.usdtMicros)
        })),
        MARK
      ),
      maxDeviationPoints: 50
    }
  });
}

await test("policy constants: full capital/depth, no 5/10/20/25 execution cap", () => {
  assert.equal(SMART_SIZING_POLICY, "CAPITAL_AWARE_MAX_SAFE");
  assert.equal(CAPITAL_CAP_PERCENT, 100);
  assert.equal(DEPTH_CAP_PERCENT, 100);
  assert.equal(MIN_EXECUTABLE_USDT_MICROS, 25_000_000);
  assert.deepEqual([...BASELINE_FIXED_SIZES_USDT], [5, 10, 20, 25]);
  assert.ok(BASELINE_POLICY.includes("ANALYSIS"));
});

await test("larger capital → larger safe max when depth allows", () => {
  const r100 = sizeAtCapital(100_000_000, 5_000, 30);
  const r10b = sizeAtCapital(10_000_000_000, 5_000, 30);
  assert.equal(r100.status, "SIZED", JSON.stringify(r100.blockers));
  assert.equal(r10b.status, "SIZED", JSON.stringify(r10b.blockers));
  assert.ok(r100.sizeUsdtMicros! > usdtToMicros(25), "100M above fixed ladder");
  assert.ok(r10b.sizeUsdtMicros! > r100.sizeUsdtMicros!, "10B larger than 100M");
  assert.ok(r10b.sizeUsdtMicros! > usdtToMicros(100), "10B well above 25");
  console.log(
    `        100M size=${microsToUsdt(r100.sizeUsdtMicros!)} binding=${r100.bindingConstraint}`
  );
  console.log(
    `        10B size=${microsToUsdt(r10b.sizeUsdtMicros!)} binding=${r10b.bindingConstraint}`
  );
});

await test("shallow book stays small; deep book consumes multi-level VWAP", () => {
  const shallow = sizeAtCapital(10_000_000_000, 2, 5); // only 10 USDT total depth-ish
  const deep = sizeAtCapital(10_000_000_000, 2_000, 40);
  if (shallow.status === "SIZED") {
    assert.ok(shallow.sizeUsdtMicros! <= usdtToMicros(50), "shallow stays small");
  }
  assert.equal(deep.status, "SIZED");
  assert.ok((deep.quote?.buyWalk.fills.length ?? 0) >= 2, "multi-level buy walk");
  assert.ok((deep.quote?.sellWalk.fills.length ?? 0) >= 2, "multi-level sell walk");
  assert.ok(deep.sizeUsdtMicros! > usdtToMicros(25));
});

await test("fixed ladder never caps the candidate ceiling", () => {
  const set = buildSmartCandidates({
    buyUsableMicros: usdtToMicros(5_000),
    sellUsableMicros: usdtToMicros(5_000),
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(5_000),
    sellDepthMicros: usdtToMicros(5_000),
    extraCapsMicros: [],
    granularityMicros: 100
  });
  assert.ok(set.ceilingMicros > usdtToMicros(25));
  assert.ok(Math.max(...set.quantities) > usdtToMicros(25));
  assert.ok(!BASELINE_FIXED_SIZES_USDT.includes(microsToUsdt(set.ceilingMicros) as never));
});

await test("size never exceeds balance, depth, or order cap", () => {
  const r = sizeAtCapital(10_000_000_000, 1_000, 15);
  assert.equal(r.status, "SIZED");
  const s = r.sizeUsdtMicros!;
  assert.ok(s <= r.capacity!.buyUsableMicros);
  assert.ok(s <= r.capacity!.sellUsableMicros);
  assert.ok(s <= r.capacity!.depthCapMicros);
  assert.ok(s <= r.capacity!.ceilingMicros);
  for (const c of r.constraints) {
    if (c.capUsdtMicros != null) assert.ok(s <= c.capUsdtMicros + 100, c.key);
  }
});

await test("stale book fails closed", () => {
  const bals = sessionBalances(100_000_000);
  const r = computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: {
      ...snap("nobitex", [lv(190_000, 1000)], ladder(192_000, 10, 10, 100)),
      stale: true,
      ageMs: 999_999
    } as never,
    sellSnapshot: snap(
      "wallex",
      ladder(194_000, -10, 10, 100),
      [lv(196_000, 1000)]
    ) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: bals.filter((b) => b.sourceId === "nobitex" || b.sourceId === "wallex"),
    buyVenueAllocationToman: 10_000_000,
    portfolioValueToman: 100_000_000,
    buyVenueExposureToman: 5_000_000,
    policies: policies({ max_quote_age_ms: 5_000 }),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: MARK,
      targets: [],
      maxDeviationPoints: null
    }
  });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.some((b) => b.code === "stale_quote"));
});

await test("missing fee fails closed", () => {
  const bals = sessionBalances(100_000_000);
  const r = computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap("nobitex", [lv(190_000, 1000)], ladder(192_000, 10, 10, 100)) as never,
    sellSnapshot: snap(
      "wallex",
      ladder(194_000, -10, 10, 100),
      [lv(196_000, 1000)]
    ) as never,
    buyFeeBps: null,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: bals.filter((b) => b.sourceId === "nobitex" || b.sourceId === "wallex"),
    buyVenueAllocationToman: 10_000_000,
    portfolioValueToman: 100_000_000,
    buyVenueExposureToman: 5_000_000,
    policies: policies(),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: MARK,
      targets: [],
      maxDeviationPoints: null
    }
  });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.some((b) => b.code === "fee_unconfirmed"));
});

await test("10B with order cap 500: final ≤500 and order_cap binds", () => {
  const bals = sessionBalances(10_000_000_000);
  const buy = bals.find((b) => b.sourceId === "nobitex")!;
  const sell = bals.find((b) => b.sourceId === "wallex")!;
  const r = computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap(
      "nobitex",
      [lv(190_000, 50_000)],
      ladder(192_000, 20, 40, 5_000)
    ) as never,
    sellSnapshot: snap(
      "wallex",
      ladder(194_000, -20, 40, 5_000),
      [lv(196_000, 50_000)]
    ) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: [buy, sell],
    buyVenueAllocationToman: 2_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 0,
    policies: policies({
      max_order_size_usdt: 500,
      max_venue_exposure_percent: 100
    }),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: MARK,
      targets: targetsFromAllocations(
        bals.map((b) => ({
          sourceId: b.sourceId as string,
          irtToman: b.irtToman,
          usdtUnits: microsToUsdt(b.usdtMicros)
        })),
        MARK
      ),
      maxDeviationPoints: 50
    }
  });
  assert.equal(r.status, "SIZED", JSON.stringify(r.blockers));
  assert.ok(r.sizeUsdtMicros! <= usdtToMicros(500) + 100, `size ${microsToUsdt(r.sizeUsdtMicros!)}`);
  assert.equal(r.bindingConstraint, "policy_max_order_size");
  assert.ok(r.audit);
  assert.equal(r.audit!.bindingConstraint, "policy_max_order_size");
  assert.ok((r.audit!.limits.orderCapUsdtMicros ?? 0) <= usdtToMicros(500) + 1);
  console.log(
    `        order_cap500 size=${microsToUsdt(r.sizeUsdtMicros!)} binding=${r.bindingConstraint}`
  );
});

await test("tight inventory selects largest smaller valid size (adaptive)", () => {
  const bals = sessionBalances(10_000_000_000);
  const buy = bals.find((b) => b.sourceId === "nobitex")!;
  const sell = bals.find((b) => b.sourceId === "wallex")!;
  const base = {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap(
      "nobitex",
      [lv(190_000, 50_000)],
      ladder(192_000, 5, 200, 50)
    ) as never,
    sellSnapshot: snap(
      "wallex",
      ladder(194_000, -5, 200, 50),
      [lv(196_000, 50_000)]
    ) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: [buy, sell],
    buyVenueAllocationToman: 2_000_000_000,
    portfolioValueToman: 10_000_000_000,
    buyVenueExposureToman: 0,
    policies: policies({ max_order_size_usdt: 1_000_000, max_venue_exposure_percent: 100 }),
    slippageBufferBps: 5
  };
  const targets = targetsFromAllocations(
    bals.map((b) => ({
      sourceId: b.sourceId as string,
      irtToman: b.irtToman,
      usdtUnits: microsToUsdt(b.usdtMicros)
    })),
    MARK
  );
  const wide = computeRouteSize({
    ...base,
    inventoryModel: { valuationPriceToman: MARK, targets, maxDeviationPoints: 50 }
  });
  const tight = computeRouteSize({
    ...base,
    inventoryModel: { valuationPriceToman: MARK, targets, maxDeviationPoints: 1 }
  });
  assert.equal(wide.status, "SIZED");
  assert.equal(tight.status, "SIZED", JSON.stringify(tight.blockers));
  assert.ok(tight.sizeUsdtMicros! < wide.sizeUsdtMicros!);
  assert.ok(tight.sizeUsdtMicros! >= MIN_EXECUTABLE_USDT_MICROS);
  assert.ok((tight.audit?.adaptive.candidateCount ?? 0) > 5, "adaptive densify");
  console.log(
    `        tight inventory size=${microsToUsdt(tight.sizeUsdtMicros!)} vs wide=${microsToUsdt(wide.sizeUsdtMicros!)}`
  );
});

await test("adaptive densify: more execution points than analysis probes alone", () => {
  const set = buildSmartCandidates({
    buyUsableMicros: usdtToMicros(5_000),
    sellUsableMicros: usdtToMicros(5_000),
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(5_000),
    sellDepthMicros: usdtToMicros(5_000),
    extraCapsMicros: [],
    granularityMicros: 100,
    buyLevels: ladder(192_000, 10, 20, 250),
    sellLevels: ladder(194_000, -10, 20, 250)
  });
  assert.ok(set.quantities.length > set.ladder.filter((l) => l.kept).length);
  assert.ok(set.adaptive.executionPointCount >= 2);
  assert.equal(set.adaptive.analysisPointCount, 5);
});

await test("complete sizing audit is present on SIZED results", () => {
  const r = sizeAtCapital(100_000_000, 1_000, 20);
  assert.equal(r.status, "SIZED");
  assert.ok(r.audit);
  assert.equal(r.audit!.status, "SIZED");
  assert.equal(r.audit!.finalSizeUsdtMicros, r.sizeUsdtMicros);
  assert.ok(r.audit!.safeCeilingUsdtMicros !== null);
  assert.ok(r.audit!.limits.minExecutableUsdtMicros === MIN_EXECUTABLE_USDT_MICROS);
  assert.ok(r.audit!.buyVwapToman && r.audit!.sellVwapToman);
  assert.ok((r.audit!.predictedRiskAdjustedNetToman ?? 0) > 0);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
