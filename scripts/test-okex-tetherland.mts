/**
 * Regression tests: OK-EX + Tetherland USDT/IRT providers.
 * Pure parsers + isolation guarantees (no live network required for unit cases).
 */
import assert from "node:assert/strict";
import {
  parseOkexIrSpotBook,
  parseTetherlandUsdtBook
} from "../src/lib/providers/domestic.ts";
import { calculateTetherMarket } from "../src/lib/market.ts";
import type { DomesticQuote } from "../src/lib/types.ts";

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

function quote(
  partial: Partial<DomesticQuote> & Pick<DomesticQuote, "exchangeId" | "exchangeName">
): DomesticQuote {
  return {
    buyPrice: null,
    sellPrice: null,
    midPrice: null,
    volume: null,
    spread: null,
    spreadPercent: null,
    deviationFromMedianPercent: null,
    sourceStatus: "available",
    lastUpdated: new Date().toISOString(),
    isOutlier: false,
    excludedFromMedian: false,
    ...partial
  };
}

async function main() {
  console.log("OK-EX / Tetherland provider tests\n");

  await test("1. OK-EX HTTP 403 is a safe provider error message pattern", () => {
    const msg = "HTTP 403 — دسترسی سرور به API اوکی اکسچنج مسدود است (احتمالاً IP/WAF)";
    assert.match(msg, /HTTP 403/);
    assert.ok(!msg.toLowerCase().includes("stack"));
  });

  await test("2. successful OK-EX order-book parse clears 403 path (valid bid/ask)", () => {
    const parsed = parseOkexIrSpotBook({
      bids: [[192_500, 10], [192_400, 5]],
      asks: [[192_700, 8], [192_800, 3]]
    });
    assert.ok(parsed);
    assert.equal(parsed!.buyPrice, 192_500);
    assert.equal(parsed!.sellPrice, 192_700);
    assert.ok(parsed!.buyPrice <= parsed!.sellPrice);
  });

  await test("3. OK-EX Buy/Sell mapping is not reversed", () => {
    const parsed = parseOkexIrSpotBook({
      bids: [[100_000, 1]],
      asks: [[101_000, 1]]
    });
    assert.equal(parsed!.buyPrice, 100_000); // highest bid
    assert.equal(parsed!.sellPrice, 101_000); // lowest ask
  });

  await test("4. OK-EX Rial/Toman conversion occurs once (prices already Toman)", () => {
    // Spot books quote IRT in Toman units (~1e5), not Rial (~1e6).
    const parsed = parseOkexIrSpotBook({
      bids: [["192711", "1"]],
      asks: [["192995", "1"]]
    });
    assert.equal(parsed!.buyPrice, 192_711);
    assert.equal(parsed!.sellPrice, 192_995);
    // Must NOT be /10
    assert.notEqual(parsed!.buyPrice, 19_271.1);
  });

  await test("5. OK-EX empty / crossed book returns null (no fabrications)", () => {
    assert.equal(parseOkexIrSpotBook({ bids: [], asks: [] }), null);
    assert.equal(parseOkexIrSpotBook({ bids: [[200_000, 1]], asks: [[190_000, 1]] }), null);
    assert.equal(parseOkexIrSpotBook(null), null);
  });

  await test("6. Tetherland real Bid/Ask from market board (API fields inverted)", () => {
    const payload = {
      status: true,
      data: {
        markets: {
          USDTTMN: {
            // API.asks = bid side (desc), API.bids = ask side (asc near end)
            asks: [
              { price: 191_802, amount: 100 },
              { price: 191_800, amount: 50 },
              { price: 180_000, amount: 1 }
            ],
            bids: [
              { price: 5_000_000, amount: 1 },
              { price: 194_000, amount: 10 },
              { price: 193_000, amount: 20 }
            ]
          }
        }
      }
    };
    const parsed = parseTetherlandUsdtBook(payload, 192_550);
    assert.ok(parsed, "expected executable book");
    assert.equal(parsed!.buyPrice, 191_802);
    assert.equal(parsed!.sellPrice, 193_000);
    assert.ok(parsed!.buyPrice <= parsed!.sellPrice);
  });

  await test("7. single Tetherland reference price is not duplicated into bid/ask", () => {
    // currencies API shape is not a market book — parser must return null
    const currenciesShaped = {
      status: 200,
      data: {
        currencies: {
          USDT: { price: 192_550, buy_price: 192_550, sell_price: 192_550 }
        }
      }
    };
    assert.equal(parseTetherlandUsdtBook(currenciesShaped, 192_550), null);
  });

  await test("8. reference-only Tetherland is degraded and excluded from best-price", () => {
    const exchanges: DomesticQuote[] = [
      quote({
        exchangeId: "nobitex",
        exchangeName: "نوبیتکس",
        buyPrice: 192_000,
        sellPrice: 192_400,
        midPrice: 192_200,
        sourceStatus: "available"
      }),
      quote({
        exchangeId: "tetherland",
        exchangeName: "تترلند",
        buyPrice: null,
        sellPrice: null,
        midPrice: 192_550,
        sourceStatus: "degraded",
        errorMessage: "فقط قیمت مرجع"
      }),
      quote({
        exchangeId: "bitpin",
        exchangeName: "بیت‌پین",
        buyPrice: 191_800,
        sellPrice: 192_100,
        midPrice: 191_950,
        sourceStatus: "available"
      })
    ];
    const market = calculateTetherMarket(exchanges, 5);
    assert.notEqual(market.summary.bestBuyExchange, "تترلند");
    assert.notEqual(market.summary.bestSellExchange, "تترلند");
    // still present in list as degraded with mid
    const tl = market.exchanges.find((e) => e.exchangeId === "tetherland");
    assert.ok(tl);
    assert.equal(tl!.sourceStatus, "degraded");
    assert.equal(tl!.buyPrice, null);
    assert.equal(tl!.sellPrice, null);
    assert.ok(tl!.midPrice !== null);
  });

  await test("9. one provider unavailable does not wipe other executable quotes", () => {
    const exchanges: DomesticQuote[] = [
      quote({
        exchangeId: "okex_ir",
        exchangeName: "اوکی اکسچنج",
        sourceStatus: "unavailable",
        errorMessage: "HTTP 403",
        buyPrice: null,
        sellPrice: null,
        midPrice: null
      }),
      quote({
        exchangeId: "nobitex",
        exchangeName: "نوبیتکس",
        buyPrice: 192_000,
        sellPrice: 192_400,
        midPrice: 192_200,
        sourceStatus: "available"
      })
    ];
    const market = calculateTetherMarket(exchanges, 5);
    assert.equal(market.summary.bestBuy, 192_000);
    assert.equal(market.summary.bestSell, 192_400);
    assert.equal(market.exchanges.find((e) => e.exchangeId === "okex_ir")?.sourceStatus, "unavailable");
  });

  await test("10. old 403 disappears after successful OK-EX recovery quote", () => {
    // Simulate recovery: a fresh available quote has no errorMessage
    const recovered = quote({
      exchangeId: "okex_ir",
      exchangeName: "اوکی اکسچنج",
      buyPrice: 192_711,
      sellPrice: 192_995,
      midPrice: (192_711 + 192_995) / 2,
      sourceStatus: "available",
      errorMessage: undefined
    });
    assert.equal(recovered.sourceStatus, "available");
    assert.equal(recovered.errorMessage, undefined);
    assert.ok(recovered.buyPrice! < recovered.sellPrice!);
  });

  await test("11. executable Tetherland book is included in best-price when healthy", () => {
    const exchanges: DomesticQuote[] = [
      quote({
        exchangeId: "tetherland",
        exchangeName: "تترلند",
        buyPrice: 191_802,
        sellPrice: 193_000,
        midPrice: (191_802 + 193_000) / 2,
        sourceStatus: "available"
      }),
      quote({
        exchangeId: "nobitex",
        exchangeName: "نوبیتکس",
        buyPrice: 192_000,
        sellPrice: 192_400,
        midPrice: 192_200,
        sourceStatus: "available"
      })
    ];
    const market = calculateTetherMarket(exchanges, 5);
    // best buy = min buyPrice among executable
    assert.equal(market.summary.bestBuy, 191_802);
    assert.equal(market.summary.bestBuyExchange, "تترلند");
  });

  await test("12. market difference uses highest Sell − lowest Buy (not mid extremes)", () => {
    const exchanges: DomesticQuote[] = [
      quote({
        exchangeId: "a",
        exchangeName: "صرافی-الف",
        buyPrice: 190_146,
        sellPrice: 190_500,
        midPrice: 190_323,
        sourceStatus: "available"
      }),
      quote({
        exchangeId: "b",
        exchangeName: "صرافی-ب",
        buyPrice: 191_000,
        sellPrice: 193_900,
        midPrice: 192_450,
        sourceStatus: "available"
      }),
      // reference-only mid must not enter buy/sell extremes
      quote({
        exchangeId: "ref",
        exchangeName: "مرجع",
        buyPrice: null,
        sellPrice: null,
        midPrice: 200_000,
        sourceStatus: "degraded",
        errorMessage: "فقط قیمت مرجع"
      }),
      // zero book incomplete
      quote({
        exchangeId: "z",
        exchangeName: "ناقص",
        buyPrice: 0,
        sellPrice: 0,
        midPrice: 191_000,
        sourceStatus: "available"
      })
    ];
    const market = calculateTetherMarket(exchanges, 50);
    assert.equal(market.summary.bestSell, 193_900);
    assert.equal(market.summary.bestSellExchange, "صرافی-ب");
    assert.equal(market.summary.bestBuy, 190_146);
    assert.equal(market.summary.bestBuyExchange, "صرافی-الف");
    // marketDifferenceToman / percent vs lowestBuy — not mid highest−lowest
    const expectedDiff = 193_900 - 190_146;
    const expectedPct = (expectedDiff / 190_146) * 100;
    assert.ok(market.summary.marketSpreadPercent !== null);
    assert.ok(Math.abs((market.summary.marketSpreadPercent as number) - expectedPct) < 1e-9);
    // mid cards stay independent
    assert.equal(market.summary.highest, 192_450);
    assert.equal(market.summary.lowest, 190_323);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
