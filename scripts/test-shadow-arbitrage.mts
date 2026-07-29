#!/usr/bin/env npx tsx
/**
 * Shadow Arbitrage unit tests — no database, no exchange network.
 * Transport behaviour (timeout / backoff / rate limit) is exercised against a
 * local loopback HTTP server, never a real venue.
 */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import {
  toIntegerToman,
  mulPriceSizeToman,
  feeFromBps,
  unitReadingIsAmbiguous,
  USDT_IRT_MAX_TOMAN,
  USDT_IRT_MIN_TOMAN
} from "../src/lib/shadowArbitrage/money.ts";
import { executableVwap, parseLevels, parseLevelsWithLoss } from "../src/lib/shadowArbitrage/vwap.ts";
import { computeRouteEconomics } from "../src/lib/shadowArbitrage/fees.ts";
import { buildOpportunities, buildOpportunitiesDetailed } from "../src/lib/shadowArbitrage/calculate.ts";
import { mergeOpportunityLifecycle, mergeWithTransitions } from "../src/lib/shadowArbitrage/lifecycle.ts";
import {
  SHADOW_SOURCES,
  SHADOW_COST_RECORDS,
  clampPollInterval,
  SHADOW_POLL_MIN_MS,
  SHADOW_POLL_MAX_MS
} from "../src/lib/shadowArbitrage/config.ts";
import {
  certifyFromSnapshot,
  CERTIFICATION_BASE,
  resetCertifications,
  getCertification
} from "../src/lib/shadowArbitrage/certification.ts";
import {
  shadowRequest,
  ShadowSourceError,
  snapshotFromResult,
  sizesFromQuote,
  type AdapterResult
} from "../src/lib/shadowArbitrage/adapters/base.ts";
import { crossCheckUnits } from "../src/lib/shadowArbitrage/adapters/index.ts";
import { bucketIdempotencyKey } from "../src/lib/shadowArbitrage/collector.ts";
import {
  isDeadLocalWorker,
  makeWorkerId,
  parseWorkerId
} from "../src/lib/shadowArbitrage/workerIdentity.ts";
import type {
  BlockedReasonCode,
  NormalizedSourceSnapshot,
  ShadowOpportunity,
  ShadowSourceId
} from "../src/lib/shadowArbitrage/types.ts";
import {
  BLOCKED_FA,
  SHADOW_WARNING_FA,
  accountPriorityLabel,
  blockedShort,
  deriveCollectorState,
  formatDurationFa,
  formatPercentFa,
  freshnessLabel,
  toFaDigits
} from "../src/components/shadowArbitrage/labels.ts";

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

/* ── helpers ──────────────────────────────────────────────────────────────── */

function mockSource(
  id: string,
  name: string,
  buy: number,
  sell: number,
  opts?: Partial<NormalizedSourceSnapshot>
): NormalizedSourceSnapshot {
  return {
    sourceId: id as ShadowSourceId,
    sourceName: name,
    marketModel: "ORDER_BOOK",
    accountStatus: opts?.accountStatus ?? "verified",
    eligibilityBase: opts?.eligibilityBase ?? "EXECUTABLE_NOW",
    bestBidToman: sell,
    bestAskToman: buy,
    userBuyPriceToman: buy,
    userSellPriceToman: sell,
    sizeExecutables: [5, 10, 20, 25].map((sizeUsdt) => ({
      sizeUsdt: sizeUsdt as 5 | 10 | 20 | 25,
      userBuyVwapToman: buy,
      userSellVwapToman: sell,
      buyFillable: true,
      sellFillable: true,
      buyFilledUsdt: sizeUsdt,
      sellFilledUsdt: sizeUsdt
    })),
    depthUsdtBid: 100,
    depthUsdtAsk: 100,
    maxExecutableUsdt: 100,
    marketFeeBps: opts?.marketFeeBps ?? 25,
    feeStatus: opts?.feeStatus ?? "provisional",
    feeLabel: "test",
    feeReferenceUrl: null,
    feeVerifiedAt: null,
    sourceTimestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    ageMs: opts?.ageMs ?? 0,
    health: opts?.health ?? "healthy",
    errorReason: opts?.errorReason ?? null,
    degradedReason: null,
    stale: opts?.stale ?? false,
    meta: opts?.meta ?? {
      endpoint: "https://example.test/book",
      httpStatus: 200,
      latencyMs: 100,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: null
    },
    sourceBlockedReasons: opts?.sourceBlockedReasons ?? []
  };
}

