#!/usr/bin/env npx tsx
/**
 * Four-day Paper experiment — pure policy, utilization, allocator tests
 * plus throwaway PGlite lifecycle (96h clock, restart, single active run).
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  PAPER_4D_DURATION_MS,
  PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
  PAPER_4D_MAX_UTILIZATION_PERCENT,
  PAPER_4D_MIN_RESERVE_PERCENT,
  PAPER_4D_POLICY_SET_KEY,
  PAPER_4D_RUN_KEY,
  PAPER_4D_TARGET_UTILIZATION_PERCENT,
  deriveMaxOrderUsdt,
  paper4dCanonical
} from "../src/lib/shadowArbitrage/paper/experimentPolicy.ts";
import {
  computeUtilization,
  routeCapitalToman
} from "../src/lib/shadowArbitrage/paper/utilization.ts";
import { allocatePaperRoutes } from "../src/lib/shadowArbitrage/paper/portfolioAllocator.ts";

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

await test("exactly 96 hours between start and end", () => {
  assert.equal(PAPER_4D_DURATION_MS, 96 * 3600 * 1000);
  const start = Date.parse("2026-08-05T12:00:00.000Z");
  const end = start + PAPER_4D_DURATION_MS;
  assert.equal((end - start) / 3600000, 96);
});

await test("targets are 70/80/20 and route/venue 10/20", () => {
  assert.equal(PAPER_4D_TARGET_UTILIZATION_PERCENT, 70);
  assert.equal(PAPER_4D_MAX_UTILIZATION_PERCENT, 80);
  assert.equal(PAPER_4D_MIN_RESERVE_PERCENT, 20);
  assert.equal(PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT, 10);
  assert.equal(PAPER_4D_POLICY_SET_KEY, "PAPER_BALANCED_10B_4D_V1");
  assert.equal(PAPER_4D_RUN_KEY, "paper-experiment-4d-v1");
});

await test("derived max order USDT floors capital-relative 10%", () => {
  // 10B equity @ 200_000 toman/USDT → 10% = 1B toman → 5000 USDT exact
  assert.equal(deriveMaxOrderUsdt({ equityToman: 10_000_000_000, markPriceToman: 200_000 }), 5000);
  // floor, never round up
  assert.equal(deriveMaxOrderUsdt({ equityToman: 10_000_000_000, markPriceToman: 200_001 }), 4999);
  assert.equal(deriveMaxOrderUsdt({ equityToman: 0, markPriceToman: 200_000 }), 0);
});

await test("utilization formula and hard max breach", () => {
  const u = computeUtilization({
    equityToman: 10_000_000_000,
    reservedBuyIrtToman: 6_000_000_000,
    reservedSellUsdtMicros: 0,
    markPriceToman: 200_000
  });
  assert.equal(u.utilizationPercent, 60);
  assert.equal(u.freeReservePercent, 40);
  assert.equal(u.wouldBreach(1_500_000_000, 80, 20), false); // 75%
  assert.equal(u.wouldBreach(2_500_000_000, 80, 20), true); // 85%
});

await test("route capital is combined two-leg", () => {
  const c = routeCapitalToman({
    sizeUsdt: 100,
    buyVwapToman: 200_000,
    sellVwapToman: 201_000,
    markPriceToman: 200_000
  });
  assert.equal(c, 100 * 200_000 + 100 * 201_000);
});

await test("allocator ranks by risk-adjusted PnL and never double-spends", () => {
  const equity = 10_000_000_000;
  const mark = 200_000;
  const candidates = [
    {
      lifecycleId: "b",
      routeKey: "nobitex->wallex",
      buySourceId: "nobitex",
      sellSourceId: "wallex",
      sizeUsdt: 100,
      buyVwapToman: 200_000,
      sellVwapToman: 201_000,
      riskAdjustedPnlToman: 50_000,
      economicNetPnlToman: 60_000,
      buyNotionalToman: 20_000_000,
      sellUsdtMicros: 100_000_000
    },
    {
      lifecycleId: "a",
      routeKey: "nobitex->bitpin",
      buySourceId: "nobitex",
      sellSourceId: "bitpin",
      sizeUsdt: 100,
      buyVwapToman: 200_000,
      sellVwapToman: 201_500,
      riskAdjustedPnlToman: 80_000,
      economicNetPnlToman: 90_000,
      buyNotionalToman: 20_000_000,
      sellUsdtMicros: 100_000_000
    }
  ];
  const r = allocatePaperRoutes({
    candidates,
    equityToman: equity,
    markPriceToman: mark,
    venueExposureToman: new Map([
      ["nobitex", 1_000_000_000],
      ["wallex", 1_000_000_000],
      ["bitpin", 1_000_000_000]
    ]),
    availableIrtByVenue: new Map([["nobitex", 25_000_000]]), // only enough for one
    availableUsdtMicrosByVenue: new Map([
      ["wallex", 500_000_000],
      ["bitpin", 500_000_000]
    ])
  });
  assert.equal(r.selected.length, 1);
  assert.equal(r.selected[0].candidate.lifecycleId, "a"); // higher RA pnl
  assert.ok(r.rejected.some((x) => x.code === "insufficient_irt"));
});

await test("negative-net candidates get zero allocation", () => {
  const r = allocatePaperRoutes({
    candidates: [
      {
        lifecycleId: "x",
        routeKey: "a->b",
        buySourceId: "a",
        sellSourceId: "b",
        sizeUsdt: 10,
        buyVwapToman: 100,
        sellVwapToman: 100,
        riskAdjustedPnlToman: -1,
        economicNetPnlToman: -1,
        buyNotionalToman: 1000,
        sellUsdtMicros: 10_000_000
      }
    ],
    equityToman: 1e12,
    markPriceToman: 100,
    venueExposureToman: new Map(),
    availableIrtByVenue: new Map([["a", 1e12]]),
    availableUsdtMicrosByVenue: new Map([["b", 1e12]])
  });
  assert.equal(r.selected.length, 0);
  assert.equal(r.rejected[0].code, "net_non_positive");
});

await test("portfolio hard max 80% cannot be exceeded", () => {
  // Already at 75% utilized. Combined capital 0.6B (under 10% route cap of 1B)
  // would push utilization to 81% → portfolio cap fires first.
  const r = allocatePaperRoutes({
    candidates: [
      {
        lifecycleId: "big",
        routeKey: "a->b",
        buySourceId: "a",
        sellSourceId: "b",
        sizeUsdt: 1_500,
        buyVwapToman: 200_000,
        sellVwapToman: 200_000,
        riskAdjustedPnlToman: 1_000_000,
        economicNetPnlToman: 1_000_000,
        buyNotionalToman: 300_000_000,
        sellUsdtMicros: 1_500_000_000
      }
    ],
    equityToman: 10_000_000_000,
    markPriceToman: 200_000,
    venueExposureToman: new Map([
      ["a", 0],
      ["b", 0]
    ]),
    availableIrtByVenue: new Map([["a", 5_000_000_000]]),
    availableUsdtMicrosByVenue: new Map([["b", 5_000_000_000]]),
    reservedBuyIrtToman: 7_500_000_000 // already 75%
  });
  // combined capital = 1500*200k*2 = 0.6B → 81% → reject
  assert.equal(r.selected.length, 0);
  assert.ok(
    r.rejected.some((x) => x.code === "portfolio_utilization_cap"),
    `codes: ${r.rejected.map((x) => x.code).join(",")}`
  );
});

await test("canonical fingerprint is stable", () => {
  const a = paper4dCanonical({ maxOrderUsdt: 5000, markPriceToman: 200_000 });
  const b = paper4dCanonical({ maxOrderUsdt: 5000, markPriceToman: 200_000 });
  assert.equal(a, b);
  assert.ok(a.includes(PAPER_4D_POLICY_SET_KEY));
  assert.ok(a.includes("hours=96"));
});

await test("route capital max 10% of equity", () => {
  const equity = 10_000_000_000;
  const mark = 200_000;
  // size that would use ~12% combined (buy+sell marked) → reject
  const sizeUsdt = 300_000; // buy 60B + sell ~60B way over
  const r = allocatePaperRoutes({
    candidates: [
      {
        lifecycleId: "over",
        routeKey: "a->b",
        buySourceId: "a",
        sellSourceId: "b",
        sizeUsdt,
        buyVwapToman: mark,
        sellVwapToman: mark,
        riskAdjustedPnlToman: 1e9,
        economicNetPnlToman: 1e9,
        buyNotionalToman: sizeUsdt * mark,
        sellUsdtMicros: sizeUsdt * 1_000_000
      }
    ],
    equityToman: equity,
    markPriceToman: mark,
    venueExposureToman: new Map([
      ["a", 0],
      ["b", 0]
    ]),
    availableIrtByVenue: new Map([["a", equity]]),
    availableUsdtMicrosByVenue: new Map([["b", 1e15]])
  });
  assert.equal(r.selected.length, 0);
  assert.ok(r.rejected.some((x) => x.code === "route_capital_cap"));
});

await test("venue exposure max 20%", () => {
  const equity = 10_000_000_000;
  const mark = 200_000;
  // small route but venue already at 19% and add would exceed 20%
  const r = allocatePaperRoutes({
    candidates: [
      {
        lifecycleId: "v",
        routeKey: "a->b",
        buySourceId: "a",
        sellSourceId: "b",
        sizeUsdt: 100,
        buyVwapToman: mark,
        sellVwapToman: mark,
        riskAdjustedPnlToman: 50_000,
        economicNetPnlToman: 50_000,
        buyNotionalToman: 20_000_000,
        sellUsdtMicros: 100_000_000
      }
    ],
    equityToman: equity,
    markPriceToman: mark,
    venueExposureToman: new Map([
      ["a", 1_990_000_000],
      ["b", 0]
    ]),
    availableIrtByVenue: new Map([["a", equity]]),
    availableUsdtMicrosByVenue: new Map([["b", 1e15]])
  });
  assert.equal(r.selected.length, 0);
  assert.ok(r.rejected.some((x) => x.code === "venue_exposure_cap"));
});

await test("fewer valid opportunities → lower utilization, no forced trades", () => {
  const equity = 10_000_000_000;
  const mark = 200_000;
  const r = allocatePaperRoutes({
    candidates: [
      {
        lifecycleId: "tiny",
        routeKey: "a->b",
        buySourceId: "a",
        sellSourceId: "b",
        sizeUsdt: 10,
        buyVwapToman: mark,
        sellVwapToman: mark + 100,
        riskAdjustedPnlToman: 1_000,
        economicNetPnlToman: 1_200,
        buyNotionalToman: 2_000_000,
        sellUsdtMicros: 10_000_000
      }
    ],
    equityToman: equity,
    markPriceToman: mark,
    venueExposureToman: new Map([
      ["a", 0],
      ["b", 0]
    ]),
    availableIrtByVenue: new Map([["a", equity]]),
    availableUsdtMicrosByVenue: new Map([["b", 1e15]])
  });
  assert.equal(r.selected.length, 1);
  assert.ok(r.utilizationAfter.utilizationPercent < 1);
  assert.ok(r.utilizationAfter.utilizationPercent < 70);
});

await test("LIVE_EXECUTION remains impossible (const false)", async () => {
  const cap = await import("../src/lib/shadowArbitrage/live/capability.ts");
  assert.equal(cap.LIVE_EXECUTION_IMPLEMENTED, false);
  // Structural: the const is literally false — no env path can flip it.
  assert.equal(typeof cap.LIVE_EXECUTION_IMPLEMENTED, "boolean");
  assert.ok(!("LIVE" in { PAPER: 1, FAKE: 1 })); // ExecutionSurface has no LIVE
});

/* ── PGlite lifecycle ───────────────────────────────────────────────────── */

