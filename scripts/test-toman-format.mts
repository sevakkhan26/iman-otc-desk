/**
 * Toman visual order: L→R «تومان» then number (unit left, amount right).
 */
import assert from "node:assert/strict";
import { formatToman, formatTomanCore } from "../src/components/format.ts";

const LRI = "\u2066";
const PDI = "\u2069";

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

  console.log("Toman visual-order tests\n");

  test("1. positive: تومان left of number (core string order)", () => {
    const core = formatTomanCore(193_414);
    assert.ok(core.startsWith("تومان"));
    assert.ok(core.includes("۱۹۳"));
    const unitIdx = core.indexOf("تومان");
    const digitIdx = core.search(/[۰-۹]/);
    assert.ok(unitIdx === 0);
    assert.ok(digitIdx > unitIdx);
  });

  test("2. formatToman wraps LTR isolate", () => {
    const s = formatToman(193_414);
    assert.ok(s.startsWith(LRI) && s.endsWith(PDI));
    const inner = s.slice(1, -1);
    assert.ok(inner.startsWith("تومان"));
    const digitIdx = inner.search(/[۰-۹]/);
    assert.ok(digitIdx > 0);
  });

  test("3. negative keeps sign with number, unit still first", () => {
    const core = formatTomanCore(-2976);
    assert.ok(core.startsWith("تومان"));
    const afterUnit = core.slice(core.indexOf("تومان") + "تومان".length);
    assert.ok(/[۰-۹]/.test(afterUnit));
    // minus-like mark appears near the number portion
    assert.ok(/[-−﹣－‎]/.test(afterUnit) || afterUnit.includes("−") || afterUnit.includes("-"));
  });

  test("4. zero", () => {
    const core = formatTomanCore(0);
    assert.ok(core.startsWith("تومان"));
    assert.ok(core.includes("۰"));
  });

  test("5. large value", () => {
    const s = formatToman(1_234_567_890);
    assert.ok(s.includes("تومان"));
    assert.ok(s.includes("۱"));
    assert.ok(s.startsWith(LRI));
  });

  test("6. invalid", () => {
    assert.equal(formatToman(null), "داده‌ای دریافت نشد");
    assert.equal(formatToman(Number.NaN), "داده‌ای دریافت نشد");
  });

  console.log(failed ? `\nResult: FAILED (${failed})` : "\nResult: all passed");
  if (failed) process.exit(1);
}

main();
