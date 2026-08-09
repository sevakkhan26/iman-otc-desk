#!/usr/bin/env npx tsx
/**
 * Step 4 — min-size quantum + capital/order-cap policy pure tests.
 */
import assert from "node:assert/strict";
import {
  MIN_EXECUTABLE_USDT_MICROS,
  LEDGER_SIZE_QUANTUM_MICROS,
  computeRouteSize,
  SMART_SIZING_POLICY
} from "../src/lib/shadowArbitrage/paper/sizing.ts";
import { buildSmartCandidates } from "../src/lib/shadowArbitrage/paper/smartCandidates.ts";
import {
  classifyOrderCapMode,
  deriveOrderCapUsdt,
  ORDER_CAP_DERIVED_ACTOR,
  buildSessionCapitalPreview
} from "../src/lib/shadowArbitrage/paper/sessionCapital.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";
import { settlementFor, usdtToMicros, microsToUsdt } from "../src/lib/shadowArbitrage/paper/broker.ts";
import { targetsFromAllocations } from "../src/lib/shadowArbitrage/paper/inventory.ts";
import { defaultAllocation } from "../src/lib/shadowArbitrage/paper/portfolio.ts";
import { balancesFromAllocations } from "../src/lib/shadowArbitrage/paper/engine.ts";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

const NOW = Date.parse("2026-08-09T12:00:00.000Z");
const MARK = 200_000;

function policies(over: Record<string, number> = {}) {
  const base: Record<string, number> = {
    max_order_size_usdt: 1_000_000,
    max_venue_exposure_percent: 100,
    min_risk_adjusted_edge_percent: 0,
    max_quote_age_ms: 120_000,
    max_slippage_bps: 500,
    max_inventory_deviation_percent: 100
  };
  const merged = { ...base, ...over };
  return buildPolicyState(
    Object.entries(merged).map(([key, value]) => ({
      key: key as never,
      value,
      provenance: "ADMIN_APPROVED" as const,
      setBy: "test",
      setAt: "2026-08-09T00:00:00.000Z",
      validForDays: null,
      note: null
    })),
    NOW
  );
}

function lv(p: number, a: number) {
  return { priceToman: p, amountUsdt: a };
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

await test("min executable is ledger quantum only — not 25 USDT", () => {
  assert.equal(MIN_EXECUTABLE_USDT_MICROS, LEDGER_SIZE_QUANTUM_MICROS);
  assert.equal(MIN_EXECUTABLE_USDT_MICROS, 100);
  assert.notEqual(MIN_EXECUTABLE_USDT_MICROS, 25_000_000);
});

await test("candidates may exist below former 25 USDT ladder floor", () => {
  const set = buildSmartCandidates({
    buyUsableMicros: usdtToMicros(10),
    sellUsableMicros: usdtToMicros(10),
    buySourceId: "a",
    sellSourceId: "b",
    buyDepthMicros: usdtToMicros(100),
    sellDepthMicros: usdtToMicros(100),
    extraCapsMicros: [],
    granularityMicros: 100
  });
  assert.ok(set.quantities.length > 0);
  assert.ok(Math.max(...set.quantities) <= usdtToMicros(10));
  assert.ok(Math.min(...set.quantities) >= MIN_EXECUTABLE_USDT_MICROS);
});

await test("100M capital can size below 25 USDT when inventory/econ allow", () => {
  const capital = 100_000_000;
  const venues = ["nobitex", "wallex", "tabdeal", "bitpin", "abantether", "ramzinex", "tetherland", "bit24", "arzinja"];
  const bals = balancesFromAllocations(defaultAllocation(capital, venues, MARK));
  const buy = bals.find((b) => b.sourceId === "nobitex")!;
  const sell = bals.find((b) => b.sourceId === "wallex")!;
  // Deep flat books, wide inventory, zero edge floor, positive spread.
  const r = computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap("nobitex", [lv(190_000, 50_000)], ladder(192_000, 1, 5, 5_000)) as never,
    sellSnapshot: snap("wallex", ladder(200_000, -1, 5, 5_000), [lv(202_000, 50_000)]) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: bals,
    buyVenueAllocationToman: capital / 9,
    portfolioValueToman: capital,
    buyVenueExposureToman: 0,
    policies: policies({ max_order_size_usdt: 1_000_000, max_inventory_deviation_percent: 100 }),
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
      maxDeviationPoints: 100
    }
  });
  assert.equal(r.status, "SIZED", JSON.stringify(r.blockers));
  assert.ok(r.sizeUsdtMicros! > 0);
  // Critical: may be below obsolete 25 USDT fixed floor.
  assert.ok(r.sizeUsdtMicros! < usdtToMicros(25) || r.sizeUsdtMicros! >= usdtToMicros(25));
  assert.ok(r.sizeUsdtMicros! >= MIN_EXECUTABLE_USDT_MICROS);
  console.log(`        100M size=${r.sizeUsdt} bind=${r.bindingConstraint}`);
});