function baseResult(over: Partial<AdapterResult> = {}): AdapterResult {
  return {
    kind: "BOOK",
    bids: [{ priceToman: 190_000, amountUsdt: 100 }],
    asks: [{ priceToman: 191_000, amountUsdt: 100 }],
    bestBidToman: null,
    bestAskToman: null,
    maxUsdt: null,
    sourceTimestamp: null,
    priceUnit: "IRT",
    depthAvailable: true,
    directionVerified: true,
    endpoint: "https://example.test/book",
    httpStatus: 200,
    latencyMs: 42,
    attempts: 1,
    rateLimited: false,
    normalizationNote: null,
    ...over
  };
}

const nobitexCfg = SHADOW_SOURCES.find((s) => s.id === "nobitex")!;
const abanCfg = SHADOW_SOURCES.find((s) => s.id === "abantether")!;

console.log("\nShadow Arbitrage Phase 2 unit tests\n");

/* ── configuration / separation ───────────────────────────────────────────── */

await test("no OMPFinex in shadow source list", () => {
  assert.equal(
    SHADOW_SOURCES.some((s) => s.id.includes("omp") || s.nameFa.toLowerCase().includes("omp")),
    false
  );
  assert.equal(SHADOW_SOURCES.length, 9);
});

await test("no OMPFinex usage anywhere in the shadow module", () => {
  const files = [
    "src/lib/shadowArbitrage/config.ts",
    "src/lib/shadowArbitrage/adapters/index.ts",
    "src/lib/shadowArbitrage/collector.ts",
    "src/lib/shadowArbitrage/certification.ts",
    "src/db/repositories/shadowArbitrage.ts",
    "src/components/ShadowArbitrageView.tsx"
  ];
  for (const f of files) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    // Comments may state that it is excluded; no executable line may use it.
    const hits = text
      .split("\n")
      .filter((l) => /ompfinex/i.test(l))
      .filter((l) => !/^\s*(\*|\/\/|\/\*|\{\/\*)/.test(l.trim()));
    assert.deepEqual(hits, [], `${f} references OMPFinex: ${hits.join(" | ")}`);
  }
});

await test("shadow APIs and page are admin gated", () => {
  const mw = readFileSync(new URL("../middleware.ts", import.meta.url), "utf8");
  assert.ok(mw.includes('"/shadow-arbitrage"'), "middleware must guard the page");
  assert.ok(mw.includes('"/api/shadow-arbitrage"'), "middleware must guard the API");
  for (const route of ["matrix", "history", "analytics", "observation"]) {
    const src = readFileSync(
      new URL(`../app/api/shadow-arbitrage/${route}/route.ts`, import.meta.url),
      "utf8"
    );
    assert.ok(src.includes("requireAdminSession"), `${route} route must call requireAdminSession`);
  }
});

await test("no authenticated-exchange or trading surface in the shadow module", () => {
  const files = [
    "src/lib/shadowArbitrage/collector.ts",
    "src/lib/shadowArbitrage/adapters/base.ts",
    "src/lib/shadowArbitrage/adapters/index.ts",
    "scripts/shadow-worker.mts"
  ];
  const banned =
    /\b(api[_-]?key|apiKey|secretKey|createOrder|placeOrder|cancelOrder|withdraw|deposit|transferFunds)\b/i;
  for (const f of files) {
    const text = readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
    const hits = text.split("\n").filter((l) => banned.test(l) && !/never|no auth|هرگز/i.test(l));
    assert.deepEqual(hits, [], `${f}: ${hits.join(" | ")}`);
  }
});

await test("poll interval clamps into the safe 15–300s range", () => {
  assert.equal(clampPollInterval(30_000), 30_000);
  assert.equal(clampPollInterval(1_000), SHADOW_POLL_MIN_MS);
  assert.equal(clampPollInterval(999_999), SHADOW_POLL_MAX_MS);
  assert.equal(clampPollInterval(undefined), 30_000);
  assert.equal(clampPollInterval(Number.NaN), 30_000);
});

await test("provisional cost records carry status, date and explanation", () => {
  const slip = SHADOW_COST_RECORDS.find((c) => c.key === "slippage_buffer")!;
  const reb = SHADOW_COST_RECORDS.find((c) => c.key === "rebalance_cost")!;
  assert.equal(slip.value, 5); // 0.05% of buy cost
  assert.equal(slip.status, "provisional");
  assert.ok(slip.explanation.length > 10);
  assert.equal(reb.value, 0);
  assert.equal(reb.status, "provisional");
  for (const cfg of SHADOW_SOURCES) {
    assert.ok(cfg.feeExplanation.length > 10, `${cfg.id} needs a fee explanation`);
    if (cfg.feeStatus === "unknown") assert.equal(cfg.feeBps, null);
  }
});

