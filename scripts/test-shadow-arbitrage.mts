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
  FEE_REVERIFY_DAYS,
  buildAllReadiness,
  venueUsableForNetProfit
} from "../src/lib/shadowArbitrage/accounts.ts";
import {
  DEFAULT_CAPITAL_TOMAN,
  buildOptimizedPlan,
  classifyAllVenues,
  classifyVenueForCapital,
  estimateMonthlyRebalance,
  simulateCapitalPlan,
  smallestFundableSizeUsdt,
  evaluateRecommendation,
  planFingerprint,
  readinessFingerprint,
  splitIntegerByWeights,
  usdtValueToman,
  validateCapitalPlan,
  type ApprovalRecord,
  type CapitalPlanInput,
  type RouteEvidence,
  type VenueCapitalState
} from "../src/lib/shadowArbitrage/capital.ts";
import {
  PAPER_FEE_SETTLEMENT,
  applyFill,
  microsToUsdt,
  planFill,
  portfolioValueToman,
  reconcilePaperLedgers,
  settlementCoherent,
  settlementFor,
  settlementUsable,
  usdtToMicros,
  type FillPlan,
  type SideSettlement,
  type VenueBalance
} from "../src/lib/shadowArbitrage/paper/broker.ts";
import {
  balancesFromAllocations,
  evaluateCycle,
  rankPricedCandidates,
  resolveMarkPriceToman,
  selectBestPerRoute,
  type PricedCandidate
} from "../src/lib/shadowArbitrage/paper/engine.ts";
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
  COLLECTOR_STATE_FA,
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
  // Session RUNNING but nothing is collecting → offline, not "stopped".
  assert.equal(
    deriveCollectorState({ observationStatus: "RUNNING", workerRunning: false, workerStale: true }),
    "offline"
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
  // Offline hides the pause action in the UI.
  assert.equal(COLLECTOR_STATE_FA.offline, "جمع‌آورنده آفلاین");
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

/* ── Phase 4: account and fee readiness ───────────────────────────────────── */

await test("account gating: only verified accounts with known fees are usable", () => {
  const all = buildAllReadiness([]);
  assert.equal(all.length, 9);
  const verified = all.filter((v) => v.accountState === "VERIFIED").map((v) => v.sourceId).sort();
  assert.deepEqual(verified, ["nobitex", "tabdeal", "wallex"]);
  const needs = all.filter((v) => v.accountState === "NEEDS_ACCOUNT").map((v) => v.sourceId).sort();
  assert.deepEqual(needs, ["abantether", "bit24", "bitpin", "ramzinex", "tetherland"]);
  assert.equal(all.find((v) => v.sourceId === "arzinja")!.accountState, "REFERENCE_ONLY");

  // Reference-only and account-less venues can never back net profit.
  for (const v of all) {
    if (v.accountState !== "VERIFIED") assert.equal(venueUsableForNetProfit(v), false);
  }
});

await test("fee provenance is never invented", () => {
  const all = buildAllReadiness([]);
  for (const v of all) {
    if (v.feeProvenance === "UNKNOWN") {
      assert.equal(v.takerFeeBps, null, `${v.sourceId} must not carry a fee it cannot source`);
      assert.ok(v.blockingReason, `${v.sourceId} must explain why it is blocked`);
    } else {
      assert.ok(v.takerFeeBps !== null);
    }
    // A provisional value must never be presented as official.
    if (v.sourceId === "bitpin") assert.equal(v.feeProvenance, "UNKNOWN");
  }
});

await test("unknown fee blocks a venue from net-positive routes", () => {
  const unknown = buildAllReadiness([]).find((v) => v.feeProvenance === "UNKNOWN")!;
  assert.equal(venueUsableForNetProfit(unknown), false);
  // And the engine agrees: an unknown fee marks the route fee_unknown.
  const econ = computeRouteEconomics({
    buySourceId: unknown.sourceId,
    sellSourceId: "nobitex",
    sizeUsdt: 5,
    buyVwapToman: 100_000,
    sellVwapToman: 110_000
  });
  assert.equal(econ.feeUnknown, true);
  assert.ok(econ.blocked.includes("fee_unknown"));
});

await test("admin-confirmed fee overrides provisional and records provenance", () => {
  const confirmedAt = new Date().toISOString();
  const [v] = buildAllReadiness([
    {
      sourceId: "nobitex",
      takerFeeBps: 13,
      feeTier: "VIP 2",
      sourceUrl: "https://nobitex.ir/fees/",
      confirmedBy: "admin",
      confirmedAt,
      note: null
    }
  ]).filter((x) => x.sourceId === "nobitex");
  assert.equal(v!.takerFeeBps, 13);
  assert.equal(v!.feeProvenance, "ADMIN_CONFIRMED");
  assert.equal(v!.feeTier, "VIP 2");
  assert.equal(v!.feeStale, false);
  assert.equal(venueUsableForNetProfit(v!), true);
});

await test("stale fee evidence requires re-verification and blocks usability", () => {
  const old = new Date(Date.now() - (FEE_REVERIFY_DAYS + 5) * 86_400_000).toISOString();
  const [v] = buildAllReadiness([
    {
      sourceId: "wallex",
      takerFeeBps: 20,
      feeTier: null,
      sourceUrl: null,
      confirmedBy: "admin",
      confirmedAt: old,
      note: null
    }
  ]).filter((x) => x.sourceId === "wallex");
  assert.equal(v!.feeStale, true);
  assert.ok(v!.requiredAction.includes("بازبینی"));
  assert.equal(venueUsableForNetProfit(v!), false);
});

await test("Phase 4 surface excludes OMPFinex and never accepts credentials", () => {
  const all = buildAllReadiness([]);
  assert.equal(all.some((v) => /omp/i.test(v.sourceId) || /omp/i.test(v.nameFa)), false);
  const route = readFileSync(
    new URL("../app/api/shadow-arbitrage/accounts/route.ts", import.meta.url),
    "utf8"
  );
  assert.ok(route.includes("requireAdminSession"), "accounts API must be admin-only");
  assert.ok(route.includes("forbidden_field"), "accounts API must reject credential fields");
  for (const secret of ["apiKey", "secret", "password", "passphrase"]) {
    assert.ok(route.includes(secret), `must explicitly refuse ${secret}`);
  }
  const ui = readFileSync(
    new URL("../src/components/shadowArbitrage/AccountReadiness.tsx", import.meta.url),
    "utf8"
  );
  assert.equal(/ompfinex/i.test(ui), false);
});


/* ── Phase 5 — capital allocation simulator (deterministic accounting) ────── */

// Fixed clock so fee-freshness never drifts the expectations over time.
const CAP_NOW = Date.parse("2026-07-30T00:00:00Z");
const CAP_PRICE = 100_000;
const TARGET_14D = 14 * 24 * 60 * 60_000;
const capReadiness = () => buildAllReadiness([], CAP_NOW);

const capPlan = (allocations: CapitalPlanInput["allocations"], total = 50_000_000): CapitalPlanInput => ({
  totalCapitalToman: total,
  valuationPriceToman: CAP_PRICE,
  allocations,
  mode: "MANUAL"
});

const CAP_ROUTES: RouteEvidence[] = [
  {
    routeKey: "nobitex->wallex@25",
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 25,
    samples: 100,
    positiveNetSamples: 40,
    positiveRawSamples: 80,
    feeUnknown: false
  },
  {
    routeKey: "wallex->nobitex@25",
    buySourceId: "wallex",
    sellSourceId: "nobitex",
    sizeUsdt: 25,
    samples: 50,
    positiveNetSamples: 10,
    positiveRawSamples: 30,
    feeUnknown: false
  },
  {
    routeKey: "bitpin->nobitex@25",
    buySourceId: "bitpin",
    sellSourceId: "nobitex",
    sizeUsdt: 25,
    samples: 30,
    positiveNetSamples: 0,
    positiveRawSamples: 20,
    feeUnknown: true
  }
];

const CAP_ALLOC: CapitalPlanInput["allocations"] = [
  { sourceId: "nobitex", irtToman: 10_000_000, usdtUnits: 50 },
  { sourceId: "wallex", irtToman: 5_000_000, usdtUnits: 100 }
];

const simulateCap = (plan: CapitalPlanInput, over: Partial<Parameters<typeof simulateCapitalPlan>[0]> = {}) =>
  simulateCapitalPlan({
    plan,
    readiness: capReadiness(),
    routes: CAP_ROUTES,
    observation: {
      status: "RUNNING",
      successCoveragePercent: 99,
      elapsedMs: 3 * 24 * 60 * 60_000,
      targetDurationMs: TARGET_14D
    },
    observedWindowMs: 14 * 24 * 60 * 60_000,
    perTransferCostToman: null,
    perTransferCostConfirmed: false,
    ...over
  });

await test("Phase 5 executable set is exactly the three verified venues", () => {
  const states = classifyAllVenues(capReadiness());
  const executable = states.filter((s) => s.executable).map((s) => s.sourceId).sort();
  assert.deepEqual(executable, ["nobitex", "tabdeal", "wallex"]);
  assert.equal(states.find((s) => s.sourceId === "arzinja")!.capitalClass, "REFERENCE_ONLY");
  for (const id of ["bitpin", "abantether", "ramzinex", "tetherland", "bit24"]) {
    const s = states.find((x) => x.sourceId === id)!;
    assert.equal(s.capitalClass, "WHATIF_DISABLED");
    assert.ok(s.blockingReason, `${id} must state why it is disabled`);
  }
  assert.equal(states.some((s) => /omp/i.test(s.sourceId) || /omp/i.test(s.nameFa)), false);
});

await test("Phase 5 stale fee evidence removes a venue from the executable set", () => {
  const stale = new Date(CAP_NOW - 200 * 86_400_000).toISOString();
  const readiness = buildAllReadiness(
    [
      {
        sourceId: "nobitex",
        takerFeeBps: 20,
        feeTier: null,
        sourceUrl: null,
        confirmedBy: "admin",
        confirmedAt: stale,
        note: null
      }
    ],
    CAP_NOW
  );
  const nobitex = classifyVenueForCapital(readiness.find((v) => v.sourceId === "nobitex")!);
  assert.equal(nobitex.feeStale, true);
  assert.equal(nobitex.executable, false);
  assert.equal(nobitex.capitalClass, "WHATIF_DISABLED");
});

await test("Phase 5 portfolio conservation holds to the toman", () => {
  const sim = simulateCap(capPlan(CAP_ALLOC));
  assert.equal(sim.ok, true);
  assert.equal(sim.allocatedToman, 30_000_000);
  assert.equal(sim.unusedReserveToman, 20_000_000);
  assert.equal(sim.allocatedToman + sim.unusedReserveToman, sim.totalCapitalToman);
  assert.equal(sim.conservationResidualToman, 0);
  const summed = sim.venues.reduce((s, v) => s + v.irtToman + v.usdtValueToman, 0);
  assert.equal(summed, sim.allocatedToman);
  assert.equal(usdtValueToman(50, CAP_PRICE), 5_000_000);
});

await test("Phase 5 rejects negative balances, duplicates and unknown venues", () => {
  const neg = validateCapitalPlan(capPlan([{ sourceId: "nobitex", irtToman: -1, usdtUnits: 0 }]));
  assert.equal(neg.ok, false);
  assert.ok(neg.violations.some((v) => v.code === "negative_irt"));

  const negUsdt = validateCapitalPlan(capPlan([{ sourceId: "nobitex", irtToman: 0, usdtUnits: -5 }]));
  assert.ok(negUsdt.violations.some((v) => v.code === "negative_usdt"));

  const dup = validateCapitalPlan(
    capPlan([
      { sourceId: "nobitex", irtToman: 1_000, usdtUnits: 0 },
      { sourceId: "nobitex", irtToman: 1_000, usdtUnits: 0 }
    ])
  );
  assert.ok(dup.violations.some((v) => v.code === "duplicate_venue"));

  // OMPFinex must never be addressable from the Shadow simulator.
  const omp = validateCapitalPlan(
    capPlan([{ sourceId: "ompfinex" as never, irtToman: 1_000, usdtUnits: 0 }])
  );
  assert.equal(omp.ok, false);
  assert.ok(omp.violations.some((v) => v.code === "unknown_venue"));
});

await test("Phase 5 refuses to over-allocate the portfolio", () => {
  const sim = simulateCap(
    capPlan([{ sourceId: "nobitex", irtToman: 40_000_000, usdtUnits: 200 }], 50_000_000)
  );
  assert.equal(sim.ok, false);
  assert.ok(sim.violations.some((v) => v.code === "over_allocated"));
  // A rejected plan must not emit metrics that look authoritative.
  assert.equal(sim.concentration.status, "BLOCKED");
  assert.equal(sim.opportunityCoveragePercent.status, "BLOCKED");
  assert.equal(sim.venues.length, 0);
});

await test("Phase 5 integer weight split conserves the total exactly", () => {
  const parts = splitIntegerByWeights(50_000_000, [1, 1, 1]);
  assert.equal(parts.reduce((a, b) => a + b, 0), 50_000_000);
  assert.deepEqual(splitIntegerByWeights(10, [1, 1, 1]), [4, 3, 3]);
  assert.deepEqual(splitIntegerByWeights(100, [0, 0]), [0, 0]);
  assert.deepEqual(splitIntegerByWeights(0, [3, 1]), [0, 0]);
  // Deterministic: repeated calls give an identical split.
  assert.deepEqual(splitIntegerByWeights(7, [5, 3, 1]), splitIntegerByWeights(7, [5, 3, 1]));
});

await test("Phase 5 optimized plan conserves capital and only funds executable venues", () => {
  const opt = buildOptimizedPlan({
    totalCapitalToman: DEFAULT_CAPITAL_TOMAN,
    valuationPriceToman: CAP_PRICE,
    readiness: capReadiness(),
    routes: CAP_ROUTES
  });
  assert.equal(opt.status, "PROVISIONAL");
  assert.equal(opt.basis, "OBSERVED_NET_POSITIVE");
  const ids = opt.plan.allocations.map((a) => a.sourceId).sort();
  assert.deepEqual(ids, ["nobitex", "tabdeal", "wallex"]);
  for (const a of opt.plan.allocations) {
    assert.ok(a.irtToman >= 0 && a.usdtUnits >= 0, "no negative virtual balance");
  }
  const allocated = opt.plan.allocations.reduce(
    (s, a) => s + a.irtToman + usdtValueToman(a.usdtUnits, CAP_PRICE),
    0
  );
  assert.equal(allocated, DEFAULT_CAPITAL_TOMAN, "optimizer must allocate exactly the capital");

  const sim = simulateCap(opt.plan);
  assert.equal(sim.conservationResidualToman, 0);
  assert.equal(sim.unusedReserveToman, 0);
});

await test("Phase 5 optimizer honours an explicit reserve and never invents one", () => {
  const withReserve = buildOptimizedPlan({
    totalCapitalToman: 50_000_000,
    valuationPriceToman: CAP_PRICE,
    readiness: capReadiness(),
    routes: CAP_ROUTES,
    reservePercent: 20
  });
  const allocated = withReserve.plan.allocations.reduce(
    (s, a) => s + a.irtToman + usdtValueToman(a.usdtUnits, CAP_PRICE),
    0
  );
  assert.equal(allocated, 40_000_000);
  const sim = simulateCap(withReserve.plan);
  assert.equal(sim.unusedReserveToman, 10_000_000);
  assert.equal(sim.conservationResidualToman, 0);
});

await test("Phase 5 optimizer returns nothing when no venue is executable", () => {
  const stale = new Date(CAP_NOW - 400 * 86_400_000).toISOString();
  const readiness = buildAllReadiness(
    ["nobitex", "wallex", "tabdeal"].map((sourceId) => ({
      sourceId,
      takerFeeBps: 20,
      feeTier: null,
      sourceUrl: null,
      confirmedBy: "admin",
      confirmedAt: stale,
      note: null
    })),
    CAP_NOW
  );
  const opt = buildOptimizedPlan({
    totalCapitalToman: 50_000_000,
    valuationPriceToman: CAP_PRICE,
    readiness,
    routes: CAP_ROUTES
  });
  assert.equal(opt.basis, "NONE");
  assert.deepEqual(opt.plan.allocations, []);
  assert.equal(opt.status, "PROVISIONAL");
});

await test("Phase 5 opportunity coverage counts only routes the allocation can fund", () => {
  const sim = simulateCap(capPlan(CAP_ALLOC));
  assert.equal(sim.coverage.observedRouteSamples, 180);
  assert.equal(sim.coverage.executableRouteSamples, 150);
  assert.equal(sim.coverage.fundedRouteSamples, 150);
  assert.equal(sim.opportunityCoveragePercent.status, "KNOWN");
  assert.equal(
    (sim.opportunityCoveragePercent as { status: "KNOWN"; value: number }).value,
    83.33
  );
  assert.equal((sim.coverage.fundedOfExecutablePercent as { value: number }).value, 100);
  // The fee-unknown route is reported as unfunded, never silently dropped.
  assert.ok(sim.coverage.unfundedTopReasons.some((r) => r.samples === 30));
});

await test("Phase 5 thin allocation cannot fund a route it has no inventory for", () => {
  // Enough toman to buy, but no USDT anywhere to deliver the sell leg.
  const sim = simulateCap(capPlan([{ sourceId: "nobitex", irtToman: 10_000_000, usdtUnits: 0 }]));
  assert.equal(sim.coverage.fundedRouteSamples, 0);
  assert.equal((sim.opportunityCoveragePercent as { value: number }).value, 0);
  assert.ok(
    sim.coverage.unfundedTopReasons.some((r) => r.reasonFa.includes("تتری")),
    "must name the missing USDT leg"
  );
  assert.equal(smallestFundableSizeUsdt(sim.venues, CAP_PRICE), null);
});

await test("Phase 5 coverage is UNKNOWN when the observation has no route data", () => {
  const sim = simulateCap(capPlan(CAP_ALLOC), { routes: [] });
  assert.equal(sim.opportunityCoveragePercent.status, "UNKNOWN");
  assert.equal(sim.coverage.fundedOfExecutablePercent.status, "UNKNOWN");
  assert.ok(sim.notesFa.some((n) => n.includes("پوشش فرصت‌ها")));
});

await test("Phase 5 monthly rebalancing cost stays UNKNOWN without a confirmed transfer cost", () => {
  const sim = simulateCap(capPlan(CAP_ALLOC));
  assert.equal(sim.rebalance.costToman.status, "UNKNOWN");
  assert.equal(sim.rebalance.expectedMonthlyRebalances.status, "KNOWN");
  assert.ok(sim.notesFa.some((n) => n.includes("هزینهٔ بازتوازن")));

  // Even a provisional zero must not become a printed number.
  const provisional = estimateMonthlyRebalance({
    perTransferCostToman: 0,
    perTransferCostConfirmed: false,
    observedWindowMs: 14 * 24 * 60 * 60_000,
    fundedSamples: 150
  });
  assert.equal(provisional.costToman.status, "UNKNOWN");
});

await test("Phase 5 monthly rebalancing cost is computed once a cost is confirmed", () => {
  const est = estimateMonthlyRebalance({
    perTransferCostToman: 1_000,
    perTransferCostConfirmed: true,
    observedWindowMs: 14 * 24 * 60 * 60_000,
    fundedSamples: 150
  });
  assert.equal(est.expectedMonthlyRebalances.status, "KNOWN");
  assert.equal((est.expectedMonthlyRebalances as { value: number }).value, 321);
  assert.equal((est.costToman as { value: number }).value, 321_000);

  // No observation window means no extrapolation, so no cost either.
  const noWindow = estimateMonthlyRebalance({
    perTransferCostToman: 1_000,
    perTransferCostConfirmed: true,
    observedWindowMs: 0,
    fundedSamples: 150
  });
  assert.equal(noWindow.costToman.status, "UNKNOWN");
});

await test("Phase 5 utilization and concentration ignore non-executable venues correctly", () => {
  const sim = simulateCap(
    capPlan([
      { sourceId: "nobitex", irtToman: 10_000_000, usdtUnits: 50 },
      { sourceId: "wallex", irtToman: 5_000_000, usdtUnits: 100 },
      { sourceId: "bitpin", irtToman: 10_000_000, usdtUnits: 0 }
    ])
  );
  assert.equal(sim.allocatedToman, 40_000_000);
  assert.equal(sim.idleOnDisabledVenuesToman, 10_000_000);
  // 30M of 50M sits on executable venues.
  assert.equal(sim.capitalUtilizationPercent, 60);
  assert.equal(sim.unusedReserveToman, 10_000_000);
  assert.equal(sim.concentration.status, "KNOWN");
  const c = (sim.concentration as { value: { hhi: number; venueCount: number } }).value;
  assert.equal(c.venueCount, 3);
  // Three equal-ish shares must not read as a concentrated book.
  assert.ok(c.hhi > 0 && c.hhi <= 10_000);
  assert.ok(sim.notesFa.some((n) => n.includes("اجراپذیر نیستند")));
});

await test("Phase 5 concentration is UNKNOWN when nothing is allocated", () => {
  const sim = simulateCap(capPlan([]));
  assert.equal(sim.ok, true);
  assert.equal(sim.concentration.status, "UNKNOWN");
  assert.equal(sim.unusedReserveToman, 50_000_000);
  assert.equal(sim.capitalUtilizationPercent, 0);
  assert.equal(sim.conservationResidualToman, 0);
});

await test("Phase 5 gate: below 14 days the recommendation is PROVISIONAL and locked", () => {
  const sim = simulateCap(capPlan(CAP_ALLOC), {
    observation: {
      status: "RUNNING",
      successCoveragePercent: 100,
      elapsedMs: TARGET_14D - 1,
      targetDurationMs: TARGET_14D
    }
  });
  const r = sim.recommendation;
  assert.equal(r.status, "PROVISIONAL");
  assert.equal(r.locked, true);
  assert.equal(r.daysGatePassed, false);
  assert.equal(r.coverageGatePassed, true);
  assert.equal(r.eligibleForApproval, false);
  assert.ok(r.reasonFa.includes("دورهٔ مشاهده کامل نشده"));
});

await test("Phase 5 gate: at exactly 14 days with 80% it unlocks for admin review", () => {
  const sim = simulateCap(capPlan(CAP_ALLOC), {
    observation: {
      status: "COMPLETED",
      successCoveragePercent: 80,
      elapsedMs: TARGET_14D,
      targetDurationMs: TARGET_14D
    }
  });
  const r = sim.recommendation;
  assert.equal(r.daysGatePassed, true);
  assert.equal(r.coverageGatePassed, true);
  assert.equal(r.readinessGatePassed, true);
  assert.equal(r.status, "READY_FOR_ADMIN_REVIEW");
  assert.equal(r.locked, false, "an unlocked recommendation is not an approved one");
  assert.equal(r.approval, null);
  assert.equal(r.eligibleForApproval, true);
  assert.equal(r.executesOrders, false);
});

await test("Phase 5 gate: 79.99% coverage is below the threshold, 80% is not", () => {
  const at = (successCoveragePercent: number) =>
    simulateCap(capPlan(CAP_ALLOC), {
      observation: {
        status: "COMPLETED",
        successCoveragePercent,
        elapsedMs: TARGET_14D,
        targetDurationMs: TARGET_14D
      }
    }).recommendation;

  const below = at(79.99);
  assert.equal(below.coverageGatePassed, false);
  assert.equal(below.status, "PROVISIONAL");
  assert.equal(below.locked, true);
  assert.ok(below.reasonFa.includes("پوشش موفق"));

  const exact = at(80);
  assert.equal(exact.coverageGatePassed, true);
  assert.equal(exact.status, "READY_FOR_ADMIN_REVIEW");
  assert.equal(exact.locked, false);
});

await test("Phase 5 gate: a stale or unknown fee keeps the recommendation locked", () => {
  const stale = new Date(CAP_NOW - 200 * 86_400_000).toISOString();
  const staleReadiness = buildAllReadiness(
    ["nobitex", "wallex"].map((sourceId) => ({
      sourceId,
      takerFeeBps: 20,
      feeTier: null,
      sourceUrl: null,
      confirmedBy: "admin",
      confirmedAt: stale,
      note: null
    })),
    CAP_NOW
  );
  const sim = simulateCap(capPlan(CAP_ALLOC), {
    readiness: staleReadiness,
    observation: {
      status: "COMPLETED",
      successCoveragePercent: 100,
      elapsedMs: TARGET_14D,
      targetDurationMs: TARGET_14D
    }
  });
  const r = sim.recommendation;
  assert.equal(r.observationGatePassed, true, "time and coverage are fine");
  assert.equal(r.readinessGatePassed, false, "but the fees are stale");
  assert.equal(r.status, "PROVISIONAL");
  assert.equal(r.locked, true);
  assert.equal(r.eligibleForApproval, false);
  assert.ok(r.reasonFa.includes("غیراجراپذیر"));

  // A venue whose fee was never confirmed is equally disqualifying.
  const unknownFeePlan = capPlan([{ sourceId: "bitpin", irtToman: 10_000_000, usdtUnits: 50 }]);
  const unknownSim = simulateCap(unknownFeePlan, {
    observation: {
      status: "COMPLETED",
      successCoveragePercent: 100,
      elapsedMs: TARGET_14D,
      targetDurationMs: TARGET_14D
    }
  });
  assert.equal(unknownSim.recommendation.readinessGatePassed, false);
  assert.equal(unknownSim.recommendation.status, "PROVISIONAL");
  assert.equal(unknownSim.recommendation.locked, true);
});

await test("Phase 5 approval: admin confirmation moves the plan to APPROVED_SIMULATION_PLAN", () => {
  const plan = capPlan(CAP_ALLOC);
  const states: VenueCapitalState[] = classifyAllVenues(capReadiness());
  const gate = {
    status: "COMPLETED",
    successCoveragePercent: 95,
    elapsedMs: TARGET_14D + 3_600_000,
    targetDurationMs: TARGET_14D
  };

  const beforeApproval = evaluateRecommendation({ plan, states, observation: gate, approval: null });
  assert.equal(beforeApproval.status, "READY_FOR_ADMIN_REVIEW");

  const approval: ApprovalRecord = {
    approvedBy: "admin",
    approvedAt: new Date(CAP_NOW).toISOString(),
    readinessFingerprint: readinessFingerprint(states),
    planFingerprint: planFingerprint(plan)
  };
  const approved = evaluateRecommendation({ plan, states, observation: gate, approval });
  assert.equal(approved.status, "APPROVED_SIMULATION_PLAN");
  assert.equal(approved.locked, false);
  assert.equal(approved.approval?.approvedBy, "admin");
  assert.equal(approved.invalidationReasonFa, null);
  // Approval is a decision about a simulation, never an execution.
  assert.equal(approved.executesOrders, false);
  assert.ok(approved.reasonFa.includes("هیچ سفارشی"));

  // The approval covers exactly this allocation, not a different one.
  const changedPlan = capPlan([
    { sourceId: "nobitex", irtToman: 12_000_000, usdtUnits: 50 },
    { sourceId: "wallex", irtToman: 3_000_000, usdtUnits: 100 }
  ]);
  const other = evaluateRecommendation({
    plan: changedPlan,
    states,
    observation: gate,
    approval
  });
  assert.equal(other.status, "READY_FOR_ADMIN_REVIEW");
  assert.ok(other.reasonFa.includes("تأیید تازه"));
});

await test("Phase 5 approval is invalidated when fee or account readiness changes", () => {
  const plan = capPlan(CAP_ALLOC);
  const states = classifyAllVenues(capReadiness());
  const gate = {
    status: "COMPLETED",
    successCoveragePercent: 95,
    elapsedMs: TARGET_14D,
    targetDurationMs: TARGET_14D
  };
  const approval: ApprovalRecord = {
    approvedBy: "admin",
    approvedAt: new Date(CAP_NOW).toISOString(),
    readinessFingerprint: readinessFingerprint(states),
    planFingerprint: planFingerprint(plan)
  };
  assert.equal(
    evaluateRecommendation({ plan, states, observation: gate, approval }).status,
    "APPROVED_SIMULATION_PLAN"
  );

  // The desk's fee evidence goes stale after the approval was granted.
  const stale = new Date(CAP_NOW - 200 * 86_400_000).toISOString();
  const changedStates = classifyAllVenues(
    buildAllReadiness(
      [
        {
          sourceId: "nobitex",
          takerFeeBps: 20,
          feeTier: null,
          sourceUrl: null,
          confirmedBy: "admin",
          confirmedAt: stale,
          note: null
        }
      ],
      CAP_NOW
    )
  );
  assert.notEqual(readinessFingerprint(changedStates), approval.readinessFingerprint);

  const invalidated = evaluateRecommendation({
    plan,
    states: changedStates,
    observation: gate,
    approval
  });
  assert.equal(invalidated.status, "PROVISIONAL");
  assert.equal(invalidated.locked, true);
  assert.equal(invalidated.approval, null);
  assert.ok(invalidated.invalidationReasonFa?.includes("باطل"));

  // Losing the observation gate invalidates an approval too.
  const lostGate = evaluateRecommendation({
    plan,
    states,
    observation: { ...gate, successCoveragePercent: 40 },
    approval
  });
  assert.equal(lostGate.status, "PROVISIONAL");
  assert.equal(lostGate.locked, true);
  assert.ok(lostGate.invalidationReasonFa);
});

await test("Phase 5 simulation is deterministic for identical inputs", () => {
  const a = JSON.stringify(simulateCap(capPlan(CAP_ALLOC)));
  const b = JSON.stringify(simulateCap(capPlan(CAP_ALLOC)));
  assert.equal(a, b);
  const o1 = JSON.stringify(
    buildOptimizedPlan({
      totalCapitalToman: 50_000_000,
      valuationPriceToman: CAP_PRICE,
      readiness: capReadiness(),
      routes: CAP_ROUTES
    })
  );
  const o2 = JSON.stringify(
    buildOptimizedPlan({
      totalCapitalToman: 50_000_000,
      valuationPriceToman: CAP_PRICE,
      readiness: capReadiness(),
      routes: CAP_ROUTES
    })
  );
  assert.equal(o1, o2);
});

await test("Phase 5 surface is admin-only, credential-free and has no execution path", () => {
  const route = readFileSync(
    new URL("../app/api/shadow-arbitrage/capital/route.ts", import.meta.url),
    "utf8"
  );
  assert.ok(route.includes("requireAdminSession"), "capital API must be admin-only");
  assert.ok(route.includes("forbidden_field"), "capital API must reject credential fields");
  for (const secret of ["apiKey", "secret", "password", "passphrase", "privateKey"]) {
    assert.ok(route.includes(secret), `must explicitly refuse ${secret}`);
  }
  // Phase 6 territory: no order placement or paper execution may exist yet.
  const forbiddenTerms = [
    "placeOrder",
    "submitOrder",
    "createOrder",
    "paperExecute",
    "withdraw",
    "deposit",
    "transferFunds"
  ];
  for (const term of forbiddenTerms) {
    assert.equal(route.includes(term), false, `capital API must not contain ${term}`);
  }
  assert.equal(/ompfinex/i.test(route), false);

  const engine = readFileSync(
    new URL("../src/lib/shadowArbitrage/capital.ts", import.meta.url),
    "utf8"
  );
  assert.equal(/ompfinex/i.test(engine.replace(/OMPFinex is intentionally absent[^\n]*/gi, "")), false);

  const ui = readFileSync(
    new URL("../src/components/shadowArbitrage/CapitalSimulator.tsx", import.meta.url),
    "utf8"
  );
  assert.equal(/ompfinex/i.test(ui), false);
  assert.ok(ui.includes("موجودی‌ها مجازی‌اند"), "UI must state the balances are virtual");
});


/* ── Phase 6 — paper execution engine ────────────────────────────────────── */

const PX = 100_000;
const paperReadiness = () => classifyAllVenues(buildAllReadiness([], CAP_NOW));

function paperBalances(over: Partial<Record<string, [number, number]>> = {}): VenueBalance[] {
  const base: Record<string, [number, number]> = {
    nobitex: [20_000_000, 100],
    wallex: [20_000_000, 100],
    tabdeal: [10_000_000, 50],
    ...over
  };
  return Object.entries(base).map(([sourceId, [irt, usdt]]) => ({
    sourceId: sourceId as ShadowSourceId,
    irtToman: irt,
    usdtMicros: usdtToMicros(usdt)
  }));
}

function paperOpportunity(over: Partial<ShadowOpportunity> = {}): ShadowOpportunity {
  const now = new Date(CAP_NOW).toISOString();
  const size = (over.sizeUsdt ?? 25) as 5 | 10 | 20 | 25;
  return {
    id: over.id ?? `lc-${over.routeKey ?? "nobitex->wallex@25"}`,
    routeKey: over.routeKey ?? `nobitex->wallex@${size}`,
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    buySourceName: "نوبیتکس",
    sellSourceName: "والکس",
    sizeUsdt: size,
    buyVwapToman: 100_000,
    sellVwapToman: 102_000,
    rawSpreadPercent: 2,
    buyFeeToman: 0,
    sellFeeToman: 0,
    buyFeeBps: 25,
    sellFeeBps: 35,
    totalFeePercent: 0.6,
    slippageBufferToman: 1_000,
    rebalanceCostToman: 0,
    netProfitToman: 30_000,
    netEdgePercent: 1.2,
    buyCostToman: 2_500_000,
    sellProceedsToman: 2_550_000,
    eligibility: "EXECUTABLE_NOW",
    blockedReasons: [],
    firstSeenAt: now,
    lastSeenAt: now,
    endedAt: null,
    durationMs: 0,
    maxNetEdgePercent: 1.2,
    maxNetProfitToman: 30_000,
    maxRawSpreadPercent: 2,
    feeUnknown: false,
    observationCount: 1,
    isActive: true,
    buyAgeMs: 0,
    sellAgeMs: 0,
    ...over
  };
}

const paperSources = (over: Partial<Record<string, Partial<NormalizedSourceSnapshot>>> = {}) => [
  mockSource("nobitex", "نوبیتکس", 100_000, 99_000, over.nobitex),
  mockSource("wallex", "والکس", 103_000, 102_000, over.wallex),
  mockSource("tabdeal", "تبدیل", 101_000, 100_500, over.tabdeal)
];

const BUY_SETTLEMENT: SideSettlement = {
  feeAsset: "IRT",
  debitMode: "ADD_TO_DEBIT",
  provenance: "ADMIN_CONFIRMED"
};
const SELL_SETTLEMENT: SideSettlement = {
  feeAsset: "USDT",
  debitMode: "ADD_TO_DEBIT",
  provenance: "ADMIN_CONFIRMED"
};

function confirmedFill(over: Partial<Parameters<typeof planFill>[0]> = {}) {
  return planFill({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 25,
    buyVwapToman: 100_000,
    sellVwapToman: 102_000,
    buyFeeBps: 25,
    sellFeeBps: 35,
    buySettlement: BUY_SETTLEMENT,
    sellSettlement: SELL_SETTLEMENT,
    markPriceToman: 100_000,
    slippageBufferToman: 1_000,
    ...over
  });
}

await test("Phase 6 buy settles the fee in IRT and credits the full quantity", () => {
  const plan = confirmedFill();
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  // 25 × 100,000 = 2,500,000 toman; 0.25% = 6,250 toman, added to the debit.
  assert.equal(plan.buyLeg.settlement.feeAsset, "IRT");
  assert.equal(plan.buyLeg.settlement.debitMode, "ADD_TO_DEBIT");
  assert.equal(plan.buyLeg.settlement.provenance, "ADMIN_CONFIRMED");
  assert.equal(plan.buyLeg.notionalToman, 2_500_000);
  assert.equal(plan.buyLeg.feeToman, 6_250);
  assert.equal(plan.buyLeg.feeUsdtMicros, 0, "the buy fee is never taken in USDT");
  assert.equal(plan.buyLeg.deltaIrtToman, -2_506_250, "IRT debit is cost plus fee");
  assert.equal(plan.buyLeg.deltaUsdtMicros, usdtToMicros(25), "full purchased quantity is credited");
});

await test("Phase 6 sell settles the fee in USDT and credits the full proceeds", () => {
  const plan = confirmedFill();
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  // 25 × 102,000 = 2,550,000 toman proceeds; 0.35% of 25 USDT = 0.0875 USDT.
  assert.equal(plan.sellLeg.settlement.feeAsset, "USDT");
  assert.equal(plan.sellLeg.settlement.debitMode, "ADD_TO_DEBIT");
  assert.equal(plan.sellLeg.notionalToman, 2_550_000);
  assert.equal(plan.sellLeg.feeToman, 0, "the sell fee is never taken in IRT");
  assert.equal(plan.sellLeg.feeUsdtMicros, usdtToMicros(0.0875));
  assert.equal(
    plan.sellLeg.deltaUsdtMicros,
    -usdtToMicros(25.0875),
    "USDT debit is quantity plus fee"
  );
  assert.equal(plan.sellLeg.deltaIrtToman, 2_550_000, "full IRT proceeds are credited");
});

await test("Phase 6 decomposes PnL: cash 43,750 but economic net 35,000 at a 100,000 mark", () => {
  const plan = confirmedFill();
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  assert.equal(plan.grossSpreadToman, 50_000);

  // 1. Cash only: proceeds − cost − buy fee in IRT.
  assert.equal(plan.cashPnlIrtToman, 2_550_000 - 2_500_000 - 6_250);
  assert.equal(plan.cashPnlIrtToman, 43_750);

  // 2. Inventory: total USDT falls by exactly the sell-side fee.
  assert.equal(plan.inventoryDeltaUsdtMicros, -usdtToMicros(0.0875));

  // 3. That lost USDT valued at the same-cycle mark price.
  assert.equal(plan.markPriceToman, 100_000);
  assert.equal(plan.sellFeeValueToman, 8_750, "0.0875 USDT × 100,000 toman");

  // 4. The real result of the round trip — NOT 43,750.
  assert.equal(plan.economicNetPnlToman, 35_000);
  assert.notEqual(plan.economicNetPnlToman, plan.cashPnlIrtToman);

  // 5. Risk-adjusted, which is what the execution gate uses.
  assert.equal(plan.riskAdjustedPnlToman, 35_000 - 1_000);
  assert.equal(plan.riskAdjustedPnlToman, 34_000);
});

await test("Phase 6 gates on risk-adjusted economic PnL, never on cash PnL alone", () => {
  // Cash PnL is comfortably positive, but the USDT fee wipes it out.
  const marginal = confirmedFill({
    sellVwapToman: 100_600,
    slippageBufferToman: 0,
    markPriceToman: 100_000
  });
  assert.equal(marginal.ok, false, "a cash-positive but economically negative trade is refused");
  if (!marginal.ok) assert.equal(marginal.code, "not_net_positive");

  // Proof that cash PnL alone would have accepted it.
  const cashOnly = 2_515_000 - 2_500_000 - 6_250;
  assert.ok(cashOnly > 0, "cash PnL was positive");
  const feeValue = 8_750;
  assert.ok(cashOnly - feeValue <= 0, "economic PnL was not");

  // A higher mark price makes the same fee more expensive and can flip a trade.
  const cheapMark = confirmedFill({ sellVwapToman: 101_000, slippageBufferToman: 0, markPriceToman: 100_000 });
  const dearMark = confirmedFill({ sellVwapToman: 101_000, slippageBufferToman: 0, markPriceToman: 300_000 });
  assert.equal(cheapMark.ok, true);
  assert.equal(dearMark.ok, false, "valuing the USDT fee higher can block the trade");
});

await test("Phase 6 blocks when the same-cycle mark price is missing", () => {
  const noMark = confirmedFill({ markPriceToman: null });
  assert.equal(noMark.ok, false);
  if (!noMark.ok) assert.equal(noMark.code, "mark_price_unavailable");

  const badMark = confirmedFill({ markPriceToman: 0 });
  assert.equal(badMark.ok, false);
  if (!badMark.ok) assert.equal(badMark.code, "mark_price_unavailable");

  // The documented rule: this cycle's executable buy VWAP on the buy venue.
  assert.equal(resolveMarkPriceToman(paperSources(), "nobitex", 25), 100_000);
  // Stale data yields no mark price at all, rather than a stale one.
  assert.equal(
    resolveMarkPriceToman(paperSources({ nobitex: { stale: true } }), "nobitex", 25),
    null
  );
  assert.equal(resolveMarkPriceToman(paperSources(), "nobitex", 7), null);
  assert.equal(resolveMarkPriceToman(paperSources(), "unknown-venue", 25), null);
});

await test("Phase 6 requires enough USDT for quantity plus the sell fee", () => {
  const plan = confirmedFill();
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  // Exactly the quantity, with nothing left for the fee: must be blocked.
  const exactlyQuantity = paperBalances({ wallex: [20_000_000, 25] });
  const snapshot = JSON.stringify(exactlyQuantity);
  const short = applyFill(plan, exactlyQuantity);
  assert.equal(short.ok, false, "25 USDT cannot cover 25 USDT plus the fee");
  if (!short.ok) {
    assert.equal(short.code, "insufficient_usdt");
    assert.equal(short.requiredRebalance?.sourceId, "wallex");
    assert.equal(short.requiredRebalance?.usdtMicrosShort, usdtToMicros(0.0875));
  }
  assert.equal(JSON.stringify(exactlyQuantity), snapshot, "a blocked fill mutates nothing");

  // One more micro-unit than quantity plus fee is enough.
  const justEnough = paperBalances({ wallex: [20_000_000, 25.0875] });
  const ok = applyFill(plan, justEnough);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.balancesAfter.find((b) => b.sourceId === "wallex")?.usdtMicros, 0);
  }
});