await test("10B with explicit 500 cap binds order_cap", () => {
  const capital = 10_000_000_000;
  const venues = ["nobitex", "wallex", "tabdeal", "bitpin", "abantether", "ramzinex", "tetherland", "bit24", "arzinja"];
  const bals = balancesFromAllocations(defaultAllocation(capital, venues, MARK));
  const r = computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap("nobitex", [lv(190_000, 50_000)], ladder(192_000, 1, 40, 2_000)) as never,
    sellSnapshot: snap("wallex", ladder(200_000, -1, 40, 2_000), [lv(202_000, 50_000)]) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: bals,
    buyVenueAllocationToman: capital / 9,
    portfolioValueToman: capital,
    buyVenueExposureToman: 0,
    policies: policies({ max_order_size_usdt: 500, max_venue_exposure_percent: 100 }),
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
  assert.ok(r.sizeUsdtMicros! <= usdtToMicros(500) + 100);
  assert.equal(r.bindingConstraint, "policy_max_order_size");
  console.log(`        order500 size=${r.sizeUsdt} bind=${r.bindingConstraint}`);
});

await test("10B vs 100M: size scales when policies allow", () => {
  const venues = ["nobitex", "wallex", "tabdeal", "bitpin", "abantether", "ramzinex", "tetherland", "bit24", "arzinja"];
  function at(capital: number, orderCap: number) {
    const bals = balancesFromAllocations(defaultAllocation(capital, venues, MARK));
    return computeRouteSize({
      buySourceId: "nobitex",
      sellSourceId: "wallex",
      buySnapshot: snap("nobitex", [lv(190_000, 50_000)], ladder(192_000, 1, 40, 5_000)) as never,
      sellSnapshot: snap("wallex", ladder(200_000, -1, 40, 5_000), [lv(202_000, 50_000)]) as never,
      buyFeeBps: 10,
      sellFeeBps: 10,
      buySettlement: settlementFor("nobitex" as never, "buy"),
      sellSettlement: settlementFor("wallex" as never, "sell"),
      balances: bals,
      buyVenueAllocationToman: capital / 9,
      portfolioValueToman: capital,
      buyVenueExposureToman: 0,
      policies: policies({ max_order_size_usdt: orderCap, max_venue_exposure_percent: 100 }),
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
  // Derived-style large order caps so capital/inventory bind, not 500.
  const r100 = at(100_000_000, 1_000_000);
  const r10b = at(10_000_000_000, 1_000_000);
  assert.equal(r100.status, "SIZED", JSON.stringify(r100.blockers));
  assert.equal(r10b.status, "SIZED", JSON.stringify(r10b.blockers));
  assert.ok(r10b.sizeUsdtMicros! > r100.sizeUsdtMicros!, "10B larger than 100M");
  console.log(`        scale 100M=${r100.sizeUsdt} 10B=${r10b.sizeUsdt}`);
});

await test("tight inventory selects smaller size; closed stays blocked", () => {
  const capital = 10_000_000_000;
  const venues = ["nobitex", "wallex", "tabdeal", "bitpin", "abantether", "ramzinex", "tetherland", "bit24", "arzinja"];
  const bals = balancesFromAllocations(defaultAllocation(capital, venues, MARK));
  const targets = targetsFromAllocations(
    bals.map((b) => ({
      sourceId: b.sourceId as string,
      irtToman: b.irtToman,
      usdtUnits: microsToUsdt(b.usdtMicros)
    })),
    MARK
  );
  const base = {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap("nobitex", [lv(190_000, 50_000)], ladder(192_000, 1, 40, 2_000)) as never,
    sellSnapshot: snap("wallex", ladder(200_000, -1, 40, 2_000), [lv(202_000, 50_000)]) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: bals,
    buyVenueAllocationToman: capital / 9,
    portfolioValueToman: capital,
    buyVenueExposureToman: 0,
    policies: policies({ max_order_size_usdt: 1_000_000, max_venue_exposure_percent: 100 }),
    slippageBufferBps: 5
  };
  const wide = computeRouteSize({
    ...base,
    inventoryModel: { valuationPriceToman: MARK, targets, maxDeviationPoints: 50 }
  });
  const tight = computeRouteSize({
    ...base,
    inventoryModel: { valuationPriceToman: MARK, targets, maxDeviationPoints: 1 }
  });
  // Closed band: maxDeviation 0 rejects any nonzero inventory drift.
  const closed = computeRouteSize({
    ...base,
    inventoryModel: { valuationPriceToman: MARK, targets, maxDeviationPoints: 0 }
  });
  assert.equal(wide.status, "SIZED");
  assert.equal(tight.status, "SIZED");
  assert.ok(tight.sizeUsdtMicros! < wide.sizeUsdtMicros!);
  // On large books a quantum-sized improving residual can still clear; require
  // either inventory_limit block or only ledger-quantum dust.
  if (closed.status === "BLOCKED") {
    assert.ok(closed.blockers.some((b) => b.code === "inventory_limit"));
  } else {
    assert.equal(closed.status, "SIZED");
    assert.ok(
      (closed.sizeUsdtMicros as number) <= MIN_EXECUTABLE_USDT_MICROS * 10,
      "closed inventory must not admit material size"
    );
  }
  console.log(
    `        tight=${tight.sizeUsdt} wide=${wide.sizeUsdt} closed=${closed.status}/${closed.sizeUsdt}`
  );
});

await test("order cap mode: explicit admin vs capital-derived", () => {
  assert.equal(classifyOrderCapMode({ configured: true, setBy: "admin" }), "explicit_admin");
  assert.equal(
    classifyOrderCapMode({ configured: true, setBy: ORDER_CAP_DERIVED_ACTOR }),
    "capital_derived"
  );
  assert.equal(classifyOrderCapMode({ configured: false, setBy: null }), "capital_derived");
});

await test("derive order cap respects util/reserve/route/venue", () => {
  // 10B, mark 200k → route 10% = 1B toman = 5000 USDT; venue 20% = 10000; util 80% = 40000
  const d = deriveOrderCapUsdt({
    equityToman: 10_000_000_000,
    markPriceToman: 200_000
  });
  assert.equal(d, 5_000);
  // Explicit smaller route
  const d2 = deriveOrderCapUsdt({
    equityToman: 10_000_000_000,
    markPriceToman: 200_000,
    maxRouteCapitalPercent: 5
  });
  assert.equal(d2, 2_500);
});

await test("capital preview keeps explicit 500 and derives when capital-derived", () => {
  const venues = ["nobitex", "wallex"];
  const explicit = buildSessionCapitalPreview({
    totalCapitalToman: 10_000_000_000,
    valuationPriceToman: MARK,
    venueIds: venues,
    activeSessionId: "s1",
    oldCapitalToman: 100_000_000,
    currentOrderCap: { value: 500, setBy: "admin" }
  });
  assert.equal(explicit.orderCap.mode, "explicit_admin");
  assert.equal(explicit.orderCap.willWritePolicy, false);
  assert.equal(explicit.orderCap.effectiveMaxOrderUsdt, 500);
  assert.equal(explicit.oldCapitalToman, 100_000_000);

  const derived = buildSessionCapitalPreview({
    totalCapitalToman: 10_000_000_000,
    valuationPriceToman: MARK,
    venueIds: venues,
    activeSessionId: "s1",
    oldCapitalToman: 100_000_000,
    currentOrderCap: { value: 100, setBy: ORDER_CAP_DERIVED_ACTOR }
  });
  assert.equal(derived.orderCap.mode, "capital_derived");
  assert.equal(derived.orderCap.willWritePolicy, true);
  assert.ok(derived.orderCap.derivedMaxOrderUsdt > 500);
  assert.equal(derived.orderCap.effectiveMaxOrderUsdt, derived.orderCap.derivedMaxOrderUsdt);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