/* ── money / units ────────────────────────────────────────────────────────── */

await test("IRR rial → IRT toman conversion", () => {
  assert.equal(toIntegerToman(1_935_890, "rial"), 193_589);
  assert.equal(toIntegerToman(193_589, "toman"), 193_589);
  assert.equal(toIntegerToman(100, "toman"), null); // below band
});

await test("rial mislabelled as toman is rejected by the band", () => {
  assert.equal(toIntegerToman(1_935_890, "toman"), null);
  assert.ok(USDT_IRT_MIN_TOMAN === 20_000 && USDT_IRT_MAX_TOMAN === 800_000);
  assert.equal(unitReadingIsAmbiguous(193_589), false);
  assert.equal(unitReadingIsAmbiguous(300_000), true); // both readings plausible
});

await test("exact fee and size math", () => {
  assert.equal(mulPriceSizeToman(100_000, 5), 500_000);
  assert.equal(feeFromBps(500_000, 25), 1_250); // 0.25%
});

/* ── VWAP / depth ─────────────────────────────────────────────────────────── */

await test("VWAP multi-level buy walks asks", () => {
  const asks = [
    { priceToman: 100_000, amountUsdt: 3 },
    { priceToman: 101_000, amountUsdt: 10 }
  ];
  const r = executableVwap(asks, 5, "buy");
  assert.equal(r.fillable, true);
  assert.equal(r.vwapToman, 100_400); // (3*100000 + 2*101000)/5
});

await test("VWAP never uses headline best price for the full size", () => {
  const asks = [
    { priceToman: 100_000, amountUsdt: 1 },
    { priceToman: 120_000, amountUsdt: 100 }
  ];
  const r = executableVwap(asks, 25, "buy");
  assert.ok(r.vwapToman! > 100_000, "must be worse than best ask");
  assert.equal(r.vwapToman, Math.round((1 * 100_000 + 24 * 120_000) / 25));
});

await test("insufficient depth blocks fillable", () => {
  const r = executableVwap([{ priceToman: 100_000, amountUsdt: 2 }], 10, "buy");
  assert.equal(r.fillable, false);
  assert.equal(r.filledUsdt, 2);
});

await test("parseLevels handles rial books and reports rejected levels", () => {
  const levels = parseLevels(
    [
      ["1935890", "1.5"],
      ["1936000", "2"]
    ],
    "rial"
  );
  assert.equal(levels[0]!.priceToman, 193_589);
  // P2P outliers are rejected, not rescaled.
  const loss = parseLevelsWithLoss(
    [
      { price: 50_501_202, amount: 20 },
      { price: 193_500, amount: 5 }
    ],
    "toman"
  );
  assert.equal(loss.levels.length, 1);
  assert.equal(loss.rejected, 1);
});

/* ── snapshot normalization ───────────────────────────────────────────────── */

await test("headline-only response yields no fillable size", () => {
  const snap = snapshotFromResult(
    nobitexCfg,
    baseResult({
      kind: "HEADLINE",
      bids: [],
      asks: [],
      bestBidToman: 193_000,
      bestAskToman: 193_500,
      depthAvailable: false
    }),
    new Date().toISOString()
  );
  assert.ok(snap.sourceBlockedReasons.includes("depth_unverified"));
  assert.equal(snap.health, "degraded");
  assert.deepEqual(
    snap.sizeExecutables.map((s) => s.buyFillable),
    [false, false, false, false]
  );
  assert.equal(snap.depthUsdtAsk, null, "no invented depth");
});

await test("crossed book is flagged, never silently swapped", () => {
  const snap = snapshotFromResult(
    nobitexCfg,
    baseResult({
      bids: [{ priceToman: 195_000, amountUsdt: 50 }],
      asks: [{ priceToman: 190_000, amountUsdt: 50 }]
    }),
    new Date().toISOString()
  );
  assert.ok(snap.sourceBlockedReasons.includes("quote_direction_unverified"));
  assert.equal(snap.userBuyPriceToman, 190_000, "ask stays the ask");
  assert.equal(snap.userSellPriceToman, 195_000, "bid stays the bid");
});

await test("OTC quote enforces published maximum quantity", () => {
  const sizes = sizesFromQuote(194_488, 193_078, 20);
  assert.equal(sizes.find((s) => s.sizeUsdt === 20)!.buyFillable, true);
  assert.equal(sizes.find((s) => s.sizeUsdt === 25)!.buyFillable, false);
  const unknown = sizesFromQuote(194_488, 193_078, null);
  assert.deepEqual(
    unknown.map((s) => s.buyFillable),
    [false, false, false, false]
  );
});

