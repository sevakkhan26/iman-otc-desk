#!/usr/bin/env npx tsx
/**
 * Paper portfolio accounting — pure reconciliation and empty-book honesty.
 */
import assert from "node:assert/strict";
import {
  buildPortfolioAccounting,
  filterFillsByWindow,
  tehranDayStartMs,
  type AccountingFill
} from "../src/lib/shadowArbitrage/paper/accounting.ts";

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

const asOf = "2026-08-05T12:00:00.000Z";
const opening = [
  { sourceId: "nobitex", irtToman: 5_000_000_000, usdtUnits: 0 },
  { sourceId: "wallex", irtToman: 0, usdtUnits: 25_000 }
];
// 25k USDT @ 200_000 = 5e9; total capital 10e9
const balances = [
  { sourceId: "nobitex" as const, irtToman: 4_999_000_000, usdtMicros: 0 },
  { sourceId: "wallex" as const, irtToman: 0, usdtMicros: 25_005_000_000 }
];

const fill: AccountingFill = {
  id: "f1",
  lifecycleId: "lc1",
  routeKey: "nobitex>wallex",
  buySourceId: "nobitex",
  sellSourceId: "wallex",
  sizeUsdt: 100,
  buyVwapToman: 200_000,
  sellVwapToman: 200_500,
  buyNotionalToman: 20_000_000,
  sellNotionalToman: 20_050_000,
  feeTomanTotal: 50_000,
  feeUsdtMicrosTotal: 25_000,
  sellFeeValueToman: 5_000,
  grossSpreadToman: 50_000,
  cashPnlIrtToman: 40_000,
  economicNetPnlToman: 35_000,
  riskAdjustedPnlToman: 30_000,
  slippageBufferToman: 5_000,
  markPriceToman: 200_000,
  occurredAt: "2026-08-05T10:00:00.000Z",
  outcome: "FILLED"
};

await test("empty book: zero open orders and positions", () => {
  const a = buildPortfolioAccounting({
    asOf,
    initialCapitalToman: 10_000_000_000,
    markPriceToman: 200_000,
    balances: balances as never,
    opening,
    fills: [],
    todayStartMs: tehranDayStartMs(Date.parse(asOf))
  });
  assert.deepEqual(a.openOrders, []);
  assert.deepEqual(a.openPositions, []);
  assert.equal(a.reservedInOrdersToman, 0);
  assert.equal(a.committedToPositionsToman, 0);
  assert.ok(a.openOrdersNoteFa.includes("سفارش"));
});

await test("equity reconciles with initial + realized + unrealized", () => {
  const a = buildPortfolioAccounting({
    asOf,
    initialCapitalToman: 10_000_000_000,
    markPriceToman: 200_000,
    balances: balances as never,
    opening,
    fills: [fill],
    todayStartMs: tehranDayStartMs(Date.parse(asOf))
  });
  assert.equal(a.reconciliation.equityMatchesInitialPlusPnl, true);
  assert.equal(a.reconciliation.freePlusReservedPlusCommittedEqualsEquity, true);
  assert.equal(a.reconciliation.venueSumEqualsPortfolioEquity, true);
  assert.equal(a.reconciliation.feeLedgerSumMatchesBucket, true);
  assert.equal(a.realizedEconomicPnlToman, 35_000);
  assert.equal(a.fees.feeToman, 50_000);
  assert.equal(a.fees.feeUsdtMicros, 25_000);
});

await test("missing mark makes equity and return unknown, not zero", () => {
  const a = buildPortfolioAccounting({
    asOf,
    initialCapitalToman: 10_000_000_000,
    markPriceToman: null,
    balances: balances as never,
    opening,
    fills: [fill],
    todayStartMs: tehranDayStartMs(Date.parse(asOf))
  });
  assert.equal(a.equityToman, null);
  assert.equal(a.returnPercent, null);
  assert.equal(a.markPriceProvisional, true);
  assert.equal(a.fees.feeUsdtValueToman, null);
});

await test("candidates are not fills — only FILLED rows count as closed trades", () => {
  const skip: AccountingFill = { ...fill, id: "s1", outcome: "SKIPPED", economicNetPnlToman: null };
  const a = buildPortfolioAccounting({
    asOf,
    initialCapitalToman: 10_000_000_000,
    markPriceToman: 200_000,
    balances: balances as never,
    opening,
    fills: [fill, skip],
    todayStartMs: tehranDayStartMs(Date.parse(asOf))
  });
  assert.equal(a.realizedEconomicPnlToman, 35_000);
  assert.equal(a.fees.byTrade.length, 1);
});

await test("fee window filter is pure", () => {
  const old: AccountingFill = {
    ...fill,
    id: "old",
    occurredAt: "2026-01-01T00:00:00.000Z"
  };
  const now = Date.parse(asOf);
  assert.equal(filterFillsByWindow([fill, old], "lifetime", now).length, 2);
  assert.equal(filterFillsByWindow([fill, old], "30d", now).length, 1);
});

await test("free equals total balance under immediate-fill model", () => {
  const a = buildPortfolioAccounting({
    asOf,
    initialCapitalToman: 10_000_000_000,
    markPriceToman: 200_000,
    balances: balances as never,
    opening,
    fills: [],
    todayStartMs: tehranDayStartMs(Date.parse(asOf))
  });
  for (const v of a.venues) {
    assert.equal(v.freeIrtToman, v.irtToman);
    assert.equal(v.reservedIrtToman, 0);
    assert.equal(v.committedIrtToman, 0);
  }
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
