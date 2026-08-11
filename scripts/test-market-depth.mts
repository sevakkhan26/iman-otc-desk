#!/usr/bin/env npx tsx
/**
 * v4.2.4 — visible received order-book Bid/Ask volume proofs.
 * Not slippage-bounded; independent of capital/caps/policies.
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  buildMarketDepthCard,
  computeVisibleBookVolumeSide,
  recomputeDepthTotals,
  QUOTE_ONLY_FA
} from "../src/lib/shadowArbitrage/paper/marketDepth.ts";
import { buildVenueDepthCard } from "../src/lib/shadowArbitrage/paper/venueDepthView.ts";
import { usdtToMicros } from "../src/lib/shadowArbitrage/paper/liquidity.ts";
import { slippageBoundedDepth } from "../src/lib/shadowArbitrage/paper/smartCandidates.ts";

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
  { priceToman: 200_200, amountUsdt: 50 }, // 10 bps
  { priceToman: 202_000, amountUsdt: 100 } // 100 bps — outside typical 15 bps window
];
const bids = [
  { priceToman: 199_800, amountUsdt: 40 },
  { priceToman: 199_600, amountUsdt: 40 },
  { priceToman: 198_000, amountUsdt: 100 }
];

await test("1. totals exactly match all received Bid/Ask levels", () => {
  const card = buildMarketDepthCard({
    sourceId: "nobitex",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "t"
  });
  assert.equal(card.ask.depthUsdt, 50 + 50 + 100);
  assert.equal(card.bid.depthUsdt, 40 + 40 + 100);
  assert.equal(card.ask.levelsAccepted, 3);
  assert.equal(card.bid.levelsAccepted, 3);
  assert.equal(card.ask.levelsExcluded, 0);
  const re = recomputeDepthTotals(card.ask.acceptedLevels);
  assert.equal(re.depthUsdt, card.ask.depthUsdt);
  assert.equal(re.depthToman, card.ask.depthToman);
});

await test("2. levels outside the slippage window are still included", () => {
  const visible = buildMarketDepthCard({
    sourceId: "a",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "t"
  });
  // Engine still excludes far levels
  const engineAsk = slippageBoundedDepth(asks, "buy", 15);
  assert.equal(engineAsk.levelsIncluded, 2);
  assert.ok(engineAsk.levelsExcluded >= 1);
  // UI visible volume includes all 3
  assert.equal(visible.ask.levelsAccepted, 3);
  assert.equal(visible.ask.depthUsdt, 200);
  assert.ok((visible.ask.depthUsdt as number) > engineAsk.depthMicros / 1e6);
});

await test("3. toman totals use Σ(price × quantity)", () => {
  const ask = computeVisibleBookVolumeSide(asks, "buy");
  const expected = 200_000 * 50 + 200_200 * 50 + 202_000 * 100;
  assert.equal(ask.depthToman, expected);
  assert.notEqual(ask.depthToman, (ask.depthUsdt as number) * 200_000);
});

await test("4. capital / balances / caps / slippage do not affect displayed totals", () => {
  const mk = (opts: {
    capital: number;
    irt: number;
    usdt: number;
    orderCap: number;
    slip: number;
  }) =>
    buildVenueDepthCard({
      sourceId: "wallex",
      marketModel: "ORDER_BOOK",
      bookBids: bids,
      bookAsks: asks,
      irtToman: opts.irt,
      usdtMicros: usdtToMicros(opts.usdt),
      feeBps: 25,
      buyFeeAsset: "IRT",
      sellFeeAsset: "USDT",
      capitalShareToman: opts.capital,
      policyOrderSizeMicros: usdtToMicros(opts.orderCap),
      policyExposureMicros: null,
      maxSlippageBps: opts.slip,
      markPriceToman: 200_000,
      asOf: "t"
    });
  const a = mk({ capital: 100_000_000, irt: 1e6, usdt: 1, orderCap: 5, slip: 5 });
  const b = mk({ capital: 10e9, irt: 50e9, usdt: 1e5, orderCap: 5e4, slip: 500 });
  assert.equal(a.buy.rawDepthUsdt, b.buy.rawDepthUsdt);
  assert.equal(a.sell.rawDepthUsdt, b.sell.rawDepthUsdt);
  assert.equal(a.buy.rawDepthToman, b.buy.rawDepthToman);
  assert.equal(a.sell.rawDepthToman, b.sell.rawDepthToman);
  assert.equal(a.buy.levelsAccepted, 3);
  // usable capacity may differ
  assert.notEqual(a.buy.usableCapacityUsdt, b.buy.usableCapacityUsdt);
});

await test("5. different books produce different venue totals", () => {
  const a = buildMarketDepthCard({
    sourceId: "ex1",
    marketModel: "ORDER_BOOK",
    bookBids: [{ priceToman: 100, amountUsdt: 1 }],
    bookAsks: [{ priceToman: 101, amountUsdt: 2 }],
    asOf: "t"
  });
  const b = buildMarketDepthCard({
    sourceId: "ex2",
    marketModel: "ORDER_BOOK",
    bookBids: [{ priceToman: 100, amountUsdt: 9 }],
    bookAsks: [{ priceToman: 101, amountUsdt: 8 }],
    asOf: "t"
  });
  assert.notEqual(a.ask.depthUsdt, b.ask.depthUsdt);
  assert.notEqual(a.bid.depthUsdt, b.bid.depthUsdt);
});

await test("6. Bid-only / Ask-only changes affect only the matching side", () => {
  const base = buildMarketDepthCard({
    sourceId: "x",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    asOf: "t"
  });
  const bidOnly = buildMarketDepthCard({
    sourceId: "x",
    marketModel: "ORDER_BOOK",
    bookBids: [{ priceToman: 199_800, amountUsdt: 1 }],
    bookAsks: asks,
    asOf: "t"
  });
  const askOnly = buildMarketDepthCard({
    sourceId: "x",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: [{ priceToman: 200_000, amountUsdt: 1 }],
    asOf: "t"
  });
  assert.equal(base.ask.depthUsdt, bidOnly.ask.depthUsdt);
  assert.notEqual(base.bid.depthUsdt, bidOnly.bid.depthUsdt);
  assert.equal(base.bid.depthUsdt, askOnly.bid.depthUsdt);
  assert.notEqual(base.ask.depthUsdt, askOnly.ask.depthUsdt);
});

await test("7. repeated calculation is deterministic", () => {
  const input = {
    sourceId: "d",
    marketModel: "ORDER_BOOK" as const,
    bookBids: bids,
    bookAsks: asks,
    asOf: "2026-08-11T12:00:00.000Z"
  };
  assert.deepEqual(buildMarketDepthCard(input), buildMarketDepthCard(input));
});

await test("8. stale/missing/bad books fail closed", () => {
  const stale = buildMarketDepthCard({
    sourceId: "s",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    stale: true,
    asOf: "t"
  });
  assert.equal(stale.bid.unavailable, true);
  assert.equal(stale.ask.depthUsdt, null);

  const missing = buildMarketDepthCard({
    sourceId: "m",
    marketModel: "ORDER_BOOK",
    bookBids: null,
    bookAsks: null,
    asOf: "t"
  });
  assert.equal(missing.bid.unavailable, true);

  const crossed = buildMarketDepthCard({
    sourceId: "c",
    marketModel: "ORDER_BOOK",
    bookBids: [{ priceToman: 210_000, amountUsdt: 10 }],
    bookAsks: [{ priceToman: 200_000, amountUsdt: 10 }],
    asOf: "t"
  });
  assert.equal(crossed.bookCrossed, true);
  assert.equal(crossed.ask.depthUsdt, null);

  const bad = computeVisibleBookVolumeSide(
    [{ priceToman: NaN, amountUsdt: 1 }],
    "buy"
  );
  assert.equal(bad.unavailable, true);
});

await test("9. quote-only venues never receive fabricated depth", () => {
  const card = buildMarketDepthCard({
    sourceId: "abantether",
    marketModel: "OTC_QUOTE",
    bookBids: null,
    bookAsks: null,
    asOf: "t"
  });
  assert.equal(card.bid.unavailable, true);
  assert.equal(card.ask.depthUsdt, null);
  assert.equal(card.bid.unavailableFa, QUOTE_ONLY_FA);
  assert.equal(card.ask.acceptedLevels.length, 0);

  const venue = buildVenueDepthCard({
    sourceId: "abantether",
    marketModel: "OTC_QUOTE",
    bookBids: null,
    bookAsks: null,
    irtToman: 1e10,
    usdtMicros: usdtToMicros(5000),
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
      ageMs: 1000,
      stale: false,
      maxQuoteAgeMs: 30_000
    },
    asOf: "t"
  });
  assert.equal(venue.buy.rawDepthUsdt, null);
  assert.equal(venue.buy.unavailable, true);
  assert.ok(venue.buy.unavailableFa?.includes("چندسطحی"));
});

await test("10. API shape maps Bid/Ask to rawDepth and UI labels", () => {
  const card = buildVenueDepthCard({
    sourceId: "tabdeal",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    irtToman: 1e9,
    usdtMicros: usdtToMicros(1000),
    feeBps: 25,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: usdtToMicros(30),
    policyExposureMicros: null,
    maxSlippageBps: 15,
    markPriceToman: 200_000,
    asOf: "t",
    snapshotAgeMs: 2500
  });
  const pure = buildMarketDepthCard({
    sourceId: "tabdeal",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    asOf: "t"
  });
  // buy = Ask, sell = Bid
  assert.equal(card.buy.rawDepthUsdt, pure.ask.depthUsdt);
  assert.equal(card.sell.rawDepthUsdt, pure.bid.depthUsdt);
  assert.equal(card.buy.rawDepthToman, pure.ask.depthToman);
  assert.equal(card.buy.levelsAccepted, 3);
  assert.equal(card.snapshotAgeMs, 2500);

  const ui = readFileSync(
    new URL("../src/components/shadowArbitrage/VenuesSection.tsx", import.meta.url),
    "utf8"
  );
  assert.ok(ui.includes("حجم قابل‌مشاهده در دفتر سفارش دریافتی"));
  assert.ok(ui.includes("حجم خرید (Bid)"));
  assert.ok(ui.includes("حجم فروش (Ask)"));
  assert.ok(ui.includes("rawDepthUsdt"));
  assert.equal(ui.includes("usableCapacityUsdt"), false);
  assert.ok(ui.includes("levelsAccepted") || ui.includes("سطح"));
  assert.ok(ui.includes("سن اسنپ‌شات") || ui.includes("snapshotAgeMs"));
});

await test("engine slippageBoundedDepth is unchanged by this release", () => {
  const bounded = slippageBoundedDepth(asks, "buy", 15);
  assert.equal(bounded.levelsIncluded, 2);
  assert.equal(bounded.levelsExcluded, 1);
});

// Evidence reconciliation sample
const evidenceOut = path.join(process.cwd(), "evidence", "v424-visible-volume");
mkdirSync(evidenceOut, { recursive: true });
const samples = [
  { id: "nobitex", bids, asks },
  {
    id: "wallex",
    bids: [
      { priceToman: 99_900, amountUsdt: 10 },
      { priceToman: 99_000, amountUsdt: 90 }
    ],
    asks: [
      { priceToman: 100_000, amountUsdt: 80 },
      { priceToman: 101_000, amountUsdt: 20 }
    ]
  }
].map(({ id, bids: b, asks: a }) => {
  const card = buildMarketDepthCard({
    sourceId: id,
    marketModel: "ORDER_BOOK",
    bookBids: b,
    bookAsks: a,
    maxSlippageBps: 10,
    asOf: "2026-08-11T12:00:00.000Z",
    snapshotAgeMs: 900
  });
  const reAsk = recomputeDepthTotals(card.ask.acceptedLevels);
  const reBid = recomputeDepthTotals(card.bid.acceptedLevels);
  const slipAsk = slippageBoundedDepth(a, "buy", 10);
  return {
    sourceId: id,
    asOf: card.asOf,
    snapshotAgeMs: card.snapshotAgeMs,
    label: "حجم قابل‌مشاهده در دفتر سفارش دریافتی",
    bid: {
      levels: card.bid.acceptedLevels,
      depthUsdt: card.bid.depthUsdt,
      depthToman: card.bid.depthToman,
      levelCount: card.bid.levelsAccepted,
      recomputed: reBid,
      match: reBid.depthUsdt === card.bid.depthUsdt && reBid.depthToman === card.bid.depthToman
    },
    ask: {
      levels: card.ask.acceptedLevels,
      depthUsdt: card.ask.depthUsdt,
      depthToman: card.ask.depthToman,
      levelCount: card.ask.levelsAccepted,
      recomputed: reAsk,
      match: reAsk.depthUsdt === card.ask.depthUsdt && reAsk.depthToman === card.ask.depthToman
    },
    engineSlippageAskLevelsIncluded: slipAsk.levelsIncluded,
    visibleIncludesFarLevels: (card.ask.levelsAccepted ?? 0) >= slipAsk.levelsIncluded
  };
});
writeFileSync(path.join(evidenceOut, "volume-evidence.json"), JSON.stringify(samples, null, 2));
console.log(`  evidence → ${evidenceOut}/volume-evidence.json`);

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