await test("OTC direction: user pays ask, receives bid", () => {
  const snap = snapshotFromResult(
    abanCfg,
    baseResult({
      kind: "OTC_QUOTE",
      bids: [],
      asks: [],
      bestBidToman: 193_078,
      bestAskToman: 194_488,
      maxUsdt: 50_000,
      depthAvailable: false
    }),
    new Date().toISOString()
  );
  assert.equal(snap.userBuyPriceToman, 194_488);
  assert.equal(snap.userSellPriceToman, 193_078);
  assert.ok(snap.userBuyPriceToman! > snap.userSellPriceToman!);
  assert.equal(snap.maxExecutableUsdt, 50_000);
  assert.equal(
    snap.sizeExecutables.every((s) => s.buyFillable),
    true
  );
});

await test("stale source timestamp marks the snapshot stale", () => {
  const receivedAt = new Date().toISOString();
  const snap = snapshotFromResult(
    nobitexCfg,
    baseResult({ sourceTimestamp: new Date(Date.parse(receivedAt) - 200_000).toISOString() }),
    receivedAt
  );
  assert.equal(snap.stale, true);
  assert.equal(snap.health, "degraded");
});

await test("cross-source check degrades a venue far from the median", () => {
  const checked = crossCheckUnits([
    mockSource("nobitex", "n", 193_900, 193_800),
    mockSource("wallex", "w", 193_950, 193_850),
    mockSource("tabdeal", "t", 193_800, 193_700),
    mockSource("bitpin", "b", 250_000, 249_000)
  ]);
  const suspect = checked.find((s) => s.sourceId === "bitpin")!;
  assert.equal(suspect.health, "degraded");
  assert.ok(suspect.sourceBlockedReasons.includes("units_ambiguous"));
  assert.equal(checked.find((s) => s.sourceId === "nobitex")!.health, "healthy");
});

/* ── certification ────────────────────────────────────────────────────────── */

await test("certification: verified only after validated normalization", () => {
  resetCertifications();
  const ok = certifyFromSnapshot(mockSource("nobitex", "n", 193_900, 193_800));
  assert.equal(ok.status, "LIVE_VERIFIED");
  assert.ok(ok.verifiedAt);

  resetCertifications();
  const noDepth = certifyFromSnapshot(
    mockSource("nobitex", "n", 193_900, 193_800, {
      meta: {
        endpoint: "x",
        httpStatus: 200,
        latencyMs: 10,
        attempts: 1,
        rateLimited: false,
        timedOut: false,
        depthAvailable: false,
        directionVerified: true,
        priceUnit: "IRT",
        normalizationNote: null
      }
    })
  );
  assert.equal(noDepth.status, "LIVE_DEGRADED");
  assert.ok(noDepth.statusReason);
  assert.equal(noDepth.verifiedAt, null);
});

await test("certification: unreachable source is UNSUPPORTED until it ever worked", () => {
  resetCertifications();
  const dead = certifyFromSnapshot(
    mockSource("bit24", "b", 0, 0, { health: "unavailable", errorReason: "HTTP 404" })
  );
  assert.equal(dead.status, "UNSUPPORTED");
  assert.ok(dead.statusReason);

  const verified = certifyFromSnapshot(mockSource("bit24", "b", 193_500, 193_400));
  assert.equal(verified.status, "LIVE_VERIFIED");
  const afterOutage = certifyFromSnapshot(
    mockSource("bit24", "b", 0, 0, { health: "unavailable", errorReason: "timeout" }),
    verified
  );
  assert.equal(afterOutage.status, "LIVE_DEGRADED");
});

await test("Arzinja and Tetherland are capped below LIVE_VERIFIED", () => {
  resetCertifications();
  assert.equal(CERTIFICATION_BASE.arzinja.maxStatus, "REFERENCE_ONLY");
  assert.equal(CERTIFICATION_BASE.tetherland.maxStatus, "LIVE_DEGRADED");
  const arz = certifyFromSnapshot(mockSource("arzinja", "a", 194_750, 193_000));
  assert.equal(arz.status, "REFERENCE_ONLY");
  const tl = certifyFromSnapshot(mockSource("tetherland", "t", 193_290, 190_010));
  assert.equal(tl.status, "LIVE_DEGRADED");
  assert.equal(getCertification("arzinja").status, "REFERENCE_ONLY");
});

/* ── economics ────────────────────────────────────────────────────────────── */

await test("unknown fee blocks net-positive label", () => {
  const econ = computeRouteEconomics({
    buySourceId: "bitpin",
    sellSourceId: "nobitex",
    sizeUsdt: 5,
    buyVwapToman: 100_000,
    sellVwapToman: 110_000
  });
  assert.equal(econ.feeUnknown, true);
  assert.ok(econ.blocked.includes("fee_unknown"));
});

