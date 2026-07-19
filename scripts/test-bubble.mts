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
import {
  areBubbleInputsAligned,
  BUBBLE_INPUT_ALIGN_MS,
  BUBBLE_INPUT_MAX_AGE_MS,
  buildMarketBubbleResponse,
  dollarBubbleSupportSentence,
  goldBubblePrimaryStatus,
  goldBubbleSupportSentence,
  isBubbleInputFresh,
  MSG_MISALIGNED_BUBBLE
} from "../src/lib/bubble/compute.ts";
import { classifyBubble as classifyBubbleDirect } from "../src/lib/bubble/formulas.ts";
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

  await test("5. Consolidated dollar uses arithmetic mean of valid sources", () => {
    const nowIso = new Date().toISOString();
    const fx: FxStreetResponse = {
      quotes: [
        fxQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          assetType: "درهم امارات",
          buyPrice: 50_000,
          sellPrice: 50_000,
          midPrice: 50_000,
          lastUpdated: nowIso
        }),
        fxQ({
          sourceId: "bonbast",
          sourceName: "بن‌بست",
          assetType: "درهم امارات",
          buyPrice: 52_000,
          sellPrice: 52_000,
          midPrice: 52_000,
          lastUpdated: nowIso
        }),
        fxQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          assetType: "دلار کاغذی",
          buyPrice: 190_000,
          sellPrice: 190_000,
          midPrice: 190_000,
          lastUpdated: nowIso
        }),
        fxQ({
          sourceId: "bonbast",
          sourceName: "بن‌بست",
          assetType: "دلار بن‌بست",
          buyPrice: 194_000,
          sellPrice: 194_000,
          midPrice: 194_000,
          lastUpdated: nowIso
        })
      ],
      sourceStatus: "available",
      lastUpdated: nowIso
    };
    const gold: GoldMarketResponse = { quotes: [], sourceStatus: "unavailable", lastUpdated: null };
    const res = buildMarketBubbleResponse(fx, gold);
    const c = res.dollar.consolidated!;
    assert.ok(c);
    assert.equal(c.averageDirhamToman, 51_000);
    assert.equal(c.averageMarketDollarToman, 192_000);
    assert.equal(c.calculatedDollarToman, 51_000 * 3.6725);
    assert.equal(c.dirhamSourceCount, 2);
    assert.equal(c.marketDollarSourceCount, 2);
    assert.equal(c.bubbleToman, 192_000 - 51_000 * 3.6725);
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
    // Only Navasan FX present → consolidated dollar still works from one source
    assert.ok(res.dollar.consolidated);
    assert.equal(res.dollar.consolidated!.dirhamSourceCount, 1);
    assert.equal(res.dollar.consolidated!.marketDollarSourceCount, 1);
    assert.ok(res.gold.consolidated);
  });

  await test("15. Rial/Toman conversion occurs only once in formulas", () => {
    // Formulas multiply Dirham Toman by 3.6725 once — no extra /10 or *10.
    const real = realDollarFromDirham(10_000)!;
    assert.equal(real, 10_000 * 3.6725);
    assert.notEqual(real, (10_000 / 10) * 3.6725);
    assert.notEqual(real, 10_000 * 10 * 3.6725);
  });

  const now = Date.now();
  const freshIso = new Date(now - 60_000).toISOString();
  /** Genuinely multi-hour old (beyond hard max age). */
  const staleIso = new Date(now - BUBBLE_INPUT_MAX_AGE_MS - 60_000).toISOString();
  /** Slight natural lag between instruments (must still calculate). */
  const slightlyOlderIso = new Date(now - 8 * 60_000).toISOString();

  function goldFixture(
    sourceId: string,
    sourceName: string,
    opts: {
      ounceAt?: string;
      mazaneAt?: string;
      dirhamAt?: string;
      ounce?: number;
      mazane?: number;
      dirham?: number;
    }
  ): { fx: FxStreetResponse; gold: GoldMarketResponse } {
    const ounceAt = opts.ounceAt ?? freshIso;
    const mazaneAt = opts.mazaneAt ?? freshIso;
    const dirhamAt = opts.dirhamAt ?? freshIso;
    return {
      fx: {
        quotes: [
          fxQ({
            sourceId,
            sourceName,
            assetType: "درهم امارات",
            buyPrice: opts.dirham ?? 53_000,
            sellPrice: opts.dirham ?? 53_200,
            midPrice: opts.dirham ?? 53_100,
            lastUpdated: dirhamAt
          }),
          fxQ({
            sourceId,
            sourceName,
            assetType: sourceId === "bonbast" ? "دلار بن‌بست" : "دلار کاغذی",
            buyPrice: 195_000,
            sellPrice: 196_000,
            midPrice: 195_500,
            lastUpdated: dirhamAt
          })
        ],
        sourceStatus: "available",
        lastUpdated: dirhamAt
      },
      gold: {
        quotes: [
          goldQ({
            sourceId: sourceId as "navasan" | "bonbast" | "talavest",
            sourceName,
            instrument: "اونس طلا به دلار",
            unit: "usd_oz",
            midPrice: opts.ounce ?? 4017.51,
            lastUpdated: ounceAt
          }),
          goldQ({
            sourceId: sourceId as "navasan" | "bonbast" | "talavest",
            sourceName,
            instrument: "مثقال طلای آبشده",
            unit: "toman",
            midPrice: opts.mazane ?? 82_150_000,
            lastUpdated: mazaneAt
          })
        ],
        sourceStatus: "available",
        lastUpdated: mazaneAt
      }
    };
  }

  await test("16. Consolidated gold with slightly-skewed fresh timestamps still calculates", () => {
    const { fx, gold } = goldFixture("navasan", "نوسان", {
      ounceAt: freshIso,
      mazaneAt: slightlyOlderIso,
      dirhamAt: freshIso
    });
    const res = buildMarketBubbleResponse(fx, gold);
    assert.ok(res.gold.consolidated);
    assert.equal(res.gold.consolidated!.ounceSourceCount, 1);
    assert.equal(res.gold.consolidated!.dirhamSourceCount, 1);
    assert.equal(res.gold.consolidated!.mazaneSourceCount, 1);
  });

  await test("17. Consolidated gold averages two sources arithmetically", () => {
    const nav = goldFixture("navasan", "نوسان", {
      dirham: 50_000,
      mazane: 80_000_000,
      ounce: 4000
    });
    const bon = goldFixture("bonbast", "بن‌بست", {
      dirham: 52_000,
      mazane: 82_000_000,
      ounce: 4020
    });
    const res = buildMarketBubbleResponse(
      {
        quotes: [...nav.fx.quotes, ...bon.fx.quotes],
        sourceStatus: "available",
        lastUpdated: freshIso
      },
      {
        quotes: [...nav.gold.quotes, ...bon.gold.quotes],
        sourceStatus: "available",
        lastUpdated: freshIso
      }
    );
    const c = res.gold.consolidated!;
    assert.ok(c);
    assert.equal(c.averageOunceUsd, 4010);
    assert.equal(c.averageDirhamToman, 51_000);
    assert.equal(c.averageMazaneToman, 81_000_000);
    assert.equal(c.ounceSourceCount, 2);
    assert.equal(c.dirhamSourceCount, 2);
    assert.equal(c.mazaneSourceCount, 2);
    // Formula fed by averages
    assert.equal(c.realDollarToman, 51_000 * 3.6725);
  });

  await test("18. Stale dirham alone excludes that source from average; still computes if others remain", () => {
    const nav = goldFixture("navasan", "نوسان", { dirham: 53_000, mazane: 82_000_000, ounce: 4010 });
    const bon = goldFixture("bonbast", "بن‌بست", {
      dirham: 52_000,
      mazane: 80_000_000,
      ounce: 4000,
      dirhamAt: staleIso
    });
    const res = buildMarketBubbleResponse(
      {
        quotes: [...nav.fx.quotes, ...bon.fx.quotes],
        sourceStatus: "degraded",
        lastUpdated: freshIso
      },
      {
        quotes: [...nav.gold.quotes, ...bon.gold.quotes],
        sourceStatus: "available",
        lastUpdated: freshIso
      }
    );
    const c = res.gold.consolidated!;
    assert.ok(c);
    // Bonbast dirham excluded; only navasan dirham in average
    assert.equal(c.dirhamSourceCount, 1);
    assert.equal(c.averageDirhamToman, 53_000);
    // Both gold sources still contribute ounce/mazane
    assert.equal(c.ounceSourceCount, 2);
  });

  await test("19. Stale mazaneh excludes that source mazane from average", () => {
    const { fx, gold } = goldFixture("navasan", "نوسان", { mazaneAt: staleIso });
    const res = buildMarketBubbleResponse(fx, gold);
    // Only one source and mazane stale → no mazane average → insufficient
    assert.equal(res.gold.consolidated, null);
    assert.equal(res.gold.unavailableReason, "داده معتبر کافی در دسترس نیست");
  });

  await test("20. Multi-hour skew on mean timestamps can disable consolidated gold", () => {
    const recent = new Date(now - 60_000).toISOString();
    const older = new Date(now - (BUBBLE_INPUT_ALIGN_MS + 10 * 60_000)).toISOString();
    const gate = areBubbleInputsAligned([recent, older, recent], now);
    assert.equal(gate.ok, false);
    assert.equal(gate.reason, "misaligned");

    const { fx, gold } = goldFixture("navasan", "نوسان", {
      ounceAt: recent,
      mazaneAt: older,
      dirhamAt: recent
    });
    const res = buildMarketBubbleResponse(fx, gold);
    assert.equal(res.gold.consolidated, null);
    assert.equal(res.gold.unavailableReason, MSG_MISALIGNED_BUBBLE);
  });

  await test("21. Dirham from FX only — gold without any fresh dirham fails safely", () => {
    const gold: GoldMarketResponse = {
      quotes: [
        goldQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          instrument: "اونس طلا به دلار",
          unit: "usd_oz",
          midPrice: 4017,
          lastUpdated: freshIso
        }),
        goldQ({
          sourceId: "navasan",
          sourceName: "نوسان",
          instrument: "مثقال طلای آبشده",
          unit: "toman",
          midPrice: 82_000_000,
          lastUpdated: freshIso
        })
      ],
      sourceStatus: "available",
      lastUpdated: freshIso
    };
    const res = buildMarketBubbleResponse(
      { quotes: [], sourceStatus: "unavailable", lastUpdated: null },
      gold
    );
    assert.equal(res.gold.consolidated, null);
    assert.equal(res.gold.unavailableReason, "داده معتبر کافی در دسترس نیست");
  });

  await test("22. isBubbleInputFresh: null ts allowed; multi-hour stale rejected; resume", () => {
    assert.equal(isBubbleInputFresh(freshIso, now), true);
    assert.equal(isBubbleInputFresh(null, now), true);
    assert.equal(isBubbleInputFresh(staleIso, now), false);

    const staleRes = buildMarketBubbleResponse(
      goldFixture("navasan", "نوسان", { dirhamAt: staleIso }).fx,
      goldFixture("navasan", "نوسان", { dirhamAt: staleIso }).gold
    );
    assert.equal(staleRes.gold.consolidated, null);

    const freshRes = buildMarketBubbleResponse(
      goldFixture("navasan", "نوسان", {}).fx,
      goldFixture("navasan", "نوسان", {}).gold
    );
    assert.ok(freshRes.gold.consolidated);
  });

  await test("23. Stale peer dirham excluded from average; consolidated still works", () => {
    const nav = goldFixture("navasan", "نوسان", { dirham: 53_240, mazane: 82_150_000, ounce: 4017.51 });
    const bon = goldFixture("bonbast", "بن‌بست", {
      dirham: 52_675,
      mazane: 82_050_000,
      ounce: 4017.51,
      dirhamAt: staleIso,
      mazaneAt: freshIso,
      ounceAt: freshIso
    });
    const res = buildMarketBubbleResponse(
      {
        quotes: [...nav.fx.quotes, ...bon.fx.quotes],
        sourceStatus: "degraded",
        lastUpdated: freshIso
      },
      {
        quotes: [...nav.gold.quotes, ...bon.gold.quotes],
        sourceStatus: "degraded",
        lastUpdated: freshIso
      }
    );
    assert.ok(res.gold.consolidated);
    assert.equal(res.gold.consolidated!.dirhamSourceCount, 1);
    assert.equal(res.gold.consolidated!.averageDirhamToman, 53_240);
  });

  await test("24. Tehran-offset ISO vs Z does not false-mismatch when same instant", () => {
    // Same UTC instant expressed with +03:30 offset vs Z
    const utcMs = now - 120_000;
    const z = new Date(utcMs).toISOString();
    const tehranWall = new Date(utcMs + 3.5 * 3600_000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const offsetForm = `${tehranWall.getUTCFullYear()}-${pad(tehranWall.getUTCMonth() + 1)}-${pad(tehranWall.getUTCDate())}T${pad(tehranWall.getUTCHours())}:${pad(tehranWall.getUTCMinutes())}:${pad(tehranWall.getUTCSeconds())}+03:30`;
    const gate = areBubbleInputsAligned([z, offsetForm, z], now);
    assert.equal(gate.ok, true, `expected aligned, got ${gate.reason}`);
  });

  await test("25. Gold direction labels: Iran more expensive when local > global", () => {
    assert.equal(goldBubblePrimaryStatus("positive"), "طلای ایران گران‌تر از ارزش جهانی است");
    const s = goldBubbleSupportSentence("positive", 0.17);
    assert.match(s, /بالاتر/);
    assert.match(s, /۰٫۱۷|0[.,]17|۰\.۱۷/);
  });

  await test("26. Gold direction labels: Iran cheaper when local < global", () => {
    assert.equal(goldBubblePrimaryStatus("negative"), "طلای ایران ارزان‌تر از ارزش جهانی است");
    const s = goldBubbleSupportSentence("negative", -1.06);
    assert.match(s, /پایین‌تر/);
  });

  await test("27. Gold direction labels: near-zero neutral wording", () => {
    assert.equal(
      goldBubblePrimaryStatus("near_zero"),
      "قیمت طلای ایران و ارزش جهانی تقریباً برابر است"
    );
    assert.match(goldBubbleSupportSentence("near_zero", 0.05), /اختلاف معناداری/);
    // classifyBubble preserves existing threshold for 0.17 → positive
    assert.equal(classifyBubbleDirect(0.17), "positive");
  });

  await test("28. Dollar result sentence for consolidated bubble", () => {
    assert.equal(
      dollarBubbleSupportSentence("near_zero", 0.05),
      "دلار بازار تقریباً برابر با ارزش محاسباتی درهم است."
    );
    const cheaper = dollarBubbleSupportSentence("negative", -1.73);
    assert.match(cheaper, /ارزان‌تر/);
    assert.match(cheaper, /٪/);
    // Live abs % via fa-IR — must include the formatted value (not a hardcoded UI string).
    const absFa = new Intl.NumberFormat("fa-IR", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0
    }).format(1.73);
    assert.ok(cheaper.includes(absFa), `expected live abs % ${absFa} in: ${cheaper}`);
    assert.equal(
      cheaper,
      `دلار بازار ${absFa}٪ از ارزش محاسباتی درهم ارزان‌تر است.`
    );
    const dearer = dollarBubbleSupportSentence("positive", 1.2);
    assert.match(dearer, /گران‌تر/);
    const posFa = new Intl.NumberFormat("fa-IR", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 0
    }).format(1.2);
    assert.equal(
      dearer,
      `دلار بازار ${posFa}٪ از ارزش محاسباتی درهم گران‌تر است.`
    );
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