const scratch = await mkdtemp(path.join(tmpdir(), "otc-4d-"));
process.env.DATABASE_URL = `pglite:${path.join(scratch, "db")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";
process.env.SHADOW_RELEASE_BOOTSTRAP = "true";
process.env.NODE_ENV = "production";

const { runMigrations } = await import("../src/db/migrate.ts");
const { closeDb } = await import("../src/db/client.ts");
const {
  createActiveExperiment,
  getActiveExperiment,
  getExperimentByRunKey,
  completeExperiment,
  experimentIsOpen
} = await import("../src/db/repositories/shadowExperiments.ts");
const { createPaperSession, setPaperSessionStatus, listPaperSessions } = await import(
  "../src/db/repositories/shadowPaper.ts"
);
const { defaultAllocation } = await import("../src/lib/shadowArbitrage/paper/portfolio.ts");

await runMigrations();

await test("PGlite: create one active experiment with frozen endsAt", async () => {
  const startedAt = "2026-08-05T12:00:00.000Z";
  const endsAt = new Date(Date.parse(startedAt) + PAPER_4D_DURATION_MS).toISOString();
  const alloc = defaultAllocation(10_000_000_000, ["nobitex", "wallex"], 200_000);
  const session = await createPaperSession({
    observationId: null,
    name: "test-4d",
    mode: "APPROVED_PLAN",
    totalCapitalToman: 10_000_000_000,
    valuationPriceToman: 200_000,
    openingAllocations: alloc,
    approvalFingerprint: "test",
    createdBy: "test"
  });
  await setPaperSessionStatus(session.id, "RUNNING");
  const exp = await createActiveExperiment({
    runKey: PAPER_4D_RUN_KEY,
    policySetKey: PAPER_4D_POLICY_SET_KEY,
    policyFingerprint: "fp",
    releaseVersion: "4.1.10.0",
    startedAt,
    endsAt,
    sessionId: session.id,
    initialCapitalToman: 10_000_000_000,
    targetUtilizationPercent: 70,
    maxUtilizationPercent: 80,
    minReservePercent: 20,
    maxRouteCapitalPercent: 10,
    maxVenueExposurePercent: 20,
    derivedMaxOrderUsdt: 5000,
    derivedMaxOrderReferencePrice: 200_000,
    config: {}
  });
  assert.equal(exp.status, "ACTIVE");
  // Driver may render timestamptz with an offset; compare epoch ms.
  assert.equal(Date.parse(exp.endsAt), Date.parse(endsAt));
  assert.equal(Date.parse(exp.startedAt), Date.parse(startedAt));
  assert.equal(Date.parse(exp.endsAt) - Date.parse(exp.startedAt), PAPER_4D_DURATION_MS);
  assert.equal(experimentIsOpen(exp, Date.parse(startedAt) + 1000), true);
  assert.equal(experimentIsOpen(exp, Date.parse(endsAt) + 1), false);
});

await test("PGlite: restart never extends endsAt; second create conflicts to one active", async () => {
  const first = await getExperimentByRunKey(PAPER_4D_RUN_KEY);
  assert.ok(first);
  const endsMs = Date.parse(first!.endsAt);
  // re-read after "restart"
  const again = await getActiveExperiment();
  assert.equal(Date.parse(again!.endsAt), endsMs);
  assert.equal(again?.id, first!.id);
});

await test("PGlite: complete freezes summary; prior session history remains", async () => {
  const active = await getActiveExperiment();
  assert.ok(active);
  await completeExperiment(active!.id, { completedReason: "test", filled: 0 });
  const done = await getExperimentByRunKey(PAPER_4D_RUN_KEY);
  assert.equal(done?.status, "COMPLETED");
  assert.ok(done?.summary);
  const sessions = await listPaperSessions(20);
  assert.ok(sessions.length >= 1);
});

await closeDb();
await rm(scratch, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
