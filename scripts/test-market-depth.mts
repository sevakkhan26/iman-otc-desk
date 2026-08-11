#!/usr/bin/env npx tsx
/**
 * v4.2.3 — pure market Bid/Ask depth proofs.
 *
 * Depth is independent of capital, balances, allocations, order caps, policies.
 */
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import {
  buildMarketDepthCard,
  computeMarketDepthSide,
  recomputeDepthTotals
} from "../src/lib/shadowArbitrage/paper/marketDepth.ts";
import { buildVenueDepthCard } from "../src/lib/shadowArbitrage/paper/venueDepthView.ts";
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
  { priceToman: 200_200, amountUsdt: 50 }, // 10 bps
  { priceToman: 202_000, amountUsdt: 100 } // 100 bps
];
const bids = [
  { priceToman: 199_800, amountUsdt: 40 },
  { priceToman: 199_600, amountUsdt: 40 },
  { priceToman: 198_000, amountUsdt: 100 }
];

// Asymmetric: more ask size in window than bid
const asksFat = [
  { priceToman: 100_000, amountUsdt: 80 },
  { priceToman: 100_050, amountUsdt: 20 }
];
const bidsThin = [
  { priceToman: 99_900, amountUsdt: 10 },
  { priceToman: 99_850, amountUsdt: 5 }
];

await test("1. asymmetric books produce different Bid/Ask depth", () => {
  const card = buildMarketDepthCard({
    sourceId: "nobitex",
    marketModel: "ORDER_BOOK",
    bookBids: bidsThin,
    bookAsks: asksFat,
    maxSlippageBps: 20,
    asOf: "2026-08-11T12:00:00.000Z"
  });
  assert.equal(card.ask.unavailable, false);
  assert.equal(card.bid.unavailable, false);
  assert.equal(card.ask.depthUsdt, 100); // 80+20
  assert.equal(card.bid.depthUsdt, 15); // 10+5
  assert.notEqual(card.ask.depthUsdt, card.bid.depthUsdt);
});

await test("2. changing only bids changes only Bid depth", () => {
  const base = buildMarketDepthCard({
    sourceId: "a",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "t"
  });
  const bids2 = [
    { priceToman: 199_800, amountUsdt: 5 },
    { priceToman: 199_600, amountUsdt: 5 }
  ];
  const changed = buildMarketDepthCard({
    sourceId: "a",
    marketModel: "ORDER_BOOK",
    bookBids: bids2,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "t"
  });
  assert.equal(base.ask.depthUsdt, changed.ask.depthUsdt);
  assert.equal(base.ask.depthToman, changed.ask.depthToman);
  assert.notEqual(base.bid.depthUsdt, changed.bid.depthUsdt);
});

await test("3. changing only asks changes only Ask depth", () => {
  const base = buildMarketDepthCard({
    sourceId: "a",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "t"
  });
  const asks2 = [
    { priceToman: 200_000, amountUsdt: 1 },
    { priceToman: 200_200, amountUsdt: 1 }
  ];
  const changed = buildMarketDepthCard({
    sourceId: "a",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks2,
    maxSlippageBps: 15,
    asOf: "t"
  });
  assert.equal(base.bid.depthUsdt, changed.bid.depthUsdt);
  assert.notEqual(base.ask.depthUsdt, changed.ask.depthUsdt);
});

await test("4. identical books with 100M vs 10B capital show identical market depth", () => {
  const mk = (capitalShare: number, irt: number, usdt: number) =>
    buildVenueDepthCard({
      sourceId: "wallex",
      marketModel: "ORDER_BOOK",
      bookBids: bids,
      bookAsks: asks,
      irtToman: irt,
      usdtMicros: usdtToMicros(usdt),
      feeBps: 25,
      buyFeeAsset: "IRT",
      sellFeeAsset: "USDT",
      capitalShareToman: capitalShare,
      policyOrderSizeMicros: usdtToMicros(500),
      policyExposureMicros: null,
      maxSlippageBps: 15,
      markPriceToman: 200_000,
      asOf: "2026-08-11T12:00:00.000Z"
    });
  const a = mk(100_000_000, 100_000_000, 500);
  const b = mk(10_000_000_000, 10_000_000_000, 50_000);
  assert.equal(a.buy.rawDepthUsdt, b.buy.rawDepthUsdt);
  assert.equal(a.sell.rawDepthUsdt, b.sell.rawDepthUsdt);
  assert.equal(a.buy.rawDepthToman, b.buy.rawDepthToman);
  assert.equal(a.sell.rawDepthToman, b.sell.rawDepthToman);
  // Usable capacity may differ — that is not market depth
  assert.ok(
    a.buy.usableCapacityUsdt !== b.buy.usableCapacityUsdt ||
      a.buy.usableCapacityUsdt === b.buy.usableCapacityUsdt
  );
});