await test("Phase 6 stores settlement per venue and per side, never as one fee currency", () => {
  // The confirmed rule is mixed: IRT on the buy side, USDT on the sell side.
  const buy = settlementFor("nobitex", "buy");
  const sell = settlementFor("nobitex", "sell");
  assert.equal(buy.feeAsset, "IRT");
  assert.equal(sell.feeAsset, "USDT");
  assert.notEqual(buy.feeAsset, sell.feeAsset, "the two sides are not one currency");
  assert.equal(buy.provenance, "ADMIN_CONFIRMED");
  assert.equal(sell.provenance, "ADMIN_CONFIRMED");

  for (const id of ["nobitex", "wallex", "tabdeal"] as const) {
    assert.equal(settlementUsable(settlementFor(id, "buy")), true);
    assert.equal(settlementUsable(settlementFor(id, "sell")), true);
  }
  // Unknown venues remain blocked on both sides.
  for (const id of ["bitpin", "abantether", "ramzinex", "tetherland", "bit24", "arzinja"] as const) {
    assert.equal(PAPER_FEE_SETTLEMENT[id].buy.provenance, "UNKNOWN");
    assert.equal(settlementUsable(settlementFor(id, "buy")), false);
    assert.equal(settlementUsable(settlementFor(id, "sell")), false);
  }

  // A fee can only be added to the debit in the asset that side actually pays.
  assert.equal(settlementCoherent(BUY_SETTLEMENT, "buy"), true);
  assert.equal(settlementCoherent(SELL_SETTLEMENT, "sell"), true);
  assert.equal(settlementCoherent(SELL_SETTLEMENT, "buy"), false);
  assert.equal(settlementCoherent(BUY_SETTLEMENT, "sell"), false);
});