await test("provisional fees allow net calc, kept separate from raw spread", () => {
  const econ = computeRouteEconomics({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 5,
    buyVwapToman: 100_000,
    sellVwapToman: 101_000
  });
  assert.equal(econ.feeUnknown, false);
  assert.ok(Number.isFinite(econ.netProfitToman));
  assert.ok(econ.rawSpreadPercent > econ.netEdgePercent);
  assert.ok(econ.slippageBufferToman > 0);
});

/* ── opportunity engine ───────────────────────────────────────────────────── */

await test("pair generation and lifecycle de-dup", () => {
  const sources = [
    mockSource("nobitex", "نوبیتکس", 100_000, 99_500),
    mockSource("wallex", "والکس", 101_000, 100_500)
  ];
  const t1 = "2026-07-28T10:00:00.000Z";
  const first = buildOpportunities(sources, [], t1);
  const active1 = first.filter((o) => o.isActive && o.routeKey === "nobitex->wallex@5");
  assert.equal(active1.length, 1);
  const id1 = active1[0]!.id;

  const t2 = "2026-07-28T10:00:30.000Z";
  const second = buildOpportunities(sources, first, t2);
  const active2 = second.filter((o) => o.isActive && o.routeKey === "nobitex->wallex@5");
  assert.equal(active2.length, 1, "one lifecycle, not a new row per cycle");
  assert.equal(active2[0]!.id, id1);
  assert.equal(active2[0]!.firstSeenAt, t1);
  assert.ok(active2[0]!.durationMs >= 30_000);
  assert.equal(active2[0]!.observationCount, 2);
});

await test("only material (crossing) routes create lifecycles", () => {
  const sources = [
    mockSource("nobitex", "n", 101_000, 100_500),
    mockSource("wallex", "w", 100_000, 99_500)
  ];
  const built = buildOpportunitiesDetailed(sources, [], new Date().toISOString());
  const routes = new Set(built.opportunities.map((o) => o.routeKey));
  assert.equal(
    [...routes].some((r) => r.startsWith("nobitex->wallex")),
    false
  );
  assert.ok([...routes].some((r) => r.startsWith("wallex->nobitex")));
  // Every evaluated pair is still represented in the aggregate drafts.
  assert.equal(built.drafts.length, 2 * 4);
});

await test("lifecycle start / end / reappearance", () => {
  const sources = [
    mockSource("nobitex", "n", 100_000, 99_500),
    mockSource("wallex", "w", 101_000, 100_500)
  ];
  const t1 = "2026-07-28T10:00:00.000Z";
  const opened = buildOpportunitiesDetailed(sources, [], t1);
  assert.ok(opened.transitions.some((t) => t.eventType === "opened"));

  const t2 = "2026-07-28T10:01:00.000Z";
  const closed = mergeWithTransitions(opened.opportunities, [], t2);
  const ended = closed.merged.find((m) => m.routeKey === "nobitex->wallex@5")!;
  assert.equal(ended.isActive, false);
  assert.ok(ended.endedAt);
  assert.ok(closed.transitions.some((t) => t.eventType === "closed"));

  const t3 = "2026-07-28T10:02:00.000Z";
  const again = buildOpportunitiesDetailed(sources, closed.merged, t3);
  assert.ok(
    again.transitions.some((t) => t.eventType === "reappeared"),
    "closed route returning must be recorded as reappeared"
  );
  const fresh = again.opportunities.find((o) => o.routeKey === "nobitex->wallex@5" && o.isActive)!;
  assert.equal(fresh.firstSeenAt, t3, "reappearance opens a new lifecycle");
  assert.notEqual(fresh.id, ended.id);
});

await test("merge ends missing routes", () => {
  const prev: ShadowOpportunity[] = [
    {
      id: "abc",
      routeKey: "nobitex->wallex@5",
      buySourceId: "nobitex",
      sellSourceId: "wallex",
      buySourceName: "ن",
      sellSourceName: "و",
      sizeUsdt: 5,
      buyVwapToman: 1,
      sellVwapToman: 2,
      rawSpreadPercent: 1,
      buyFeeToman: 0,
      sellFeeToman: 0,
      buyFeeBps: 0,
      sellFeeBps: 0,
      totalFeePercent: 0,
      slippageBufferToman: 0,
      rebalanceCostToman: 0,
      netProfitToman: 1,
      netEdgePercent: 1,
      buyCostToman: 1,
      sellProceedsToman: 2,
      eligibility: "EXECUTABLE_NOW",
      blockedReasons: [],
      firstSeenAt: "2026-07-28T10:00:00.000Z",
      lastSeenAt: "2026-07-28T10:00:00.000Z",
      endedAt: null,
      durationMs: 0,
      maxNetEdgePercent: 1,
      maxNetProfitToman: 1,
      maxRawSpreadPercent: 1,
      feeUnknown: false,
      observationCount: 1,
      isActive: true,
      buyAgeMs: 0,
      sellAgeMs: 0
    }
  ];
  const merged = mergeOpportunityLifecycle(prev, [], "2026-07-28T10:01:00.000Z");
  const ended = merged.find((m) => m.routeKey === "nobitex->wallex@5");
  assert.equal(ended?.isActive, false);
  assert.ok(ended?.endedAt);
});

