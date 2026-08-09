#!/usr/bin/env npx tsx
/**
 * Step 6 — pure session setup helpers (no network).
 */
import assert from "node:assert/strict";
import {
  PAPER_POLICY_MIN_USDT,
  buildSessionSetupPreview,
  computeSessionEndsAt,
  formatSessionSetupNote,
  parseDurationDays,
  parseManualOrderCapUsdt,
  parseSessionSetupNote,
  deriveOrderCapUsdt,
  ORDER_CAP_DERIVED_ACTOR
} from "../src/lib/shadowArbitrage/paper/sessionCapital.ts";

const VENUES = [
  "nobitex",
  "wallex",
  "tabdeal",
  "bitpin",
  "abantether",
  "ramzinex",
  "tetherland",
  "bit24",
  "arzinja"
];
const MARK = 200_000;
const CLOCK = Date.parse("2026-08-09T12:00:00.000Z");

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? e.message : e}`);
    failed += 1;
  }
}

test("paper_policy_min is fixed 5", () => {
  assert.equal(PAPER_POLICY_MIN_USDT, 5);
});

test("duration days parse fail-closed", () => {
  assert.equal(parseDurationDays(4).ok, true);
  assert.equal(parseDurationDays(0).ok, false);
  assert.equal(parseDurationDays(1.5).ok, false);
  assert.equal(parseDurationDays(400).ok, false);
});

test("endsAt is exact whole days from start", () => {
  const ends = computeSessionEndsAt(CLOCK, 4);
  assert.equal(ends, new Date(CLOCK + 4 * 86_400_000).toISOString());
  assert.equal(Date.parse(ends) - CLOCK, 4 * 86_400_000);
});

test("AUTO: 100M → 10B derived cap and smart ceiling grow", () => {
  const a = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4,
    clockMs: CLOCK
  });
  const b = buildSessionSetupPreview({
    totalCapitalToman: 10_000_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4,
    clockMs: CLOCK
  });
  assert.equal(a.orderCap.mode, "capital_derived");
  assert.equal(a.orderCap.willWritePolicy, true);
  assert.equal(a.orderCap.derivedMaxOrderUsdt, deriveOrderCapUsdt({ equityToman: 100_000_000, markPriceToman: MARK }));
  assert.equal(b.orderCap.derivedMaxOrderUsdt, deriveOrderCapUsdt({ equityToman: 10_000_000_000, markPriceToman: MARK }));
  assert.ok(b.orderCap.effectiveMaxOrderUsdt > a.orderCap.effectiveMaxOrderUsdt);
  assert.ok(b.smartSizeCeilingUsdt > a.smartSizeCeilingUsdt);
  assert.equal(a.paperPolicyMinUsdt, 5);
  assert.equal(a.residualToman, 0);
  assert.equal(b.residualToman, 0);
  assert.ok(a.usableCapitalToman < a.totalCapitalToman);
  assert.ok(a.reserveCapitalToman > 0);
});

test("MANUAL 500: both capitals effective cap stay 500", () => {
  const a = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    activeSessionId: null,
    orderCapChoice: "MANUAL",
    manualOrderCapUsdt: 500,
    durationDays: 7,
    clockMs: CLOCK
  });
  const b = buildSessionSetupPreview({
    totalCapitalToman: 10_000_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    activeSessionId: null,
    orderCapChoice: "MANUAL",
    manualOrderCapUsdt: 500,
    durationDays: 7,
    clockMs: CLOCK
  });
  assert.equal(a.orderCap.effectiveMaxOrderUsdt, 500);
  assert.equal(b.orderCap.effectiveMaxOrderUsdt, 500);
  // Setup ceiling = min(manual cap, capital-derived route/util backstop).
  assert.ok(a.smartSizeCeilingUsdt <= 500);
  assert.ok(b.smartSizeCeilingUsdt <= 500);
  assert.equal(b.smartSizeCeilingUsdt, 500, "at 10B derived≥500 so ceiling binds at manual 500");
  assert.ok(b.orderCap.derivedMaxOrderUsdt > 500);
  assert.equal(a.orderCap.mode, "explicit_admin");
  assert.equal(a.orderCap.willWritePolicy, true);
});

test("duration produces exact endsAt in preview", () => {
  const p = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 10,
    clockMs: CLOCK
  });
  assert.equal(p.durationDays, 10);
  assert.equal(p.endsAt, computeSessionEndsAt(CLOCK, 10));
  assert.equal(p.startedAt, new Date(CLOCK).toISOString());
});

test("setup note round-trips endsAt and order cap", () => {
  const p = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    activeSessionId: "s1",
    orderCapChoice: "MANUAL",
    manualOrderCapUsdt: 500,
    durationDays: 3,
    clockMs: CLOCK
  });
  const note = formatSessionSetupNote({
    version: 1,
    durationDays: p.durationDays,
    endsAt: p.endsAt,
    startedAt: p.startedAt,
    orderCapChoice: "MANUAL",
    orderCapUsdt: 500,
    paperPolicyMinUsdt: 5,
    totalCapitalToman: p.totalCapitalToman,
    valuationPriceToman: p.valuationPriceToman,
    previewToken: p.previewToken
  });
  const parsed = parseSessionSetupNote(note);
  assert.ok(parsed);
  assert.equal(parsed!.endsAt, p.endsAt);
  assert.equal(parsed!.orderCapChoice, "MANUAL");
  assert.equal(parsed!.orderCapUsdt, 500);
  assert.equal(parsed!.durationDays, 3);
});

test("manual cap below paper min rejected", () => {
  assert.equal(parseManualOrderCapUsdt(4).ok, false);
  assert.equal(parseManualOrderCapUsdt(5).ok, true);
});

test("ORDER_CAP_DERIVED_ACTOR constant stable", () => {
  assert.equal(ORDER_CAP_DERIVED_ACTOR, "capital-derived");
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