await test("Phase 6 blocks when settlement is unknown or incoherent", () => {
  const unknown = confirmedFill({
    sellSettlement: { feeAsset: "UNKNOWN", debitMode: "UNKNOWN", provenance: "UNKNOWN" }
  });
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "fee_settlement_unknown");

  // Confirmed, but the asset does not match the side that pays.
  const incoherent = confirmedFill({
    sellSettlement: { feeAsset: "IRT", debitMode: "ADD_TO_DEBIT", provenance: "ADMIN_CONFIRMED" }
  });
  assert.equal(incoherent.ok, false);
  if (!incoherent.ok) assert.equal(incoherent.code, "fee_settlement_unsupported");

  // An unknown fee value is still its own, separate block.
  const noFee = confirmedFill({ buyFeeBps: null });
  assert.equal(noFee.ok, false);
  if (!noFee.ok) assert.equal(noFee.code, "fee_unknown");
});

await test("Phase 6 reconciles the IRT and USDT ledgers independently", () => {
  const before = paperBalances();
  const plan = confirmedFill();
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  const applied = applyFill(plan, before);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  const after = before.map((b) => applied.balancesAfter.find((x) => x.sourceId === b.sourceId) ?? b);

  const rec = reconcilePaperLedgers(before, after, [plan]);
  assert.equal(rec.irtBalanced, true, "the IRT ledger reconciles on its own");
  assert.equal(rec.usdtBalanced, true, "the USDT ledger reconciles on its own");
  assert.equal(rec.irtDelta, 43_750);
  assert.equal(rec.expectedIrtDelta, 43_750);
  assert.equal(rec.usdtMicrosDelta, -usdtToMicros(0.0875));
  assert.equal(rec.expectedUsdtMicrosDelta, -usdtToMicros(0.0875));

  // The two assets never net against each other.
  assert.notEqual(rec.irtDelta, 0);
  assert.notEqual(rec.usdtMicrosDelta, 0);

  // Two round trips reconcile just as exactly as one.
  const second = confirmedFill({ sizeUsdt: 10 });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  const applied2 = applyFill(second, after);
  assert.equal(applied2.ok, true);
  if (!applied2.ok) return;
  const after2 = after.map((b) => applied2.balancesAfter.find((x) => x.sourceId === b.sourceId) ?? b);
  const rec2 = reconcilePaperLedgers(before, after2, [plan, second] as FillPlan[]);
  assert.equal(rec2.irtBalanced, true);
  assert.equal(rec2.usdtBalanced, true);
});