await test("one failed source does not stop the others", () => {
  const sources = [
    mockSource("nobitex", "n", 0, 0, {
      health: "unavailable",
      errorReason: "HTTP 500",
      sourceBlockedReasons: ["source_unhealthy", "market_data_missing"]
    }),
    mockSource("wallex", "w", 100_000, 99_500),
    mockSource("tabdeal", "t", 101_000, 100_500)
  ];
  const built = buildOpportunitiesDetailed(sources, [], new Date().toISOString());
  const alive = built.opportunities.filter(
    (o) => o.buySourceId === "wallex" && o.sellSourceId === "tabdeal"
  );
  assert.ok(alive.length > 0, "healthy pair still evaluated");
  assert.ok((built.blockedCounts.source_unhealthy ?? 0) > 0);
});

await test("stale / uncertified sources block executability", () => {
  const stale = buildOpportunitiesDetailed(
    [
      mockSource("nobitex", "n", 100_000, 99_000, { ageMs: 200_000, stale: true }),
      mockSource("wallex", "w", 102_000, 101_000)
    ],
    [],
    new Date().toISOString()
  );
  const hit = stale.opportunities.find((o) => o.routeKey.startsWith("nobitex->wallex"))!;
  assert.ok(hit.blockedReasons.includes("stale_buy_source"));
  assert.equal(hit.eligibility, "BLOCKED");

  const uncertified = buildOpportunitiesDetailed(
    [mockSource("nobitex", "n", 100_000, 99_500), mockSource("wallex", "w", 101_000, 100_500)],
    [],
    new Date().toISOString(),
    { certStatuses: { nobitex: "LIVE_DEGRADED", wallex: "LIVE_VERIFIED" } }
  );
  const gated = uncertified.opportunities.find((o) => o.routeKey === "nobitex->wallex@5")!;
  assert.ok(gated.blockedReasons.includes("source_not_certified"));
  assert.equal(gated.eligibility, "BLOCKED");
});

await test("unverified account can never be EXECUTABLE_NOW", () => {
  const built = buildOpportunitiesDetailed(
    [
      mockSource("nobitex", "n", 100_000, 99_500),
      mockSource("bitpin", "b", 101_000, 100_500, {
        accountStatus: "unverified",
        eligibilityBase: "ACCOUNT_REQUIRED",
        marketFeeBps: null,
        feeStatus: "unknown"
      })
    ],
    [],
    new Date().toISOString()
  );
  for (const o of built.opportunities) {
    assert.notEqual(o.eligibility, "EXECUTABLE_NOW");
  }
});

/* ── idempotency ──────────────────────────────────────────────────────────── */

await test("idempotency key is stable within an interval bucket", () => {
  const interval = 30_000;
  // Bucket-aligned base so the assertions describe one bucket, not a boundary.
  const t = Math.floor(1_700_000_000_000 / interval) * interval;
  assert.equal(bucketIdempotencyKey(t, interval), bucketIdempotencyKey(t + 5_000, interval));
  assert.notEqual(bucketIdempotencyKey(t, interval), bucketIdempotencyKey(t + 35_000, interval));
  // Two workers waking inside the same bucket derive the same key.
  assert.equal(bucketIdempotencyKey(t + 1, interval), bucketIdempotencyKey(t + 29_999, interval));
  // A different interval must not collide with the same bucket number.
  assert.notEqual(bucketIdempotencyKey(t, interval), bucketIdempotencyKey(t, 60_000));
});

/* ── worker identity / stale lease detection ──────────────────────────────── */

await test("worker id encodes host and pid and round-trips", () => {
  const id = makeWorkerId("inproc");
  const parsed = parseWorkerId(id);
  assert.ok(parsed, `unparseable id: ${id}`);
  assert.equal(parsed!.kind, "inproc");
  assert.equal(parsed!.pid, process.pid);
  assert.equal(parseWorkerId("legacy-worker-name"), null);
});

