#!/usr/bin/env npx tsx
/**
 * Presentation helpers for Paper session/experiment lifecycle.
 * Must not invent a 14-day window or fabricate zeros.
 */
import assert from "node:assert/strict";
import {
  dayIndexOf,
  durationDaysFromRange,
  finiteOrNull,
  operatorLifecycleStatus,
  remainingDaysFromMs
} from "../src/components/shadowArbitrage/sessionLifecycle.ts";

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

await test("RUNNING session is running even if experiment missing", () => {
  assert.equal(operatorLifecycleStatus({ sessionStatus: "RUNNING" }), "running");
});

await test("STOPPED + COMPLETED experiment is completed", () => {
  assert.equal(
    operatorLifecycleStatus({ sessionStatus: "STOPPED", experimentStatus: "COMPLETED" }),
    "completed"
  );
});

await test("PAUSED session is paused", () => {
  assert.equal(operatorLifecycleStatus({ sessionStatus: "PAUSED", experimentStatus: "ACTIVE" }), "paused");
});

await test("duration days from range, no 14-day default", () => {
  assert.equal(
    durationDaysFromRange("2026-08-11T00:00:00.000Z", "2026-08-25T00:00:00.000Z"),
    14
  );
  assert.equal(durationDaysFromRange(null, "2026-08-25T00:00:00.000Z"), null);
  assert.equal(durationDaysFromRange("bad", "also-bad"), null);
});

await test("day X of N clamps and stays null without duration", () => {
  assert.deepEqual(dayIndexOf(3 * 86_400_000, 14), { day: 4, of: 14 });
  assert.deepEqual(dayIndexOf(0, 14), { day: 1, of: 14 });
  assert.deepEqual(dayIndexOf(86_400_000 * 20, 14), { day: 14, of: 14 });
  assert.deepEqual(dayIndexOf(3_000, null), { day: null, of: null });
});

await test("remaining days and finiteOrNull never coerce missing to 0", () => {
  assert.equal(remainingDaysFromMs(2 * 86_400_000), 2);
  assert.equal(remainingDaysFromMs(null), null);
  assert.equal(finiteOrNull(undefined), null);
  assert.equal(finiteOrNull(Number.NaN), null);
  assert.equal(finiteOrNull(0), 0);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