await test("Phase 6 accounting conserves the book: only fees leave it", () => {
  const before = paperBalances();
  const plan = confirmedFill();
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  const applied = applyFill(plan, before);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;

  const after = before.map((b) => applied.balancesAfter.find((x) => x.sourceId === b.sourceId) ?? b);
  const irtBefore = before.reduce((s, b) => s + b.irtToman, 0);
  const irtAfter = after.reduce((s, b) => s + b.irtToman, 0);
  const usdtBefore = before.reduce((s, b) => s + b.usdtMicros, 0);
  const usdtAfter = after.reduce((s, b) => s + b.usdtMicros, 0);

  // Toman changes by exactly the round-trip result, and USDT falls by exactly
  // the sell-side fee. Each ledger moves only by its own fee — no phantom money.
  assert.equal(irtAfter - irtBefore, plan.cashPnlIrtToman);
  assert.equal(usdtAfter - usdtBefore, -usdtToMicros(0.0875));
  assert.equal(plan.inventoryDeltaUsdtMicros, -usdtToMicros(0.0875));
  // The book moved by cash, but the economic result is smaller.
  assert.ok(plan.economicNetPnlToman < plan.cashPnlIrtToman);

  // Inventory moved between venues; the buy venue received the full quantity.
  const nobitex = after.find((b) => b.sourceId === "nobitex")!;
  const wallex = after.find((b) => b.sourceId === "wallex")!;
  assert.equal(microsToUsdt(nobitex.usdtMicros), 125);
  assert.equal(microsToUsdt(wallex.usdtMicros), 74.9125);
  assert.ok(portfolioValueToman(after, PX) > 0);
});

