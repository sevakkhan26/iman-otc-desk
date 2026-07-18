/**
 * Market bubble formula + isolation regression tests (no live network).
 */
import assert from "node:assert/strict";
import {
  classifyBubble,
  computeDollarBubble,
  computeGoldBubble,
  DIRHAM_TO_USD_MULTIPLIER,
  dollarBubblePercent,
  dollarBubbleToman,
  equivalentGram18Bubble,
  globalGoldKgToman,
  globalGoldKgUsd,
  goldBubblePercent,
  goldBubbleTomanPerKg,
  goldBubbleUsdPerKg,
  gram18FromMazane,
  localPureGoldKgFromGram18,
  realDollarFromDirham
} from "../src/lib/bubble/formulas.ts";
import { buildMarketBubbleResponse } from "../src/lib/bubble/compute.ts";
import type { FxStreetQuote, FxStreetResponse, GoldMarketQuote, GoldMarketResponse } from "../src/lib/types.ts";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}

function fxQ(
  partial: Partial<FxStreetQuote> & Pick<FxStreetQuote, "sourceId" | "sourceName" | "assetType">
): FxStreetQuote {
  return {
    buyPrice: null,
    sellPrice: null,
    midPrice: null,
    lastUpdated: new Date().toISOString(),
    status: "available",
    ...partial
  };
}

function goldQ(
  partial: Partial<GoldMarketQuote> &
    Pick<GoldMarketQuote, "sourceId" | "sourceName" | "instrument" | "unit">
): GoldMarketQuote {
  return {
    buyPrice: null,
    sellPrice: null,
    midPrice: null,
    lastUpdated: new Date().toISOString(),
    status: "available",
    ...partial
  };
}

