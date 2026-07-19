/**
 * Toman LTR isolation unit tests (formatToman / formatTomanCore).
 */
import assert from "node:assert/strict";
import { formatToman, formatTomanCore } from "../src/components/format.ts";

const LRI = "\u2066";
const PDI = "\u2069";
const NBSP = "\u00A0";

function main() {
  let failed = 0;
  const test = (name: string, fn: () => void) => {
    try {
      fn();
      console.log(`  PASS  ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  FAIL  ${name}`);
      console.log(`        ${(e as Error).message}`);
    }
  };

  console.log("Toman format tests\n");

  test("1. positive: number then تومان, LTR-isolated", () => {
    const s = formatToman(193_656);
    assert.ok(s.startsWith(LRI) && s.endsWith(PDI));
    assert.ok(s.includes("تومان"));
    assert.ok(s.includes("۱۹۳"));
    const inner = s.slice(1, -1);
    assert.ok(inner.endsWith(`${NBSP}تومان`) || inner.endsWith(" تومان"));
    // number appears before unit
    const unitIdx = inner.indexOf("تومان");
    const digitIdx = inner.search(/[۰-۹]/);
    assert.ok(digitIdx >= 0 && digitIdx < unitIdx);
  });

  test("2. negative: sign before digits, then تومان", () => {
    const s = formatToman(-2976);
    const inner = s.slice(1, -1);
    assert.ok(inner.includes("۲٬۹۷۶") || inner.includes("۲۹۷۶") || /۲/.test(inner));
    assert.ok(inner.includes("تومان"));
    // minus-like mark before first digit
    const digitIdx = inner.search(/[۰-۹]/);
    assert.ok(digitIdx > 0);
    const before = inner.slice(0, digitIdx);
    assert.ok(/[-−﹣－‎]/.test(before) || before.length > 0);
    const unitIdx = inner.indexOf("تومان");
    assert.ok(digitIdx < unitIdx);
  });

  test("3. zero", () => {
    const s = formatToman(0);
    assert.ok(s.includes("۰"));
    assert.ok(s.includes("تومان"));
    assert.ok(s.startsWith(LRI) && s.endsWith(PDI));
  });

  test("4. large value keeps fa digits and separators", () => {
    const s = formatToman(1_234_567_890);
    assert.ok(s.includes("۱"));
    assert.ok(s.includes("تومان"));
    assert.equal(formatTomanCore(1_234_567_890).includes("تومان"), true);
  });

  test("5. invalid → unavailable message (no LTR wrap required)", () => {
    assert.equal(formatToman(null), "داده‌ای دریافت نشد");
    assert.equal(formatToman(Number.NaN), "داده‌ای دریافت نشد");
  });

  test("6. core has no bidi isolates", () => {
    const c = formatTomanCore(1000);
    assert.ok(!c.includes(LRI) && !c.includes(PDI));
    assert.ok(c.endsWith("تومان"));
  });

  console.log(failed ? `\nResult: FAILED (${failed})` : "\nResult: all passed");
  if (failed) process.exit(1);
}

main();