await test("Phase 6 makes no balance change when either leg cannot be funded", () => {
  const plan = confirmedFill({ slippageBufferToman: 0 });
  assert.equal(plan.ok, true);
  if (!plan.ok) return;

  // Buy leg fails: not enough toman on the buy venue.
  const poorIrt = paperBalances({ nobitex: [1_000, 100] });
  const snapshotIrt = JSON.stringify(poorIrt);
  const r1 = applyFill(plan, poorIrt);
  assert.equal(r1.ok, false);
  if (!r1.ok) {
    assert.equal(r1.code, "insufficient_irt");
    assert.equal(r1.requiredRebalance?.sourceId, "nobitex");
    assert.ok((r1.requiredRebalance?.irtTomanShort ?? 0) > 0);
  }
  assert.equal(JSON.stringify(poorIrt), snapshotIrt, "a failed fill must not mutate the book");

  // Sell leg fails: no USDT inventory on the sell venue.
  const poorUsdt = paperBalances({ wallex: [20_000_000, 0] });
  const snapshotUsdt = JSON.stringify(poorUsdt);
  const r2 = applyFill(plan, poorUsdt);
  assert.equal(r2.ok, false);
  if (!r2.ok) {
    assert.equal(r2.code, "insufficient_usdt");
    assert.equal(r2.requiredRebalance?.sourceId, "wallex");
  }
  assert.equal(JSON.stringify(poorUsdt), snapshotUsdt, "the second leg failing rolls back the first");
});