async function main() {
  console.log("Market bubble tests\n");

  const dirham = 51_600;
  const ounce = 4036;
  const mazane = 79_466_000;

  await test("1. Dirham × 3.6725 produces implied Dollar 189501", () => {
    assert.equal(DIRHAM_TO_USD_MULTIPLIER, 3.6725);
    const real = realDollarFromDirham(dirham);
    assert.equal(real, 189_501);
  });

  await test("2. Dollar bubble Toman formula", () => {
    const real = realDollarFromDirham(dirham)!;
    const market = 192_000;
    assert.equal(dollarBubbleToman(market, real), market - real);
  });

  await test("3. Dollar bubble percent formula", () => {
    const real = 189_501;
    const bubble = 2499;
    const pct = dollarBubblePercent(bubble, real)!;
    assert.ok(Math.abs(pct - (2499 / 189_501) * 100) < 1e-9);
  });

  await test("4. Buy and Sell calculated separately", () => {
    const buy = computeDollarBubble(50_000, 185_000)!;
    const sell = computeDollarBubble(51_000, 190_000)!;
    assert.notEqual(buy.realDollarToman, sell.realDollarToman);
    assert.notEqual(buy.bubbleToman, sell.bubbleToman);
  });

  await test("5. Reference-only source does not invent buy/sell pair", () => {
    const fx: FxStreetResponse = {
      quotes: [
        fxQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          assetType: "درهم امارات",
          buyPrice: 51_600,
          sellPrice: 51_600,
          midPrice: 51_600
        }),
        fxQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          assetType: "دلار کاغذی",
          buyPrice: 192_000,
          sellPrice: 192_000,
          midPrice: 192_000
        })
      ],
      sourceStatus: "available",
      lastUpdated: new Date().toISOString()
    };
    const gold: GoldMarketResponse = { quotes: [], sourceStatus: "unavailable", lastUpdated: null };
    const res = buildMarketBubbleResponse(fx, gold);
    const card = res.dollar.sources.find((s) => s.sourceId === "navasan")!;
    assert.equal(card.buy, null);
    assert.equal(card.sell, null);
    assert.ok(card.mid);
    assert.equal(card.mid!.side, "reference");
  });

  await test("6. Gold ounce-to-kilogram USD", () => {
    const kg = globalGoldKgUsd(ounce)!;
    assert.ok(Math.abs(kg - (4036 * 1000) / 31.104) < 1e-6);
  });

  await test("7. Mazane-to-18K gram", () => {
    const g = gram18FromMazane(mazane)!;
    assert.ok(Math.abs(g - mazane / 4.3318) < 1e-6);
  });

  await test("8. Local pure kilogram", () => {
    const g = gram18FromMazane(mazane)!;
    const kg = localPureGoldKgFromGram18(g)!;
    assert.ok(Math.abs(kg - g * 1333.2) < 1e-3);
  });

  await test("9–11. Full gold bubble chain", () => {
    const detail = computeGoldBubble(ounce, dirham, mazane)!;
    const real = 189_501;
    assert.equal(detail.realDollarToman, real);
    const kgUsd = (4036 * 1000) / 31.104;
    const kgToman = kgUsd * real;
    const gram18 = mazane / 4.3318;
    const localKg = gram18 * 1333.2;
    const bubbleT = localKg - kgToman;
    assert.ok(Math.abs(detail.globalGoldKgUsd - kgUsd) < 1e-6);
    assert.ok(Math.abs(detail.globalGoldKgToman - kgToman) < 1);
    assert.ok(Math.abs(detail.goldBubbleTomanPerKg - bubbleT) < 1);
    assert.ok(Math.abs(detail.goldBubbleUsdPerKg - bubbleT / real) < 1e-6);
    assert.ok(Math.abs(detail.goldBubblePercent - (bubbleT / kgToman) * 100) < 1e-6);
    assert.ok(Math.abs(detail.equivalentGram18Bubble - bubbleT / gram18) < 1e-6);
  });

  await test("12. Positive / negative classification", () => {
    assert.equal(classifyBubble(2.5), "positive");
    assert.equal(classifyBubble(-1.2), "negative");
    assert.equal(classifyBubble(0.05), "near_zero");
    assert.equal(classifyBubble(null), null);
  });

  await test("13. Invalid data prevents calculation", () => {
    assert.equal(realDollarFromDirham(0), null);
    assert.equal(realDollarFromDirham(-1), null);
    assert.equal(computeDollarBubble(51_600, Number.NaN), null);
    assert.equal(computeGoldBubble(0, dirham, mazane), null);
    assert.equal(globalGoldKgToman(1, 0), null);
    assert.equal(goldBubbleTomanPerKg(1, 0), null);
    assert.equal(goldBubbleUsdPerKg(1, 0), null);
    assert.equal(goldBubblePercent(1, 0), null);
    assert.equal(equivalentGram18Bubble(1, 0), null);
  });

  await test("14. One failed provider does not block others", () => {
    const fx: FxStreetResponse = {
      quotes: [
        fxQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          assetType: "درهم امارات",
          buyPrice: 51_000,
          sellPrice: 51_200,
          midPrice: 51_100
        }),
        fxQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          assetType: "دلار کاغذی",
          buyPrice: 188_000,
          sellPrice: 189_000,
          midPrice: 188_500
        })
        // bonbast missing entirely
      ],
      sourceStatus: "degraded",
      lastUpdated: new Date().toISOString()
    };
    const gold: GoldMarketResponse = {
      quotes: [
        goldQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          instrument: "اونس طلا به دلار",
          unit: "usd_oz",
          midPrice: 4036
        }),
        goldQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          instrument: "مثقال طلای آبشده",
          unit: "toman",
          midPrice: mazane
        })
      ],
      sourceStatus: "available",
      lastUpdated: new Date().toISOString()
    };
    const res = buildMarketBubbleResponse(fx, gold);
    assert.ok(res.dollar.sources.find((s) => s.sourceId === "navasan")?.available);
    assert.equal(res.dollar.sources.find((s) => s.sourceId === "bonbast")?.available, false);
    assert.ok(res.dollar.summary);
    assert.ok(res.gold.summary);
  });

  await test("15. Rial/Toman conversion occurs only once in formulas", () => {
    // Formulas multiply Dirham Toman by 3.6725 once — no extra /10 or *10.
    const real = realDollarFromDirham(10_000)!;
    assert.equal(real, 10_000 * 3.6725);
    assert.notEqual(real, (10_000 / 10) * 3.6725);
    assert.notEqual(real, 10_000 * 10 * 3.6725);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