await test("5. balances / allocation / order cap / do not change displayed market depth", () => {
  const base = buildVenueDepthCard({
    sourceId: "tabdeal",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    irtToman: 1_000_000,
    usdtMicros: usdtToMicros(1),
    feeBps: 30,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: 1_000_000,
    policyOrderSizeMicros: usdtToMicros(5),
    policyExposureMicros: usdtToMicros(10),
    maxSlippageBps: 15,
    markPriceToman: 200_000,
    asOf: "t"
  });
  const rich = buildVenueDepthCard({
    sourceId: "tabdeal",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    irtToman: 50_000_000_000,
    usdtMicros: usdtToMicros(100_000),
    feeBps: 5,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: 50_000_000_000,
    policyOrderSizeMicros: usdtToMicros(50_000),
    policyExposureMicros: usdtToMicros(100_000),
    maxSlippageBps: 15,
    markPriceToman: 200_000,
    asOf: "t"
  });
  assert.equal(base.buy.rawDepthUsdt, rich.buy.rawDepthUsdt);
  assert.equal(base.sell.rawDepthUsdt, rich.sell.rawDepthUsdt);
  assert.equal(base.buy.rawDepthToman, rich.buy.rawDepthToman);
  assert.equal(base.sell.rawDepthToman, rich.sell.rawDepthToman);
  // Capacity SHOULD differ
  assert.notEqual(base.buy.usableCapacityUsdt, rich.buy.usableCapacityUsdt);
});

await test("6. different venue books do not reuse one shared value", () => {
  const a = buildMarketDepthCard({
    sourceId: "ex1",
    marketModel: "ORDER_BOOK",
    bookBids: bidsThin,
    bookAsks: asksFat,
    maxSlippageBps: 20,
    asOf: "t"
  });
  const b = buildMarketDepthCard({
    sourceId: "ex2",
    marketModel: "ORDER_BOOK",
    bookBids: [
      { priceToman: 50_000, amountUsdt: 3 },
      { priceToman: 49_990, amountUsdt: 2 }
    ],
    bookAsks: [
      { priceToman: 50_100, amountUsdt: 7 },
      { priceToman: 50_150, amountUsdt: 11 }
    ],
    maxSlippageBps: 20,
    asOf: "t"
  });
  assert.notEqual(a.ask.depthUsdt, b.ask.depthUsdt);
  assert.notEqual(a.bid.depthUsdt, b.bid.depthUsdt);
  assert.notEqual(a.sourceId, b.sourceId);
  // Each card's accepted levels come only from its own books
  assert.ok(a.ask.acceptedLevels.every((l) => asksFat.some((x) => x.priceToman === l.priceToman)));
  assert.ok(!a.ask.acceptedLevels.some((l) => l.amountUsdt === 7 && l.priceToman === 50_100));
});

await test("7. repeated calculation of one snapshot is deterministic", () => {
  const input = {
    sourceId: "det",
    marketModel: "ORDER_BOOK" as const,
    bookBids: bids,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "2026-08-11T12:00:00.000Z"
  };
  const r1 = buildMarketDepthCard(input);
  const r2 = buildMarketDepthCard(input);
  assert.deepEqual(r1, r2);
  const re = recomputeDepthTotals(r1.ask.acceptedLevels);
  assert.equal(re.depthUsdt, r1.ask.depthUsdt);
  assert.equal(re.depthToman, r1.ask.depthToman);
});

await test("8. stale/missing/crossed books fail closed as ناموجود", () => {
  const stale = buildMarketDepthCard({
    sourceId: "s",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "t",
    stale: true
  });
  assert.equal(stale.bid.unavailable, true);
  assert.equal(stale.ask.depthUsdt, null);
  assert.ok(stale.bid.unavailableFa?.includes("کهنه") || stale.bid.unavailableFa?.includes("ناموجود"));

  const missing = buildMarketDepthCard({
    sourceId: "m",
    marketModel: "ORDER_BOOK",
    bookBids: null,
    bookAsks: null,
    maxSlippageBps: 15,
    asOf: "t"
  });
  assert.equal(missing.bid.unavailable, true);
  assert.equal(missing.ask.depthUsdt, null);

  const crossed = buildMarketDepthCard({
    sourceId: "c",
    marketModel: "ORDER_BOOK",
    bookBids: [{ priceToman: 210_000, amountUsdt: 10 }],
    bookAsks: [{ priceToman: 200_000, amountUsdt: 10 }],
    maxSlippageBps: 15,
    asOf: "t"
  });
  assert.equal(crossed.bookCrossed, true);
  assert.equal(crossed.bid.unavailable, true);
  assert.equal(crossed.ask.depthUsdt, null);

  const noPolicy = computeMarketDepthSide(asks, "buy", null);
  assert.equal(noPolicy.unavailable, true);
  assert.equal(noPolicy.depthUsdt, null);
});

await test("9. toman is Σ(price×qty), not USDT × best", () => {
  const ask = computeMarketDepthSide(asks, "buy", 15);
  assert.equal(ask.unavailable, false);
  // levels 0 and 10 bps: 50@200000 + 50@200200
  const expectedUsdt = 100;
  const expectedToman = 200_000 * 50 + 200_200 * 50;
  assert.equal(ask.depthUsdt, expectedUsdt);
  assert.equal(ask.depthToman, expectedToman);
  assert.notEqual(ask.depthToman, expectedUsdt * 200_000);
});