await test("Phase 6 refuses a round trip that is not net positive after the buffer", () => {
  const plan = confirmedFill({ sellVwapToman: 100_100 });
  assert.equal(plan.ok, false);
  if (!plan.ok) assert.equal(plan.code, "not_net_positive");
});

await test("Phase 6 picks one size per route on risk-adjusted economic PnL", () => {
  const priced = (size: number, sellVwap: number): PricedCandidate => {
    const plan = confirmedFill({ sizeUsdt: size, sellVwapToman: sellVwap });
    assert.equal(plan.ok, true);
    if (!plan.ok) throw new Error("fixture must plan");
    return {
      candidate: {
        lifecycleId: `lc-${size}`,
        routeKey: `nobitex->wallex@${size}`,
        buySourceId: "nobitex",
        sellSourceId: "wallex",
        sizeUsdt: size,
        buyVwapToman: 100_000,
        sellVwapToman: sellVwap,
        netProfitToman: 0,
        slippageBufferToman: 1_000,
        buyFeeBps: 25,
        sellFeeBps: 35
      },
      plan
    };
  };

  const list = [priced(5, 102_000), priced(25, 102_000), priced(10, 102_000), priced(20, 102_000)];
  const { selected, dropped } = selectBestPerRoute(list);
  assert.equal(selected.length, 1, "one size per route");
  assert.equal(selected[0].candidate.sizeUsdt, 25, "largest economic profit wins");
  assert.equal(dropped.length, 3);

  // Deterministic across input orderings.
  const shuffled = selectBestPerRoute([list[2], list[0], list[3], list[1]]);
  assert.equal(shuffled.selected[0].candidate.lifecycleId, selected[0].candidate.lifecycleId);
});

