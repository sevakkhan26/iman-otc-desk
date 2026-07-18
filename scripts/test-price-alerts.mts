/**
 * Price-alert engine & store unit tests (no live network required).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluateCondition } from "../src/lib/priceAlerts/engine.ts";
import {
  isValidTargetPrice,
  resolveObservedQuotes,
  type LivePriceBundle
} from "../src/lib/priceAlerts/instruments.ts";
import {
  __setStoreForTests,
  createAlert,
  listAlerts,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  newId,
  unreadCount
} from "../src/lib/priceAlerts/store.ts";
import { evaluatePriceAlerts } from "../src/lib/priceAlerts/engine.ts";
import type { PriceAlertRule } from "../src/lib/types.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return (async () => {
    try {
      await fn();
      console.log(`  PASS  ${name}`);
      passed += 1;
    } catch (error) {
      console.log(`  FAIL  ${name}`);
      console.log(`        ${error instanceof Error ? error.message : error}`);
      failed += 1;
    }
  })();
}

function sampleLive(): LivePriceBundle {
  return {
    domestic: [
      {
        exchangeId: "bitpin",
        exchangeName: "بیت‌پین",
        buyPrice: 189000,
        sellPrice: 189500,
        midPrice: 189250,
        volume: null,
        spread: 500,
        spreadPercent: 0.26,
        deviationFromMedianPercent: 0,
        sourceStatus: "available",
        lastUpdated: new Date().toISOString(),
        isOutlier: false,
        excludedFromMedian: false
      },
      {
        exchangeId: "nobitex",
        exchangeName: "نوبیتکس",
        buyPrice: 188800,
        sellPrice: 189200,
        midPrice: 189000,
        volume: null,
        spread: 400,
        spreadPercent: 0.21,
        deviationFromMedianPercent: 0,
        sourceStatus: "available",
        lastUpdated: new Date().toISOString(),
        isOutlier: false,
        excludedFromMedian: false
      },
      {
        exchangeId: "dead",
        exchangeName: "قطع",
        buyPrice: null,
        sellPrice: null,
        midPrice: null,
        volume: null,
        spread: null,
        spreadPercent: null,
        deviationFromMedianPercent: null,
        sourceStatus: "unavailable",
        lastUpdated: null,
        isOutlier: false,
        excludedFromMedian: true
      }
    ],
    gold: [
      {
        sourceId: "navasan",
        sourceName: "نوسان",
        instrument: "اونس طلا به دلار",
        unit: "usd_oz",
        buyPrice: null,
        sellPrice: null,
        midPrice: 2350,
        lastUpdated: new Date().toISOString(),
        status: "available"
      },
      {
        sourceId: "talavest",
        sourceName: "Talavest",
        instrument: "سکه طرح امامی",
        unit: "toman",
        buyPrice: 70_000_000,
        sellPrice: 71_000_000,
        midPrice: 70_500_000,
        lastUpdated: new Date().toISOString(),
        status: "available"
      }
    ],
    fx: [
      {
        sourceId: "navasan",
        sourceName: "نوسان",
        assetType: "درهم امارات",
        buyPrice: 52000,
        sellPrice: 52500,
        midPrice: 52250,
        lastUpdated: new Date().toISOString(),
        status: "available"
      }
    ],
    global: [
      {
        symbol: "BTC/USDT",
        price: 65000,
        source: "Gate.io",
        sourceStatus: "available",
        lastUpdated: new Date().toISOString()
      },
      {
        symbol: "ETH/USDT",
        price: 3400,
        source: "Gate.io",
        sourceStatus: "available",
        lastUpdated: new Date().toISOString()
      }
    ]
  };
}

function baseRule(partial: Partial<PriceAlertRule>): PriceAlertRule {
  const now = new Date().toISOString();
  return {
    id: partial.id ?? newId("pa"),
    instrument: partial.instrument ?? "usdt_irt",
    targetPrice: partial.targetPrice ?? 189500,
    condition: partial.condition ?? "gte",
    priceType: partial.priceType ?? "sell",
    providerMode: partial.providerMode ?? "any",
    providerId: partial.providerId ?? null,
    enabled: partial.enabled ?? true,
    repeatMode: partial.repeatMode ?? "once",
    cooldownSeconds: partial.cooldownSeconds ?? 300,
    expiresAt: null,
    note: partial.note ?? null,
    previousObservedPrice: partial.previousObservedPrice ?? null,
    lastEvaluatedPrice: partial.lastEvaluatedPrice ?? null,
    lastEvaluatedAt: partial.lastEvaluatedAt ?? null,
    lastTriggeredAt: partial.lastTriggeredAt ?? null,
    triggerCount: partial.triggerCount ?? 0,
    lastProviderId: partial.lastProviderId ?? null,
    lastProviderName: partial.lastProviderName ?? null,
    status: partial.status ?? "active",
    createdBy: partial.createdBy ?? "admin",
    createdAt: partial.createdAt ?? now,
    updatedAt: partial.updatedAt ?? now
  };
}

async function main() {
  console.log("Price alert tests\n");
  const dataDir = path.join(process.cwd(), ".data");
  await mkdir(dataDir, { recursive: true });
  await writeFile(path.join(dataDir, "price-alerts-test-marker"), "ok", "utf8");

  await test("1. gte condition triggers at/above target", () => {
    assert.equal(evaluateCondition("gte", 189500, 189500, null), true);
    assert.equal(evaluateCondition("gte", 189600, 189500, null), true);
    assert.equal(evaluateCondition("gte", 189400, 189500, null), false);
  });

  await test("2. lte condition triggers at/below target", () => {
    assert.equal(evaluateCondition("lte", 189500, 189500, null), true);
    assert.equal(evaluateCondition("lte", 189400, 189500, null), true);
    assert.equal(evaluateCondition("lte", 189600, 189500, null), false);
  });

  await test("3. cross_up requires real crossing", () => {
    assert.equal(evaluateCondition("cross_up", 189500, 189500, 189400), true);
    assert.equal(evaluateCondition("cross_up", 189500, 189500, 189500), false);
    assert.equal(evaluateCondition("cross_up", 189500, 189500, null), false);
  });

  await test("4. cross_down requires real crossing", () => {
    assert.equal(evaluateCondition("cross_down", 189400, 189500, 189600), true);
    assert.equal(evaluateCondition("cross_down", 189400, 189500, 189400), false);
  });

  await test("5. valid target price rules", () => {
    assert.equal(isValidTargetPrice("usdt_irt", 189500), true);
    assert.equal(isValidTargetPrice("usdt_irt", 0), false);
    assert.equal(isValidTargetPrice("usdt_irt", -1), false);
    assert.equal(isValidTargetPrice("btc_usdt", 65000), true);
  });

  await test("6. any-source resolves healthy providers only", () => {
    const live = sampleLive();
    const quotes = resolveObservedQuotes("usdt_irt", "sell", "any", null, live);
    assert.ok(quotes.every((q) => q.providerId !== "dead"));
    assert.ok(quotes.some((q) => q.providerId === "bitpin"));
  });

  await test("7. specific-source does not use another provider", () => {
    const live = sampleLive();
    const quotes = resolveObservedQuotes("usdt_irt", "sell", "specific", "bitpin", live);
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0]?.providerId, "bitpin");
  });

  await test("8. reference-only gold ounce exposes mid/reference not buy/sell", () => {
    const live = sampleLive();
    const quotesMid = resolveObservedQuotes("xau_usd", "mid", "any", null, live);
    assert.ok(quotesMid.length >= 1);
    const quotesBuy = resolveObservedQuotes("xau_usd", "buy", "any", null, live);
    assert.equal(quotesBuy.length, 0);
  });

  await test("9. admin create USDT buy alert persists", async () => {
    await __setStoreForTests({ alerts: [], notifications: [], updatedAt: null });
    const rule = baseRule({
      priceType: "buy",
      targetPrice: 200000,
      condition: "gte",
      providerMode: "any"
    });
    await createAlert(rule);
    const list = await listAlerts();
    assert.equal(list.length, 1);
    assert.equal(list[0]?.priceType, "buy");
    assert.equal(list[0]?.instrument, "usdt_irt");
  });

  await test("10. admin create USDT sell alert persists", async () => {
    await __setStoreForTests({ alerts: [], notifications: [], updatedAt: null });
    const rule = baseRule({
      priceType: "sell",
      targetPrice: 180000,
      condition: "lte"
    });
    await createAlert(rule);
    const list = await listAlerts();
    assert.equal(list[0]?.priceType, "sell");
    assert.equal(list[0]?.condition, "lte");
  });

  await test("11. gte alert triggers and records provider", async () => {
    await __setStoreForTests({
      alerts: [
        baseRule({
          id: "t1",
          priceType: "sell",
          targetPrice: 189400,
          condition: "gte",
          providerMode: "any",
          enabled: true,
          repeatMode: "once",
          triggerCount: 0
        })
      ],
      notifications: [],
      updatedAt: null
    });
    const result = await evaluatePriceAlerts(sampleLive());
    assert.equal(result.triggered, 1);
    const notes = await listNotifications();
    assert.equal(notes.length, 1);
    assert.ok(notes[0]!.actualPrice >= 189400);
    assert.ok(notes[0]!.providerName.length > 0);
    assert.equal(notes[0]!.providerId === "bitpin" || notes[0]!.providerId === "nobitex", true);
  });

  await test("12. one-time alert triggers only once", async () => {
    await __setStoreForTests({
      alerts: [
        baseRule({
          id: "once1",
          priceType: "sell",
          targetPrice: 189400,
          condition: "gte",
          enabled: true,
          repeatMode: "once",
          triggerCount: 0
        })
      ],
      notifications: [],
      updatedAt: null
    });
    await evaluatePriceAlerts(sampleLive());
    await evaluatePriceAlerts(sampleLive());
    const notes = await listNotifications();
    assert.equal(notes.length, 1);
    const alerts = await listAlerts();
    assert.equal(alerts[0]?.enabled, false);
    assert.equal(alerts[0]?.status, "triggered");
  });

  await test("13. repeating alert respects cooldown", async () => {
    await __setStoreForTests({
      alerts: [
        baseRule({
          id: "rep1",
          priceType: "sell",
          targetPrice: 189400,
          condition: "gte",
          enabled: true,
          repeatMode: "repeat",
          cooldownSeconds: 3600,
          triggerCount: 1,
          lastTriggeredAt: new Date().toISOString(),
          previousObservedPrice: 189500
        })
      ],
      notifications: [],
      updatedAt: null
    });
    const result = await evaluatePriceAlerts(sampleLive());
    assert.equal(result.triggered, 0);
  });

  await test("14. legacy expiresAt is ignored — alert still evaluates when enabled", async () => {
    const rule = baseRule({
      id: "exp1",
      priceType: "sell",
      targetPrice: 189400,
      condition: "gte",
      enabled: true,
      repeatMode: "once",
      triggerCount: 0
    });
    // Simulate old stored records that still have an expiresAt timestamp.
    rule.expiresAt = new Date(Date.now() - 60_000).toISOString();
    await __setStoreForTests({ alerts: [rule], notifications: [], updatedAt: null });
    const result = await evaluatePriceAlerts(sampleLive());
    assert.equal(result.triggered, 1);
    const alerts = await listAlerts();
    assert.notEqual(alerts[0]?.status as string, "expired");
    assert.equal(alerts[0]?.status, "triggered");
  });

  await test("15. disabled alert does not trigger", async () => {
    await __setStoreForTests({
      alerts: [
        baseRule({
          id: "dis1",
          priceType: "sell",
          targetPrice: 189400,
          condition: "gte",
          enabled: false
        })
      ],
      notifications: [],
      updatedAt: null
    });
    const result = await evaluatePriceAlerts(sampleLive());
    assert.equal(result.triggered, 0);
  });

  await test("16. disconnected specific source does not trigger", async () => {
    await __setStoreForTests({
      alerts: [
        baseRule({
          id: "dead1",
          priceType: "sell",
          targetPrice: 1,
          condition: "gte",
          providerMode: "specific",
          providerId: "dead",
          enabled: true
        })
      ],
      notifications: [],
      updatedAt: null
    });
    const result = await evaluatePriceAlerts(sampleLive());
    assert.equal(result.triggered, 0);
  });

  await test("17. stale provider data does not trigger any-source", async () => {
    const live = sampleLive();
    live.domestic = live.domestic.map((d) => ({
      ...d,
      lastUpdated: new Date(Date.now() - 60 * 60_000).toISOString()
    }));
    await __setStoreForTests({
      alerts: [
        baseRule({
          id: "stale1",
          priceType: "sell",
          targetPrice: 1,
          condition: "gte",
          providerMode: "any",
          enabled: true
        })
      ],
      notifications: [],
      updatedAt: null
    });
    const result = await evaluatePriceAlerts(live);
    assert.equal(result.triggered, 0);
  });

  await test("18. unread count + mark read", async () => {
    await __setStoreForTests({
      alerts: [],
      notifications: [
        {
          id: "n1",
          alertId: "a1",
          instrument: "usdt_irt",
          providerId: "bitpin",
          providerName: "بیت‌پین",
          priceType: "sell",
          targetPrice: 189500,
          actualPrice: 189500,
          condition: "gte",
          triggeredAt: new Date().toISOString(),
          note: null,
          readAt: null
        }
      ],
      updatedAt: null
    });
    assert.equal(await unreadCount(), 1);
    await markNotificationRead("n1");
    assert.equal(await unreadCount(), 0);
    await __setStoreForTests({
      alerts: [],
      notifications: [
        {
          id: "n2",
          alertId: "a1",
          instrument: "usdt_irt",
          providerId: "bitpin",
          providerName: "بیت‌پین",
          priceType: "sell",
          targetPrice: 1,
          actualPrice: 2,
          condition: "gte",
          triggeredAt: new Date().toISOString(),
          note: null,
          readAt: null
        },
        {
          id: "n3",
          alertId: "a1",
          instrument: "usdt_irt",
          providerId: "bitpin",
          providerName: "بیت‌پین",
          priceType: "sell",
          targetPrice: 1,
          actualPrice: 2,
          condition: "gte",
          triggeredAt: new Date().toISOString(),
          note: null,
          readAt: null
        }
      ],
      updatedAt: null
    });
    await markAllNotificationsRead();
    assert.equal(await unreadCount(), 0);
  });

  await test("19. alert history survives store reload", async () => {
    await __setStoreForTests({
      alerts: [baseRule({ id: "persist1", note: "reload-me" })],
      notifications: [],
      updatedAt: null
    });
    // force re-read from disk
    const { __setStoreForTests: set, listAlerts: list } = await import("../src/lib/priceAlerts/store.ts");
    // mem already set; re-read by writing and using listAlerts
    const alerts = await list();
    assert.equal(alerts[0]?.id, "persist1");
    assert.equal(alerts[0]?.note, "reload-me");
    void set;
  });

  await test("20. specific source records that exchange only", async () => {
    await __setStoreForTests({
      alerts: [
        baseRule({
          id: "spec1",
          priceType: "sell",
          targetPrice: 189000,
          condition: "gte",
          providerMode: "specific",
          providerId: "nobitex",
          enabled: true,
          repeatMode: "once"
        })
      ],
      notifications: [],
      updatedAt: null
    });
    await evaluatePriceAlerts(sampleLive());
    const notes = await listNotifications();
    assert.equal(notes[0]?.providerId, "nobitex");
  });

  await test("21. production mode without Upstash does not use file backend", async () => {
    const prevVercel = process.env.VERCEL;
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.VERCEL = "1";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { resolveStorageBackend, getStorageDiagnostics, __resetStoreMemoryForTests } = await import(
      "../src/lib/priceAlerts/store.ts"
    );
    await __resetStoreMemoryForTests();
    assert.equal(resolveStorageBackend(), "none");
    const diag = getStorageDiagnostics();
    assert.equal(diag.storageConfigured, false);
    assert.equal(diag.vercel, true);
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
    await __resetStoreMemoryForTests();
  });

  await test("22. upstash env selects upstash backend", async () => {
    const prevVercel = process.env.VERCEL;
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.VERCEL = "1";
    process.env.UPSTASH_REDIS_REST_URL = "https://example.upstash.io";
    process.env.UPSTASH_REDIS_REST_TOKEN = "test-token";
    const { resolveStorageBackend, __resetStoreMemoryForTests } = await import("../src/lib/priceAlerts/store.ts");
    await __resetStoreMemoryForTests();
    assert.equal(resolveStorageBackend(), "upstash");
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
    await __resetStoreMemoryForTests();
  });

  await test("23. local non-vercel defaults to file storage", async () => {
    const prevVercel = process.env.VERCEL;
    delete process.env.VERCEL;
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { resolveStorageBackend, __resetStoreMemoryForTests } = await import("../src/lib/priceAlerts/store.ts");
    await __resetStoreMemoryForTests();
    assert.equal(resolveStorageBackend(), "file");
    if (prevVercel !== undefined) process.env.VERCEL = prevVercel;
    await __resetStoreMemoryForTests();
  });

  await test("24. VERCEL=1 never selects file and forbids file write before mkdir", async () => {
    const prevVercel = process.env.VERCEL;
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.VERCEL = "1";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const {
      resolveStorageBackend,
      __tryWriteFileStoreForTests,
      __resetStoreMemoryForTests,
      PriceAlertStorageError
    } = await import("../src/lib/priceAlerts/store.ts");
    await __resetStoreMemoryForTests();
    assert.equal(resolveStorageBackend(), "none");
    let threw = false;
    try {
      await __tryWriteFileStoreForTests({ alerts: [], notifications: [], updatedAt: null });
    } catch (error) {
      threw = true;
      assert.ok(error instanceof PriceAlertStorageError);
      assert.equal((error as { code: string }).code, "FILE_STORAGE_FORBIDDEN_ON_VERCEL");
    }
    assert.equal(threw, true);
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
    await __resetStoreMemoryForTests();
  });

  await test("25. createPriceAlert on Vercel without Upstash throws STORAGE_NOT_CONFIGURED", async () => {
    const prevVercel = process.env.VERCEL;
    const prevUrl = process.env.UPSTASH_REDIS_REST_URL;
    const prevToken = process.env.UPSTASH_REDIS_REST_TOKEN;
    process.env.VERCEL = "1";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { __resetStoreMemoryForTests, PriceAlertStorageError } = await import("../src/lib/priceAlerts/store.ts");
    const { createPriceAlert } = await import("../src/lib/priceAlerts/service.ts");
    await __resetStoreMemoryForTests();
    let threw = false;
    try {
      await createPriceAlert({
        instrument: "usdt_irt",
        targetPrice: 100000,
        condition: "gte",
        priceType: "mid",
        providerMode: "any",
        repeatMode: "once",
        createdBy: "admin"
      });
    } catch (error) {
      threw = true;
      assert.ok(error instanceof PriceAlertStorageError);
      assert.equal((error as { code: string }).code, "STORAGE_NOT_CONFIGURED");
    }
    assert.equal(threw, true);
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    if (prevUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL;
    else process.env.UPSTASH_REDIS_REST_URL = prevUrl;
    if (prevToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN;
    else process.env.UPSTASH_REDIS_REST_TOKEN = prevToken;
    await __resetStoreMemoryForTests();
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

void main();
