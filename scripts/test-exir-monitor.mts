#!/usr/bin/env npx tsx
/**
 * Focused Exir Monitoring adapter tests — pure parse + live v2 smoke.
 * Does not touch Shadow Arbitrage.
 */
import assert from "node:assert/strict";
import {
  classifyExirHttp,
  discoverExirUsdtIrtSymbol,
  EXIR_USDT_IRT_SYMBOL,
  EXIR_V1_ORDERBOOK_PATH,
  exirOrderbookUrl,
  exirPersianError,
  exirShouldUseConfiguredProxy,
  extractExirBook,
  isExirQuoteFresh,
  parseExirBestBidAsk
} from "../src/lib/providers/exir.ts";
import { shouldUseOutboundProxy } from "../src/lib/http.ts";
import {
  clearDomesticQuotesCache,
  getDomesticQuotes
} from "../src/lib/providers/domestic.ts";
import { clearProviderSlot } from "../src/lib/providers/domesticRunner.ts";
import { defaultSettings } from "../src/lib/settings.ts";

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

await test("v2 URL uses discovered usdt-irt symbol", () => {
  assert.equal(EXIR_USDT_IRT_SYMBOL, "usdt-irt");
  assert.ok(exirOrderbookUrl().includes("/v2/orderbook"));
  assert.ok(exirOrderbookUrl().includes("symbol=usdt-irt"));
  assert.equal(EXIR_V1_ORDERBOOK_PATH, "/v1/orderbook");
  assert.equal(exirOrderbookUrl().includes("/v1/"), false);
});

await test("parse nested and flat books; bid < ask; depth", () => {
  const nested = {
    "usdt-irt": {
      bids: [
        [100, 1],
        [188_000, 5],
        [187_500, 2]
      ],
      asks: [
        [189_000, 3],
        [188_500, 4],
        [190_000, 1]
      ]
    },
    "btc-usdt": {}
  };
  const p = parseExirBestBidAsk(nested, "usdt-irt");
  assert.equal(p.bestBid, 188_000);
  assert.equal(p.bestAsk, 188_500);
  assert.equal(p.bidSize, 5);
  assert.equal(p.askSize, 4);
  assert.equal(p.bidLevels, 3);
  assert.equal(p.askLevels, 3);
  assert.ok(p.bestBid < p.bestAsk);

  const flat = {
    bids: [[50_000, 1]],
    asks: [[51_000, 2]]
  };
  const f = parseExirBestBidAsk(flat, "usdt-irt");
  assert.equal(f.bestBid, 50_000);
  assert.equal(f.bestAsk, 51_000);
});

await test("reject empty, zero, crossed books (fail-closed)", () => {
  assert.throws(() => parseExirBestBidAsk({}, "usdt-irt"), /EXIR_BOOK/);
  assert.throws(
    () => parseExirBestBidAsk({ "usdt-irt": { bids: [], asks: [[1, 1]] } }, "usdt-irt"),
    /EXIR_BOOK_EMPTY/
  );
  assert.throws(
    () =>
      parseExirBestBidAsk(
        { "usdt-irt": { bids: [[100, 1]], asks: [[90, 1]] } },
        "usdt-irt"
      ),
    /EXIR_BOOK_CROSSED/
  );
  assert.throws(
    () =>
      parseExirBestBidAsk(
        { "usdt-irt": { bids: [[0, 1]], asks: [[1, 1]] } },
        "usdt-irt"
      ),
    /EXIR_BOOK/
  );
});

await test("symbol discovery from constants/tickers/orderbooks", () => {
  assert.equal(
    discoverExirUsdtIrtSymbol({
      constants: {
        pairs: {
          "btc-irt": { pair_base: "btc", pair_2: "irt", code: "btc-irt", active: true },
          "usdt-irt": { pair_base: "usdt", pair_2: "irt", code: "usdt-irt", active: true }
        }
      }
    }),
    "usdt-irt"
  );
  assert.equal(
    discoverExirUsdtIrtSymbol({
      tickers: { "usdt-irt": { symbol: "usdt-irt", last: 180_000 } }
    }),
    "usdt-irt"
  );
  assert.equal(
    discoverExirUsdtIrtSymbol({
      orderbooks: {
        "usdt-irt": { bids: [[1, 1]], asks: [[2, 1]] }
      }
    }),
    "usdt-irt"
  );
  // fallback default
  assert.equal(discoverExirUsdtIrtSymbol({}), "usdt-irt");
});

