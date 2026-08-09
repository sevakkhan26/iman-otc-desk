#!/usr/bin/env npx tsx
/**
 * Step 4 — min-size quantum + capital/order-cap policy pure tests.
 */
import assert from "node:assert/strict";
import {
  LEDGER_SIZE_QUANTUM_MICROS,
  computeRouteSize
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
import {
  clearVenueExecutionLimitsRegistry,
  seedLocalPaperExecutionLimits,
  resolveRouteExecutionFloor,
  getVenueExecutionLimit
} from "../src/lib/shadowArbitrage/paper/venueExecutionLimits.ts";

clearVenueExecutionLimitsRegistry();
seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });

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

await test("ledger quantum is precision only; venue min is separate", () => {
  assert.equal(LEDGER_SIZE_QUANTUM_MICROS, 100);
  const floor = resolveRouteExecutionFloor("nobitex", "wallex");
  assert.equal(floor.ok, true);
  if (!floor.ok) return;
  assert.equal(floor.minMicros, usdtToMicros(5));
  assert.ok(floor.minMicros < usdtToMicros(25));
  assert.ok(floor.minMicros > LEDGER_SIZE_QUANTUM_MICROS);
});

await test("missing venue min fails closed with venue_min_unknown", () => {
  clearVenueExecutionLimitsRegistry();
  const r = computeRouteSize({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySnapshot: snap("nobitex", [lv(190_000, 50_000)], ladder(192_000, 1, 5, 5_000)) as never,
    sellSnapshot: snap("wallex", ladder(200_000, -1, 5, 5_000), [lv(202_000, 50_000)]) as never,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buySettlement: settlementFor("nobitex" as never, "buy"),
    sellSettlement: settlementFor("wallex" as never, "sell"),
    balances: [
      { sourceId: "nobitex", irtToman: 1e9, usdtMicros: usdtToMicros(1000) },
      { sourceId: "wallex", irtToman: 1e9, usdtMicros: usdtToMicros(1000) }
    ],
    buyVenueAllocationToman: 1e9,
    portfolioValueToman: 2e9,
    buyVenueExposureToman: 0,
    policies: policies(),
    slippageBufferBps: 5,
    inventoryModel: { valuationPriceToman: MARK, targets: [], maxDeviationPoints: 100 }
  });
  assert.equal(r.status, "BLOCKED");
  assert.ok(r.blockers.some((b) => b.code === "venue_min_unknown"));
  seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });
});

await test("legacy 25 floor gone: verified min 5 → size ≥5 and can be <25", () => {
  seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });
  const lim = getVenueExecutionLimit("nobitex");
  assert.ok(lim);
  assert.equal(lim!.minNotionalUsdtMicros, usdtToMicros(5));
  assert.ok(lim!.minNotionalUsdtMicros < usdtToMicros(25));

  // Controlled books + order cap 12: final must land in [5, 25) — valid, not dust.
  const bals = [
    { sourceId: "nobitex", irtToman: 1e9, usdtMicros: usdtToMicros(1000) },
    { sourceId: "wallex", irtToman: 1e9, usdtMicros: usdtToMicros(1000) }
  ];
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
    buyVenueAllocationToman: 1e9,
    portfolioValueToman: 2e9,
    buyVenueExposureToman: 0,
    policies: policies({ max_order_size_usdt: 12, max_inventory_deviation_percent: 100 }),
    slippageBufferBps: 5,
    inventoryModel: {
      valuationPriceToman: MARK,
      targets: targetsFromAllocations(
        bals.map((b) => ({
          sourceId: b.sourceId,
          irtToman: b.irtToman,
          usdtUnits: microsToUsdt(b.usdtMicros)
        })),
        MARK
      ),
      maxDeviationPoints: 100
    }
  });
  assert.equal(r.status, "SIZED", JSON.stringify(r.blockers));
  assert.ok(r.sizeUsdtMicros! >= usdtToMicros(5), "≥ verified venue min 5");
  assert.ok(r.sizeUsdtMicros! < usdtToMicros(25), "legacy 25 ladder floor is gone");
  assert.ok(r.sizeUsdtMicros! > LEDGER_SIZE_QUANTUM_MICROS, "not ledger dust");
  assert.ok(r.sizeUsdtMicros! <= usdtToMicros(12) + 100, "respects order cap 12");
  console.log(`        sub-25 size=${r.sizeUsdt} (venueMin=5, orderCap=12)`);
});

await test("100M capital can size with verified min below 25 when inventory/econ allow", () => {
  seedLocalPaperExecutionLimits({ minNotionalUsdt: 5, quantityStepUsdt: 0.01 });
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
  assert.ok(r.sizeUsdtMicros! >= usdtToMicros(5), "respects verified venue min 5");
  // Must not be forced to obsolete 25 ladder floor when capital/min allow smaller.
  // (May still size ≥25 if capital cap is higher — assert not blocked by 25-only.)
  assert.ok(r.sizeUsdtMicros! > 0);
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
  // Closed band: maxDeviation 0 → always BLOCKED inventory_limit (no dust).
  const closed = computeRouteSize({
    ...base,
    inventoryModel: { valuationPriceToman: MARK, targets, maxDeviationPoints: 0 }
  });
  assert.equal(wide.status, "SIZED");
  assert.equal(tight.status, "SIZED");
  assert.ok(tight.sizeUsdtMicros! < wide.sizeUsdtMicros!);
  assert.equal(closed.status, "BLOCKED");
  assert.ok(closed.blockers.some((b) => b.code === "inventory_limit"));
  console.log(`        tight=${tight.sizeUsdt} wide=${wide.sizeUsdt} closed=${closed.status}`);
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