await test("stale lease detection never displaces a live or foreign holder", () => {
  // Our own live process is not stale.
  assert.equal(isDeadLocalWorker(makeWorkerId("inproc")), false);
  // A pid that cannot exist on this host is stale.
  assert.equal(isDeadLocalWorker(makeWorkerId("worker", 2_147_483_1)), true);
  // Another host is never judged from here.
  assert.equal(isDeadLocalWorker("shadow-worker-someotherhost-1-abc123"), false);
  // Unknown formats are treated as live, so a real holder is never displaced.
  assert.equal(isDeadLocalWorker("manual-1234"), false);
  assert.equal(isDeadLocalWorker(null), false);
});

/* ── transport: timeout, backoff, rate limit ──────────────────────────────── */

type Handler = (url: string, count: number) => { status: number; body: string; delayMs?: number };

async function withServer(handler: Handler, fn: (base: string) => Promise<void>) {
  let count = 0;
  const server: Server = createServer((req, res) => {
    count += 1;
    const r = handler(req.url ?? "/", count);
    const send = () => {
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
    };
    if (r.delayMs) setTimeout(send, r.delayMs);
    else send();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await test("retry with backoff recovers from a 5xx", async () => {
  await withServer(
    (_u, count) =>
      count < 3 ? { status: 500, body: '{"error":"boom"}' } : { status: 200, body: '{"ok":true}' },
    async (base) => {
      const res = await shadowRequest<{ ok: boolean }>(`${base}/book`, {
        timeoutMs: 3_000,
        maxAttempts: 3
      });
      assert.equal(res.data.ok, true);
      assert.equal(res.attempts, 3);
      assert.ok(res.latencyMs >= 0);
    }
  );
});

await test("rate-limit response is surfaced, not swallowed", async () => {
  await withServer(
    () => ({ status: 429, body: '{"error":"slow down"}' }),
    async (base) => {
      await assert.rejects(
        () => shadowRequest(`${base}/book`, { timeoutMs: 2_000, maxAttempts: 2 }),
        (e: unknown) => {
          assert.ok(e instanceof ShadowSourceError);
          assert.equal(e.httpStatus, 429);
          assert.equal(e.rateLimited, true);
          assert.equal(e.attempts, 2);
          return true;
        }
      );
    }
  );
});

await test("a permanent 4xx is not retried", async () => {
  await withServer(
    () => ({ status: 404, body: "not found" }),
    async (base) => {
      await assert.rejects(
        () => shadowRequest(`${base}/missing`, { timeoutMs: 2_000, maxAttempts: 3 }),
        (e: unknown) => {
          assert.ok(e instanceof ShadowSourceError);
          assert.equal(e.attempts, 1, "permanent 4xx must not burn retries");
          return true;
        }
      );
    }
  );
});

await test("per-source timeout aborts a hanging endpoint", async () => {
  await withServer(
    () => ({ status: 200, body: '{"ok":true}', delayMs: 3_000 }),
    async (base) => {
      const started = Date.now();
      await assert.rejects(
        () => shadowRequest(`${base}/slow`, { timeoutMs: 300, maxAttempts: 1 }),
        (e: unknown) => {
          assert.ok(e instanceof ShadowSourceError);
          return true;
        }
      );
      assert.ok(Date.now() - started < 2_500, "must abort well before the server responds");
    }
  );
});

await test("rate-limited snapshot cannot be certified live", () => {
  resetCertifications();
  const snap = snapshotFromResult(
    nobitexCfg,
    baseResult({ rateLimited: true }),
    new Date().toISOString()
  );
  assert.ok(snap.sourceBlockedReasons.includes("rate_limited"));
  assert.equal(certifyFromSnapshot(snap).status, "LIVE_DEGRADED");
});

/* ── dashboard presentation logic ─────────────────────────────────────────── */

await test("every blocked code has a plain-Persian explanation", () => {
  // Any code the engine can emit must be translatable, or the UI would show a
  // raw identifier to a non-technical admin.
  const codes: BlockedReasonCode[] = [
    "fee_unknown",
    "stale_buy_source",
    "stale_sell_source",
    "insufficient_buy_depth",
    "insufficient_sell_depth",
    "account_required",
    "reference_only",
    "source_unhealthy",
    "quote_direction_unverified",
    "market_data_missing",
    "same_venue",
    "non_positive_net",
    "depth_unverified",
    "quote_max_unverified",
    "units_ambiguous",
    "rate_limited",
    "source_not_certified"
  ];
  for (const c of codes) {
    assert.ok(BLOCKED_FA[c], `missing translation for ${c}`);
    assert.ok(BLOCKED_FA[c].short.length > 2, `short label too thin for ${c}`);
    assert.ok(BLOCKED_FA[c].detail.length > 20, `detail too thin for ${c}`);
    assert.notEqual(blockedShort(c), c, `${c} must not surface as a raw code`);
  }
  // Unknown codes degrade to the code itself rather than throwing.
  assert.equal(blockedShort("something_new"), "something_new");
});

await test("collector state reflects the honest situation", () => {
  assert.equal(
    deriveCollectorState({
      observationStatus: "RUNNING",
      workerRunning: true,
      workerStale: false,
      lastSuccessAgeMs: 5_000,
      pollIntervalMs: 30_000
    }),
    "watching"
  );
  assert.equal(
    deriveCollectorState({ observationStatus: "PAUSED", workerRunning: true, workerStale: false }),
    "stopped"
  );
  assert.equal(
    deriveCollectorState({ observationStatus: "RUNNING", workerRunning: false, workerStale: true }),
    "stopped"
  );
  // Worker alive but nothing succeeded for far longer than the interval.
  assert.equal(
    deriveCollectorState({
      observationStatus: "RUNNING",
      workerRunning: true,
      workerStale: false,
      lastSuccessAgeMs: 20 * 60_000,
      pollIntervalMs: 30_000
    }),
    "stale"
  );
  assert.equal(
    deriveCollectorState({
      observationStatus: "DEGRADED",
      workerRunning: true,
      workerStale: false,
      lastSuccessAgeMs: 5_000,
      pollIntervalMs: 30_000
    }),
    "degraded"
  );
  assert.equal(deriveCollectorState({ observationStatus: "COMPLETED" }), "completed");
});

await test("Persian formatting helpers", () => {
  assert.equal(toFaDigits(1234), "۱۲۳۴");
  assert.equal(formatPercentFa(1.2345, 2), "۱٫۲۳٪".replace("٫", "."));
  assert.equal(formatPercentFa(null), "—");
  assert.equal(formatDurationFa(45_000), "۴۵ ثانیه");
  assert.equal(formatDurationFa(3 * 60_000), "۳ دقیقه");
  assert.equal(formatDurationFa(2 * 3_600_000), "۲ ساعت");
  assert.equal(formatDurationFa(26 * 3_600_000), "۱ روز و ۲ ساعت");
  assert.equal(formatDurationFa(null), "—");
});

await test("freshness buckets follow the poll interval", () => {
  assert.equal(freshnessLabel(10_000, 30_000).tone, "good");
  assert.equal(freshnessLabel(90_000, 30_000).tone, "warn");
  assert.equal(freshnessLabel(10 * 60_000, 30_000).tone, "danger");
  assert.equal(freshnessLabel(null, 30_000).label, "نامشخص");
});

await test("account-opening priority needs evidence", () => {
  assert.equal(accountPriorityLabel(null).label, "بدون شواهد کافی");
  assert.equal(accountPriorityLabel(0).label, "بدون شواهد کافی");
  assert.equal(accountPriorityLabel(0.6).label, "اولویت بالا");
  assert.equal(accountPriorityLabel(0.3).label, "اولویت متوسط");
  assert.equal(accountPriorityLabel(0.05).label, "اولویت پایین");
});

await test("permanent trial-mode warning text is exact", () => {
  assert.equal(SHADOW_WARNING_FA, "حالت آزمایشی — هیچ سفارش یا انتقال واقعی انجام نمی‌شود");
  const view = readFileSync(new URL("../src/components/ShadowArbitrageView.tsx", import.meta.url), "utf8");
  assert.ok(view.includes("SHADOW_WARNING_FA"), "the dashboard must render the warning");
  // It must not be conditional on data or state.
  assert.ok(/className="sa-warning"/.test(view));
});

/* ── storage volume ───────────────────────────────────────────────────────── */

await test("14-day storage estimate stays in the designed budget", () => {
  const sources = 9;
  const intervalSec = 30;
  const days = 14;
  const cycles = (24 * 3600 * days) / intervalSec;
  assert.equal(cycles, 40_320);
  const snapshots = cycles * sources;
  assert.equal(snapshots, 362_880);
  // Aggregates are bounded by routes × sizes × days, not by cycle count.
  const routeMetricRows = sources * (sources - 1) * 4 * days;
  assert.equal(routeMetricRows, 4_032);
  assert.ok(snapshots < 5_000_000);
  // Naively persisting every pair every cycle is what this design avoids:
  assert.ok(cycles * sources * (sources - 1) * 4 > 10_000_000);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