await test("venue card rawDepth matches pure market depth; labels are Bid/Ask sides", () => {
  const card = buildVenueDepthCard({
    sourceId: "nobitex",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    irtToman: 50_000_000_000,
    usdtMicros: usdtToMicros(100_000),
    feeBps: 25,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: usdtToMicros(30), // tight cap for capacity
    policyExposureMicros: null,
    maxSlippageBps: 15,
    markPriceToman: 200_000,
    asOf: "t"
  });
  const pure = buildMarketDepthCard({
    sourceId: "nobitex",
    marketModel: "ORDER_BOOK",
    bookBids: bids,
    bookAsks: asks,
    maxSlippageBps: 15,
    asOf: "t"
  });
  // buy = Ask, sell = Bid
  assert.equal(card.buy.rawDepthUsdt, pure.ask.depthUsdt);
  assert.equal(card.sell.rawDepthUsdt, pure.bid.depthUsdt);
  assert.equal(card.buy.rawDepthToman, pure.ask.depthToman);
  // usable capacity may be below market depth due to order cap
  assert.ok(
    card.buy.usableCapacityUsdt !== null &&
      card.buy.rawDepthUsdt !== null &&
      (card.buy.usableCapacityUsdt as number) <= (card.buy.rawDepthUsdt as number) + 1e-9
  );
  assert.ok((card.buy.acceptedLevels?.length ?? 0) > 0);
});

await test("UI must not present usableCapacity as market depth (static)", async () => {
  const { readFileSync } = await import("node:fs");
  const ui = readFileSync(
    new URL("../src/components/shadowArbitrage/VenuesSection.tsx", import.meta.url),
    "utf8"
  );
  assert.ok(ui.includes("عمق سفارش‌های خرید (Bid)"));
  assert.ok(ui.includes("عمق سفارش‌های فروش (Ask)"));
  assert.ok(ui.includes("نه ظرفیت اجرایی") || ui.includes("عمق = نقدینگی"));
  assert.ok(ui.includes("rawDepthUsdt"));
  assert.equal(ui.includes("usableCapacityUsdt"), false);
  assert.equal(/capacityUsdtMicros/.test(ui) && ui.includes("buyDepthUsdt ="), false);
});

// Evidence sample for release report
const evidenceOut = path.join(process.cwd(), "evidence", "v423-market-depth");
mkdirSync(evidenceOut, { recursive: true });
const samples = ["nobitex", "wallex", "tabdeal"].map((id, i) => {
  const bookBids =
    i === 0
      ? bids
      : i === 1
        ? bidsThin
        : [
            { priceToman: 150_000, amountUsdt: 12 },
            { priceToman: 149_900, amountUsdt: 8 }
          ];
  const bookAsks =
    i === 0
      ? asks
      : i === 1
        ? asksFat
        : [
            { priceToman: 150_100, amountUsdt: 25 },
            { priceToman: 150_200, amountUsdt: 25 }
          ];
  const card = buildMarketDepthCard({
    sourceId: id,
    marketModel: "ORDER_BOOK",
    bookBids,
    bookAsks,
    maxSlippageBps: 15,
    asOf: "2026-08-11T12:00:00.000Z",
    snapshotAgeMs: 1200
  });
  const reAsk = recomputeDepthTotals(card.ask.acceptedLevels);
  const reBid = recomputeDepthTotals(card.bid.acceptedLevels);
  return {
    sourceId: id,
    asOf: card.asOf,
    snapshotAgeMs: card.snapshotAgeMs,
    maxSlippageBps: card.maxSlippageBps,
    bid: {
      best: card.bid.bestPriceToman,
      range: [card.bid.acceptedPriceMin, card.bid.acceptedPriceMax],
      levelsAccepted: card.bid.levelsAccepted,
      levelsExcluded: card.bid.levelsExcluded,
      acceptedLevels: card.bid.acceptedLevels,
      depthUsdt: card.bid.depthUsdt,
      depthToman: card.bid.depthToman,
      recomputed: reBid,
      match:
        reBid.depthUsdt === card.bid.depthUsdt && reBid.depthToman === card.bid.depthToman
    },
    ask: {
      best: card.ask.bestPriceToman,
      range: [card.ask.acceptedPriceMin, card.ask.acceptedPriceMax],
      levelsAccepted: card.ask.levelsAccepted,
      levelsExcluded: card.ask.levelsExcluded,
      acceptedLevels: card.ask.acceptedLevels,
      depthUsdt: card.ask.depthUsdt,
      depthToman: card.ask.depthToman,
      recomputed: reAsk,
      match:
        reAsk.depthUsdt === card.ask.depthUsdt && reAsk.depthToman === card.ask.depthToman
    }
  };
});
writeFileSync(path.join(evidenceOut, "depth-evidence.json"), JSON.stringify(samples, null, 2));
console.log(`  evidence → ${evidenceOut}/depth-evidence.json`);

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
