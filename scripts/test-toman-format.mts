/**
 * Toman visual L→R: تومان then number (unit left, amount right).
 */
import assert from "node:assert/strict";
import { formatToman, formatTomanDigits } from "../src/components/format.ts";

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

  console.log("Toman amount-order tests\n");

  test("1. unit first inside LTR isolate, then digits", () => {
    const s = formatToman(193_995);
    assert.ok(s.startsWith(LRI) && s.endsWith(PDI));
    const inner = s.slice(1, -1);
    assert.ok(inner.startsWith("تومان"));
    const unitIdx = inner.indexOf("تومان");
    const digitIdx = inner.search(/[۰-۹]/);
    assert.ok(unitIdx === 0 && digitIdx > unitIdx);
  });

  test("2. negative keeps sign with digits after unit", () => {
    const s = formatToman(-2976);
    const inner = s.slice(1, -1);
    assert.ok(inner.startsWith("تومان"));
    const after = inner.slice("تومان".length);
    assert.ok(/[۰-۹]/.test(after));
  });

  test("3. zero / large / invalid", () => {
    assert.ok(formatToman(0).includes("۰"));
    assert.ok(formatToman(1_234_567_890).includes("۱"));
    assert.equal(formatToman(null), "داده‌ای دریافت نشد");
  });

  test("4. digits helper has no unit", () => {
    const d = formatTomanDigits(1000);
    assert.ok(!d.includes("تومان"));
    assert.ok(!d.includes(LRI));
  });

  console.log(failed ? `\nResult: FAILED (${failed})` : "\nResult: all passed");
  if (failed) process.exit(1);
}

main();
