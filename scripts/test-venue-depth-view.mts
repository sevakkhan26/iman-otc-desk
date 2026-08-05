#!/usr/bin/env npx tsx
/**
 * Per-venue market-depth card model — bid/ask direction, slippage depth,
 * usable capacity, and unavailable-vs-zero.
 */
import assert from "node:assert/strict";
import {
  bestAskToman,
  bestBidToman,
  buildVenueDepthCard
} from "../src/lib/shadowArbitrage/paper/venueDepthView.ts";
import { usdtToMicros } from "../src/lib/shadowArbitrage/paper/liquidity.ts";

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

const asks = [
  { priceToman: 200_000, amountUsdt: 50 },
  { priceToman: 200_200, amountUsdt: 50 }, // 10 bps worse
  { priceToman: 202_000, amountUsdt: 100 } // 100 bps worse
];
const bids = [
  { priceToman: 199_800, amountUsdt: 40 },
  { priceToman: 199_600, amountUsdt: 40 },
  { priceToman: 198_000, amountUsdt: 100 }
];

await test("best ask is the lowest ask; best bid is the highest bid", () => {
  assert.equal(bestAskToman(asks), 200_000);
  assert.equal(bestBidToman(bids), 199_800);
});

await test("raw depth respects the slippage window and does not use balance as depth", () => {
  const card = buildVenueDepthCard({
    sourceId: "nobitex",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    irtToman: 50_000_000_000, // huge balance — must not become "depth"
    usdtMicros: usdtToMicros(100_000),
    feeBps: 25,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: usdtToMicros(500),
    policyExposureMicros: null,
    maxSlippageBps: 15, // only first two ask levels (0 and 10 bps)
    markPriceToman: 200_000,
    asOf: "2026-08-05T12:00:00.000Z",
    smartRecommendedUsdt: 25
  });
  assert.equal(card.buy.bestPriceToman, 200_000);
  assert.equal(card.buy.levelsAccepted, 2);
  assert.equal(card.buy.levelsExcluded, 1);
  assert.ok(card.buy.rawDepthUsdt !== null && card.buy.rawDepthUsdt === 100);
  // Balance is huge; depth stays book depth, not balance.
  assert.ok((card.buy.rawDepthUsdt as number) < 1000);
  assert.equal(card.buy.unavailable, false);
});

await test("usable capacity is policy-adjusted and can be below raw depth", () => {
  const card = buildVenueDepthCard({
    sourceId: "wallex",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    irtToman: 50_000_000_000,
    usdtMicros: usdtToMicros(100_000),
    feeBps: 25,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: usdtToMicros(40), // tight order size
    policyExposureMicros: null,
    maxSlippageBps: 200,
    markPriceToman: 200_000,
    asOf: "2026-08-05T12:00:00.000Z"
  });
  assert.ok(card.buy.usableCapacityUsdt !== null);
  assert.ok((card.buy.usableCapacityUsdt as number) <= 40 + 1e-9);
  assert.equal(card.buy.limitingKey, "policy_order_size");
  assert.ok(card.buy.rawDepthUsdt !== null && (card.buy.rawDepthUsdt as number) > 40);
});

await test("missing book is unavailable, not zero depth", () => {
  const card = buildVenueDepthCard({
    sourceId: "bit24",
    marketModel: "ORDER_BOOK",
    bookBids: null,
    bookAsks: null,
    irtToman: 1_000_000,
    usdtMicros: usdtToMicros(10),
    feeBps: 30,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: usdtToMicros(500),
    policyExposureMicros: null,
    maxSlippageBps: 10,
    markPriceToman: 200_000,
    sourceFailureFa: "HTTP 503",
    asOf: "2026-08-05T12:00:00.000Z"
  });
  assert.equal(card.buy.unavailable, true);
  assert.equal(card.buy.rawDepthUsdt, null);
  assert.equal(card.buy.usableCapacityUsdt, null);
  assert.ok(card.buy.unavailableFa && /دفتر|ثبت|503/i.test(card.buy.unavailableFa));
});

await test("OTC quote has no multi-level book depth; quote capacity only", () => {
  const card = buildVenueDepthCard({
    sourceId: "abantether",
    marketModel: "OTC_QUOTE",
    bookBids: null,
    bookAsks: null,
    irtToman: 10_000_000_000,
    usdtMicros: usdtToMicros(5_000),
    feeBps: 20,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: usdtToMicros(500),
    policyExposureMicros: null,
    maxSlippageBps: 10,
    markPriceToman: 200_000,
    quote: {
      userBuyPriceToman: 201_000,
      userSellPriceToman: 199_000,
      maxExecutableUsdt: 100,
      ageMs: 1200,
      stale: false,
      maxQuoteAgeMs: 30_000
    },
    asOf: "2026-08-05T12:00:00.000Z"
  });
  assert.equal(card.marketModel, "OTC_QUOTE");
  assert.equal(card.buy.levelsAccepted, null);
  assert.equal(card.buy.bestPriceToman, 201_000);
  assert.equal(card.buy.rawDepthUsdt, 100);
  assert.ok(
    card.buy.unavailableFa === null ||
      /نقل‌قول|دفتر/.test(card.buy.unavailableFa ?? "") ||
      card.buy.rawDepthUsdt === 100
  );
});

await test("sell side uses bids; buy side uses asks", () => {
  const card = buildVenueDepthCard({
    sourceId: "tabdeal",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    irtToman: 1_000_000_000,
    usdtMicros: usdtToMicros(1_000),
    feeBps: 25,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: usdtToMicros(500),
    policyExposureMicros: null,
    maxSlippageBps: 50,
    markPriceToman: 200_000,
    asOf: "2026-08-05T12:00:00.000Z",
    smartRecommendedUsdt: 20
  });
  assert.equal(card.buy.bestPriceToman, 200_000);
  assert.equal(card.sell.bestPriceToman, 199_800);
  assert.ok(card.buy.smartSizeVwapToman !== null);
  assert.ok(card.sell.smartSizeVwapToman !== null);
  // Buy VWAP must be >= best ask; sell VWAP <= best bid
  assert.ok((card.buy.smartSizeVwapToman as number) >= 200_000);
  assert.ok((card.sell.smartSizeVwapToman as number) <= 199_800);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