await test("Phase 6 ranks competing candidates globally and deterministically", () => {
  // Three routes competing for the same virtual balance, deliberately shuffled.
  const mk = (
    lifecycleId: string,
    routeKey: string,
    sizeUsdt: number,
    sellVwapToman: number
  ): PricedCandidate => {
    const plan = confirmedFill({ sizeUsdt, sellVwapToman });
    assert.equal(plan.ok, true);
    if (!plan.ok) throw new Error("fixture must plan");
    return {
      candidate: {
        lifecycleId,
        routeKey,
        buySourceId: "nobitex",
        sellSourceId: "wallex",
        sizeUsdt,
        buyVwapToman: 100_000,
        sellVwapToman,
        netProfitToman: 0,
        slippageBufferToman: 1_000,
        buyFeeBps: 25,
        sellFeeBps: 35
      },
      plan
    };
  };

  const big = mk("lc-big", "a->b@25", 25, 103_000);
  const mid = mk("lc-mid", "c->d@25", 25, 102_000);
  const small = mk("lc-small", "e->f@10", 10, 102_000);

  const ranked = rankPricedCandidates([small, big, mid]);
  assert.deepEqual(
    ranked.map((r) => r.candidate.lifecycleId),
    ["lc-big", "lc-mid", "lc-small"],
    "highest risk-adjusted economic profit first"
  );
  // Ranking is by economic profit, and strictly decreasing here.
  for (let i = 1; i < ranked.length; i += 1) {
    assert.ok(
      ranked[i - 1].plan.riskAdjustedPnlToman >= ranked[i].plan.riskAdjustedPnlToman,
      "the order is monotonic in risk-adjusted PnL"
    );
  }

  // Every input permutation produces the identical order.
  const permutations = [
    [big, mid, small],
    [mid, small, big],
    [small, mid, big],
    [mid, big, small],
    [big, small, mid]
  ];
  for (const p of permutations) {
    assert.deepEqual(
      rankPricedCandidates(p).map((r) => r.candidate.lifecycleId),
      ["lc-big", "lc-mid", "lc-small"]
    );
  }

  // A perfect economic tie is still broken deterministically: size, then route
  // key, then lifecycle id — so no two candidates can ever tie on all four.
  const tieA = mk("lc-aaa", "z->z@25", 25, 102_000);
  const tieB = mk("lc-bbb", "a->a@25", 25, 102_000);
  assert.equal(tieA.plan.riskAdjustedPnlToman, tieB.plan.riskAdjustedPnlToman);
  assert.deepEqual(
    rankPricedCandidates([tieA, tieB]).map((r) => r.candidate.routeKey),
    ["a->a@25", "z->z@25"]
  );
  assert.deepEqual(
    rankPricedCandidates([tieB, tieA]).map((r) => r.candidate.routeKey),
    ["a->a@25", "z->z@25"]
  );
});

await test("Phase 6 applies the best-ranked candidate first when balances are scarce", () => {
  // Only enough toman for a single 25 USDT round trip on the buy venue.
  const scarce: VenueBalance[] = [
    { sourceId: "nobitex", irtToman: 2_600_000, usdtMicros: usdtToMicros(100) },
    { sourceId: "wallex", irtToman: 2_600_000, usdtMicros: usdtToMicros(100) }
  ];

  const rich = paperOpportunity({
    id: "lc-rich",
    routeKey: "nobitex->wallex@25",
    sellVwapToman: 104_000
  });
  const poor = paperOpportunity({
    id: "lc-poor",
    routeKey: "nobitex->tabdeal@25",
    sellSourceId: "tabdeal",
    sellVwapToman: 100_500
  });

  const run = (opportunities: ShadowOpportunity[]) =>
    evaluateCycle({
      opportunities,
      sources: paperSources(),
      venueStates: paperReadiness(),
      executedLifecycleIds: new Set(),
      balances: scarce
    });

  const a = run([rich, poor]);
  const b = run([poor, rich]);

  assert.equal(a.executedCount, 1, "only one trade fits the scarce balance");
  assert.equal(b.executedCount, a.executedCount);

  const executedA = a.decisions.find((d) => d.kind === "EXECUTE");
  const executedB = b.decisions.find((d) => d.kind === "EXECUTE");
  assert.ok(executedA && executedA.kind === "EXECUTE");
  assert.ok(executedB && executedB.kind === "EXECUTE");
  if (executedA?.kind === "EXECUTE" && executedB?.kind === "EXECUTE") {
    assert.equal(executedA.candidate.lifecycleId, "lc-rich", "the better trade wins the balance");
    assert.equal(executedB.candidate.lifecycleId, "lc-rich", "input order does not matter");
  }
  assert.deepEqual(a.balancesAfter, b.balancesAfter, "the resulting book is identical");
});