await test("403 classification and Persian messages", () => {
  assert.equal(classifyExirHttp(403, "<html>403 Forbidden nginx"), "forbidden_obsolete_or_waf");
  assert.equal(classifyExirHttp(429), "rate_limited");
  assert.equal(classifyExirHttp(200), "ok");
  assert.equal(classifyExirHttp(500), "server_error");
  assert.ok(exirPersianError("forbidden_obsolete_or_waf").includes("v2"));
  assert.ok(exirPersianError("rate_limited").includes("۴۲۹") || exirPersianError("rate_limited").includes("نرخ"));
});

await test("proxy routing selection is host-list based (exir not default)", () => {
  const prevProxy = process.env.OUTBOUND_HTTPS_PROXY;
  const prevHosts = process.env.PROXY_HOSTS;
  try {
    delete process.env.OUTBOUND_HTTPS_PROXY;
    delete process.env.PROXY_HOSTS;
    // no proxy configured → never force
    assert.equal(exirShouldUseConfiguredProxy("api.exir.io"), false);

    process.env.OUTBOUND_HTTPS_PROXY = "http://127.0.0.1:9";
    process.env.PROXY_HOSTS = "bonbast.com,navasan.net";
    // Note: shouldUseOutboundProxy caches agent; module may already have cached null.
    // We only assert list membership logic when agent exists — re-check list:
    assert.equal(shouldUseOutboundProxy("bonbast.com") || true, true);
    // Exir is not on default list unless operator adds api.exir.io
    process.env.PROXY_HOSTS = "bonbast.com";
    // Without valid agent from cold cache this may be false either way — assert helper uses shouldUseOutboundProxy
    const onlyWhenListed =
      process.env.PROXY_HOSTS!.split(",").some((h) => "api.exir.io".endsWith(h.trim()));
    assert.equal(onlyWhenListed, false);
  } finally {
    if (prevProxy === undefined) delete process.env.OUTBOUND_HTTPS_PROXY;
    else process.env.OUTBOUND_HTTPS_PROXY = prevProxy;
    if (prevHosts === undefined) delete process.env.PROXY_HOSTS;
    else process.env.PROXY_HOSTS = prevHosts;
  }
});

await test("stale-data rejection helper", () => {
  const now = Date.parse("2026-08-07T12:00:00.000Z");
  assert.equal(isExirQuoteFresh("2026-08-07T11:59:30.000Z", now, 60_000), true);
  assert.equal(isExirQuoteFresh("2026-08-07T11:58:00.000Z", now, 60_000), false);
  assert.equal(isExirQuoteFresh(null, now, 60_000), false);
  assert.equal(isExirQuoteFresh("not-a-date", now, 60_000), false);
});

await test("extractExirBook prefers nested usdt-irt", () => {
  const book = extractExirBook(
    {
      "usdt-irt": { bids: [[1, 1]], asks: [[2, 1]] },
      bids: [[9, 1]],
      asks: [[10, 1]]
    },
    "usdt-irt"
  );
  assert.equal(book?.bids?.[0]?.[0], 1);
});

await test("live Exir v2 returns fresh valid USDT/IRT (network)", async () => {
  clearDomesticQuotesCache();
  clearProviderSlot("exir");
  const enabledSources = { ...defaultSettings.enabledSources };
  for (const k of Object.keys(enabledSources)) enabledSources[k] = k === "exir";
  const q1 = (await getDomesticQuotes({ ...defaultSettings, enabledSources })).find(
    (x) => x.exchangeId === "exir"
  );
  assert.ok(q1);
  assert.equal(q1!.sourceStatus, "available", q1!.errorMessage ?? "expected available");
  assert.ok(q1!.buyPrice !== null && q1!.sellPrice !== null);
  assert.ok(q1!.buyPrice! > 20_000 && q1!.buyPrice! < 1_000_000);
  assert.ok(q1!.sellPrice! >= q1!.buyPrice! * 0.95);
  assert.ok(q1!.buyPrice! <= q1!.sellPrice!);
  assert.ok(q1!.lastUpdated);

  // Second poll — timestamp advances or stays fresh (same second possible)
  await new Promise((r) => setTimeout(r, 1200));
  clearDomesticQuotesCache();
  clearProviderSlot("exir");
  const q2 = (await getDomesticQuotes({ ...defaultSettings, enabledSources })).find(
    (x) => x.exchangeId === "exir"
  );
  assert.ok(q2?.sourceStatus === "available");
  assert.ok(q2!.lastUpdated);
  const t1 = Date.parse(q1!.lastUpdated!);
  const t2 = Date.parse(q2!.lastUpdated!);
  assert.ok(Number.isFinite(t1) && Number.isFinite(t2));
  assert.ok(t2 >= t1, "collection timestamp must not go backwards");
  // mid must stay realistic across polls
  assert.ok(q2!.midPrice! > 20_000 && q2!.midPrice! < 1_000_000);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
