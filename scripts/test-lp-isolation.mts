/**
 * Focused tests: Exir / OMPFinex / Ramzinex isolation + classification.
 */
import assert from "node:assert/strict";
import { isDeterministicHttpError, ProviderError } from "../src/lib/http.ts";
import {
  clearProviderSlot,
  runAllIsolatedProviders,
  runIsolatedProvider,
  type IsolatedProviderDef
} from "../src/lib/providers/domesticRunner.ts";
import {
  clearDomesticQuotesCache,
  getDomesticQuotes
} from "../src/lib/providers/domestic.ts";
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
    console.log(`        ${e instanceof Error ? e.message : e}`);
    failed += 1;
  }
}

console.log("\nLP isolation + Exir/OMP/Ramzinex tests\n");

await test("403 is deterministic / non-retryable classification", () => {
  assert.equal(isDeterministicHttpError(new ProviderError("HTTP 403")), true);
  assert.equal(isDeterministicHttpError(new ProviderError("HTTP 401")), true);
  assert.equal(isDeterministicHttpError(new ProviderError("HTTP 404")), true);
  assert.equal(isDeterministicHttpError(new ProviderError("HTTP 500")), false);
  assert.equal(isDeterministicHttpError(new ProviderError("زمان پاسخ‌دهی منبع تمام شد")), false);
});

await test("one provider timeout does not cancel another (independent slots)", async () => {
  let slowDone = false;
  let fastDone = false;
  const defs: IsolatedProviderDef[] = [
    {
      id: "slow_test",
      name: "slow",
      endpoint: "https://example.invalid/slow",
      timeoutMs: 80,
      minFetchMs: 0,
      staleTtlMs: 60_000,
      maxRetries: 0,
      rateLimitBackoffMs: 1000,
      live: async () => {
        await new Promise((r) => setTimeout(r, 500));
        slowDone = true;
        return {
          exchangeId: "slow_test",
          exchangeName: "slow",
          buyPrice: 1,
          sellPrice: 2,
          midPrice: 1.5,
          volume: null,
          spread: 1,
          spreadPercent: 50,
          deviationFromMedianPercent: null,
          sourceStatus: "available",
          lastUpdated: new Date().toISOString(),
          isOutlier: false,
          excludedFromMedian: false
        };
      }
    },
    {
      id: "fast_test",
      name: "fast",
      endpoint: "https://example.invalid/fast",
      timeoutMs: 5_000,
      minFetchMs: 0,
      staleTtlMs: 60_000,
      maxRetries: 0,
      rateLimitBackoffMs: 1000,
      live: async () => {
        fastDone = true;
        return {
          exchangeId: "fast_test",
          exchangeName: "fast",
          buyPrice: 100,
          sellPrice: 101,
          midPrice: 100.5,
          volume: null,
          spread: 1,
          spreadPercent: 1,
          deviationFromMedianPercent: null,
          sourceStatus: "available",
          lastUpdated: new Date().toISOString(),
          isOutlier: false,
          excludedFromMedian: false
        };
      }
    }
  ];
  clearProviderSlot("slow_test");
  clearProviderSlot("fast_test");
  const quotes = await runAllIsolatedProviders(defs, { slow_test: true, fast_test: true });
  const fast = quotes.find((q) => q.exchangeId === "fast_test");
  const slow = quotes.find((q) => q.exchangeId === "slow_test");
  assert.ok(fastDone, "fast live() ran");
  assert.equal(fast?.sourceStatus, "available");
  assert.equal(fast?.buyPrice, 100);
  // slow hard-timeout → unavailable (unless stale); must not block fast
  assert.ok(slow);
  assert.notEqual(slow?.sourceStatus, "available");
  assert.ok(
    (slow?.errorMessage || "").includes("80") || (slow?.errorMessage || "").includes("تمام"),
    "slow should surface timeout"
  );
  void slowDone;
});

await test("403 is not retried (single live call)", async () => {
  let calls = 0;
  const def: IsolatedProviderDef = {
    id: "exir_403_test",
    name: "exir-test",
    endpoint: "https://example.invalid/403",
    timeoutMs: 2_000,
    minFetchMs: 0,
    staleTtlMs: 60_000,
    maxRetries: 3,
    rateLimitBackoffMs: 60_000,
    live: async () => {
      calls += 1;
      throw new ProviderError("HTTP 403");
    }
  };
  clearProviderSlot(def.id);
  const q = await runIsolatedProvider(def);
  assert.equal(calls, 1, "must not retry 403");
  assert.equal(q.sourceStatus, "unavailable");
  assert.match(q.errorMessage || "", /403/);
});