await test("Phase 6 executes a lifecycle at most once, however long it stays open", () => {
  const o = paperOpportunity();
  const first = evaluateCycle({
    opportunities: [o],
    sources: paperSources(),
    venueStates: paperReadiness(),
    executedLifecycleIds: new Set(),
    balances: paperBalances()
  });
  assert.equal(first.executedCount, 1);

  // The same unchanged opportunity in the next cycle must not refill.
  const second = evaluateCycle({
    opportunities: [o],
    sources: paperSources(),
    venueStates: paperReadiness(),
    executedLifecycleIds: new Set([o.id]),
    balances: first.balancesAfter
  });
  assert.equal(second.executedCount, 0);
  assert.equal(second.decisions[0].kind, "SKIP");
  if (second.decisions[0].kind === "SKIP") {
    assert.equal(second.decisions[0].code, "already_executed");
  }
  assert.deepEqual(second.balancesAfter, first.balancesAfter, "a skipped cycle changes nothing");
});

await test("Phase 6 skips stale data, thin depth and ineligible venues with a reason", () => {
  const states = paperReadiness();
  const book = paperBalances();

  const staleCycle = evaluateCycle({
    opportunities: [paperOpportunity()],
    sources: paperSources({ wallex: { stale: true } }),
    venueStates: states,
    executedLifecycleIds: new Set(),
    balances: book
  });
  assert.equal(staleCycle.executedCount, 0);
  assert.equal(
    staleCycle.decisions.find((d) => d.kind === "SKIP" && d.code === "stale_market_data")?.kind,
    "SKIP"
  );

  // mockSource always builds a full depth ladder, so thin the sell side directly.
  const thinSources = paperSources().map((src) =>
    src.sourceId === "wallex"
      ? {
          ...src,
          sizeExecutables: src.sizeExecutables.map((x) =>
            x.sizeUsdt === 25
              ? { ...x, sellFillable: false, userSellVwapToman: null, sellFilledUsdt: 0 }
              : x
          )
        }
      : src
  );
  const thin = evaluateCycle({
    opportunities: [paperOpportunity()],
    sources: thinSources,
    venueStates: states,
    executedLifecycleIds: new Set(),
    balances: book
  });
  assert.equal(thin.executedCount, 0);
  assert.ok(thin.decisions.some((d) => d.kind === "SKIP" && d.code === "insufficient_depth"));

  // A venue with no usable account can never be traded, even with a live book.
  const ineligible = evaluateCycle({
    opportunities: [paperOpportunity({ sellSourceId: "bitpin", routeKey: "nobitex->bitpin@25" })],
    sources: [...paperSources(), mockSource("bitpin", "بیت‌پین", 103_000, 102_000)],
    venueStates: states,
    executedLifecycleIds: new Set(),
    balances: [...book, { sourceId: "bitpin" as ShadowSourceId, irtToman: 10_000_000, usdtMicros: usdtToMicros(100) }]
  });
  assert.equal(ineligible.executedCount, 0);
  assert.ok(ineligible.decisions.some((d) => d.kind === "SKIP" && d.code === "venue_not_executable"));

  // A blocked opportunity is never executed regardless of the book.
  const blockedOpp = evaluateCycle({
    opportunities: [paperOpportunity({ blockedReasons: ["fee_unknown"] as BlockedReasonCode[] })],
    sources: paperSources(),
    venueStates: states,
    executedLifecycleIds: new Set(),
    balances: book
  });
  assert.equal(blockedOpp.executedCount, 0);
  assert.ok(blockedOpp.decisions.some((d) => d.kind === "SKIP" && d.code === "blocked_opportunity"));
});

await test("Phase 6 blocks on thin inventory and reports the required rebalance", () => {
  const result = evaluateCycle({
    opportunities: [paperOpportunity()],
    sources: paperSources(),
    venueStates: paperReadiness(),
    executedLifecycleIds: new Set(),
    balances: paperBalances({ wallex: [20_000_000, 1] })
  });
  assert.equal(result.executedCount, 0);
  const skip = result.decisions.find((d) => d.kind === "SKIP");
  assert.ok(skip && skip.kind === "SKIP");
  if (skip && skip.kind === "SKIP") {
    assert.equal(skip.code, "insufficient_usdt");
    assert.equal(skip.requiredRebalance?.sourceId, "wallex");
    assert.ok((skip.requiredRebalance?.usdtMicrosShort ?? 0) > 0);
  }
  // Rebalancing stays simulated: the engine never moves inventory itself.
  assert.deepEqual(result.balancesAfter, paperBalances({ wallex: [20_000_000, 1] }));
});

await test("Phase 6 opening book comes from the plan with integer micros", () => {
  const book = balancesFromAllocations([
    { sourceId: "nobitex", irtToman: 10_000_000.4, usdtUnits: 12.345678 },
    { sourceId: "wallex", irtToman: -5, usdtUnits: -2 }
  ]);
  assert.equal(book[0].irtToman, 10_000_000);
  assert.equal(book[0].usdtMicros, 12_345_678);
  assert.equal(book[1].irtToman, 0, "a negative opening balance is clamped, never stored");
  assert.equal(book[1].usdtMicros, 0);
});

await test("Phase 6 modules are structurally incapable of trading", () => {
  const files = {
    broker: readFileSync(new URL("../src/lib/shadowArbitrage/paper/broker.ts", import.meta.url), "utf8"),
    engine: readFileSync(new URL("../src/lib/shadowArbitrage/paper/engine.ts", import.meta.url), "utf8"),
    run: readFileSync(new URL("../src/lib/shadowArbitrage/paper/run.ts", import.meta.url), "utf8"),
    route: readFileSync(new URL("../app/api/shadow-arbitrage/paper/route.ts", import.meta.url), "utf8"),
    ui: readFileSync(new URL("../src/components/shadowArbitrage/PaperExecution.tsx", import.meta.url), "utf8")
  };

  // The pure modules must not be able to reach the network at all.
  for (const key of ["broker", "engine"] as const) {
    const src = files[key];
    assert.equal(/from ["'][^"']*adapters/.test(src), false, `${key} must not import an adapter`);
    assert.equal(/\bfetch\s*\(/.test(src), false, `${key} must not call fetch`);
    assert.equal(/node:https?|axios|undici|XMLHttpRequest/.test(src), false, `${key} must not import a client`);
  }

  // No Phase 6 file may reach an order, transfer or withdrawal function.
  const forbidden = [
    "placeOrder",
    "submitOrder",
    "createOrder",
    "cancelOrder",
    "withdraw",
    "deposit",
    "transferFunds",
    "signRequest",
    "privateApi"
  ];
  for (const [name, src] of Object.entries(files)) {
    for (const term of forbidden) {
      assert.equal(src.includes(term), false, `${name} must not reference ${term}`);
    }
    // An explicit "OMPFinex is excluded" note is documentation, not a reference.
    const withoutExclusionNote = src.replace(/OMPFinex is (not|intentionally)[^\n]*/gi, "");
    assert.equal(
      /ompfinex/i.test(withoutExclusionNote),
      false,
      `${name} must not reference OMPFinex`
    );
  }

  // The control surface is admin-only and refuses credentials outright.
  assert.ok(files.route.includes("requireAdminSession"));
  assert.ok(files.route.includes("forbidden_field"));
  for (const secret of ["apiKey", "secret", "token", "password", "passphrase"]) {
    assert.ok(files.route.includes(secret), `paper API must explicitly refuse ${secret}`);
  }

  // The banner is permanent, not conditional.
  assert.ok(files.ui.includes("PAPER EXECUTION — NO REAL ORDERS OR TRANSFERS"));

  // The collector must call the isolated wrapper, never the raw engine.
  const collector = readFileSync(
    new URL("../src/lib/shadowArbitrage/collector.ts", import.meta.url),
    "utf8"
  );
  assert.ok(collector.includes("runPaperExecutionIsolated"));
  assert.equal(collector.includes("runPaperExecutionForCycle"), false);
});

await test("Phase 6 never runs on a venue outside the nine Shadow sources", () => {
  const result = evaluateCycle({
    opportunities: [
      paperOpportunity({
        buySourceId: "ompfinex" as ShadowSourceId,
        routeKey: "ompfinex->wallex@25",
        id: "lc-omp"
      })
    ],
    sources: paperSources(),
    venueStates: paperReadiness(),
    executedLifecycleIds: new Set(),
    balances: paperBalances()
  });
  assert.equal(result.executedCount, 0);
  assert.ok(result.decisions.some((d) => d.kind === "SKIP" && d.code === "venue_not_executable"));
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
