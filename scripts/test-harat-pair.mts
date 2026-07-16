/**
 * Harat USD pair coherence regression (no network).
 * Run: npx tsx scripts/test-harat-pair.mts
 */
import assert from "node:assert/strict";
import { isCoherentUsdIrtPair } from "../src/lib/providers/fxStreet.ts";

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

console.log("Harat USD pair validation\n");

test("rejects reported mismatched pair (17610 vs 186250)", () => {
  assert.equal(isCoherentUsdIrtPair(17610, 186250), false);
});

test("accepts realistic Harat cash pair", () => {
  assert.equal(isCoherentUsdIrtPair(186440, 186040), true);
});

test("rejects zero / negative", () => {
  assert.equal(isCoherentUsdIrtPair(0, 186000), false);
  assert.equal(isCoherentUsdIrtPair(186000, -1), false);
});

test("rejects >5% internal spread", () => {
  assert.equal(isCoherentUsdIrtPair(100000, 110000), false);
});

test("rejects out-of-range free-market USD", () => {
  assert.equal(isCoherentUsdIrtPair(500, 510), false);
  assert.equal(isCoherentUsdIrtPair(5_000_000, 5_010_000), false);
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