await test("duplicate inflight for same provider is single-flight", async () => {
  let calls = 0;
  const def: IsolatedProviderDef = {
    id: "dup_test",
    name: "dup",
    endpoint: "https://example.invalid/dup",
    timeoutMs: 5_000,
    minFetchMs: 0,
    staleTtlMs: 60_000,
    maxRetries: 0,
    rateLimitBackoffMs: 1000,
    live: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 100));
      return {
        exchangeId: "dup_test",
        exchangeName: "dup",
        buyPrice: 10,
        sellPrice: 11,
        midPrice: 10.5,
        volume: null,
        spread: 1,
        spreadPercent: 10,
        deviationFromMedianPercent: null,
        sourceStatus: "available",
        lastUpdated: new Date().toISOString(),
        isOutlier: false,
        excludedFromMedian: false
      };
    }
  };
  clearProviderSlot(def.id);
  const [a, b] = await Promise.all([runIsolatedProvider(def), runIsolatedProvider(def)]);
  assert.equal(calls, 1);
  assert.equal(a.buyPrice, 10);
  assert.equal(b.buyPrice, 10);
});

await test("live Ramzinex parses USDT/IRT with rial→toman", async () => {
  clearDomesticQuotesCache();
  clearProviderSlot("ramzinex");
  const enabledSources = { ...defaultSettings.enabledSources };
  for (const k of Object.keys(enabledSources)) enabledSources[k] = k === "ramzinex";
  const quotes = await getDomesticQuotes({ ...defaultSettings, enabledSources });
  const q = quotes.find((x) => x.exchangeId === "ramzinex");
  assert.ok(q);
  assert.equal(q!.sourceStatus, "available");
  assert.ok(q!.buyPrice !== null && q!.buyPrice! > 20_000 && q!.buyPrice! < 1_000_000);
  assert.ok(q!.sellPrice !== null && q!.sellPrice! >= q!.buyPrice! * 0.95);
});

await test("live OMPFinex parses depth market 9 rial→toman buy<=sell-ish", async () => {
  clearDomesticQuotesCache();
  clearProviderSlot("ompfinex");
  const enabledSources = { ...defaultSettings.enabledSources };
  for (const k of Object.keys(enabledSources)) enabledSources[k] = k === "ompfinex";
  const quotes = await getDomesticQuotes({ ...defaultSettings, enabledSources });
  const q = quotes.find((x) => x.exchangeId === "ompfinex");
  assert.ok(q);
  assert.equal(q!.sourceStatus, "available");
  assert.ok(q!.buyPrice !== null && q!.midPrice !== null);
  // allow tiny crossed books from exchange but mid must be sane
  assert.ok(q!.midPrice! > 20_000 && q!.midPrice! < 1_000_000);
});

await test("live Exir orderbook (may 403 under WAF — then mark unavailable without crash)", async () => {
  clearDomesticQuotesCache();
  clearProviderSlot("exir");
  const enabledSources = { ...defaultSettings.enabledSources };
  for (const k of Object.keys(enabledSources)) enabledSources[k] = k === "exir";
  const quotes = await getDomesticQuotes({ ...defaultSettings, enabledSources });
  const q = quotes.find((x) => x.exchangeId === "exir");
  assert.ok(q);
  if (q!.sourceStatus === "available") {
    assert.ok(q!.buyPrice !== null && q!.sellPrice !== null);
    assert.ok(q!.buyPrice! <= q!.sellPrice! * 1.05);
  } else {
    assert.ok(
      (q!.errorMessage || "").includes("403") ||
        (q!.errorMessage || "").includes("HTTP") ||
        (q!.errorMessage || "").includes("تمام"),
      `unexpected error: ${q!.errorMessage}`
    );
  }
});

await test("other LPs unaffected when one fails", async () => {
  clearDomesticQuotesCache();
  for (const id of ["exir", "ompfinex", "ramzinex"]) clearProviderSlot(id);
  const enabledSources = { ...defaultSettings.enabledSources };
  for (const k of Object.keys(enabledSources)) {
    enabledSources[k] = ["exir", "ompfinex", "ramzinex"].includes(k);
  }
  const quotes = await getDomesticQuotes({ ...defaultSettings, enabledSources });
  const omp = quotes.find((q) => q.exchangeId === "ompfinex");
  const rx = quotes.find((q) => q.exchangeId === "ramzinex");
  assert.ok(omp && rx);
  // At least one of OMP/Ramzinex should succeed from this network
  const anyOk =
    omp!.sourceStatus === "available" || rx!.sourceStatus === "available";
  assert.ok(anyOk, "expected OMP or Ramzinex available");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
