/**
 * Surgical Toman order: isolated number + unit outside (RTL parent).
 * String: LRI + digits + PDI + NBSP + تومان
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

  console.log("Toman surgical bidi tests\n");

  test("1. number is LTR-isolated; تومان is outside isolate", () => {
    const s = formatToman(193_414);
    assert.ok(s.startsWith(LRI));
    assert.ok(s.includes(PDI));
    const pdi = s.indexOf(PDI);
    assert.ok(s.slice(pdi + 1).includes("تومان"));
    assert.ok(!s.slice(0, pdi + 1).includes("تومان"));
    assert.ok(s.includes("۱۹۳"));
  });

  test("2. digits helper is plain fa-IR", () => {
    const d = formatTomanDigits(-2976);
    assert.ok(!d.includes(LRI) && !d.includes(PDI));
    assert.ok(!d.includes("تومان"));
    assert.ok(/[۰-۹]/.test(d));
  });

  test("3. zero / large / invalid", () => {
    assert.ok(formatToman(0).includes("۰"));
    assert.ok(formatToman(1_234_567_890).includes("۱"));
    assert.equal(formatToman(null), "داده‌ای دریافت نشد");
  });

  test("4. negative sign stays with number inside isolate", () => {
    const s = formatToman(-2976);
    const inner = s.slice(s.indexOf(LRI) + 1, s.indexOf(PDI));
    assert.ok(/[۰-۹]/.test(inner));
    assert.ok(!inner.includes("تومان"));
  });

  console.log(failed ? `\nResult: FAILED (${failed})` : "\nResult: all passed");
  if (failed) process.exit(1);
}

main();
