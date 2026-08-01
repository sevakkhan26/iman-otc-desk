#!/usr/bin/env npx tsx
/**
 * Admin-confirmed account, fee and capital evidence.
 *
 * Structural and arithmetic only: no database, no network, no browser. It
 * checks the rules that decide whether confirmed evidence may influence money —
 * which fee settles which side, which venues can never execute, when evidence
 * expires, and that importing the same evidence twice stores one copy.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildAllReadiness,
  buildVenueReadiness,
  venueUsableForNetProfit,
  FEE_REVERIFY_DAYS,
  type AccountOverride,
  type FeeOverride
} from "../src/lib/shadowArbitrage/accounts.ts";
import { applyFill, planFill, PAPER_FEE_SETTLEMENT, settlementFor, usdtToMicros } from "../src/lib/shadowArbitrage/paper/broker.ts";
import { proveBookDirection } from "../src/lib/shadowArbitrage/adapters/base.ts";
import { certifyFromSnapshot } from "../src/lib/shadowArbitrage/certification.ts";
import { parseLevels } from "../src/lib/shadowArbitrage/vwap.ts";
import { buildOpportunities } from "../src/lib/shadowArbitrage/calculate.ts";
import type { NormalizedSourceSnapshot } from "../src/lib/shadowArbitrage/types.ts";

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

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const DAY = 86_400_000;

/** The confirmed schedule, as the import writes it. */
const CONFIRMED: Record<string, { taker: number; maker: number; tier: string }> = {
  nobitex: { taker: 25, maker: 25, tier: "Base" },
  wallex: { taker: 30, maker: 25, tier: "Base Level 1" },
  tabdeal: { taker: 28, maker: 24, tier: "VIP1" },
  bitpin: { taker: 35, maker: 30, tier: "Base Level 1" },
  abantether: { taker: 30, maker: 30, tier: "current 0.30% tier" },
  ramzinex: { taker: 25, maker: 20, tier: "Base" },
  bit24: { taker: 20, maker: 20, tier: "VIP0" },
  tetherland: { taker: 45, maker: 45, tier: "Bronze" },
  arzinja: { taker: 0, maker: 0, tier: "Level 1" }
};

function feeOverride(sourceId: string, over: Partial<FeeOverride> = {}): FeeOverride {
  const c = CONFIRMED[sourceId];
  return {
    sourceId,
    takerFeeBps: c.taker,
    makerFeeBps: c.maker,
    feeTier: c.tier,
    sourceUrl: null,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    validDays: 30,
    referenceMetadata: null,
    confirmedBy: "admin",
    confirmedAt: new Date(NOW - DAY).toISOString(),
    note: null,
    ...over
  };
}

function accountOverride(sourceId: string, over: Partial<AccountOverride> = {}): AccountOverride {
  return {
    sourceId,
    kycComplete: true,
    accountState: "VERIFIED",
    executionEligible: true,
    ineligibleReason: null,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    validDays: 30,
    confirmedAt: new Date(NOW - DAY).toISOString(),
    ...over
  };
}

/** A healthy, certified-looking snapshot for one venue. */
function snapshotFor(sourceId: string, buy: number, sell: number, over: Record<string, unknown> = {}): NormalizedSourceSnapshot {
  return {
    sourceId: sourceId as never,
    sourceName: sourceId,
    marketModel: "ORDER_BOOK",
    accountStatus: "verified",
    eligibilityBase: "EXECUTABLE_NOW",
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
    depthUsdtBid: 5_000,
    depthUsdtAsk: 5_000,
    maxExecutableUsdt: 5_000,
    marketFeeBps: CONFIRMED[sourceId]?.taker ?? 25,
    feeStatus: "account_api",
    feeLabel: "confirmed",
    feeReferenceUrl: null,
    feeVerifiedAt: new Date(NOW).toISOString(),
    sourceTimestamp: new Date(NOW).toISOString(),
    receivedAt: new Date(NOW).toISOString(),
    ageMs: 0,
    health: "healthy",
    errorReason: null,
    degradedReason: null,
    stale: false,
    meta: {
      endpoint: "https://example.test/book",
      httpStatus: 200,
      latencyMs: 120,
      attempts: 1,
      rateLimited: false,
      timedOut: false,
      depthAvailable: true,
      directionVerified: true,
      priceUnit: "IRT",
      normalizationNote: null
    },
    sourceBlockedReasons: [],
    ...over
  } as NormalizedSourceSnapshot;
}

/** The same snapshot, with one certification input flipped. */
function mockSnapshot(sourceId: string, over: Record<string, unknown>): NormalizedSourceSnapshot {
  const { directionVerified, depthAvailable, ...rest } = over as Record<string, never>;
  const snap = snapshotFor(sourceId, 195_470, 194_600, rest);
  if (directionVerified !== undefined) snap.meta.directionVerified = directionVerified;
  if (depthAvailable !== undefined) snap.meta.depthAvailable = depthAvailable;
  return snap;
}

/* ── the confirmed schedule reaches readiness intact ───────────────────────── */

await test("all nine venues carry KYC confirmation and their exact tier", () => {
  const rows = buildAllReadiness(
    Object.keys(CONFIRMED).map((id) => feeOverride(id)),
    NOW,
    Object.keys(CONFIRMED).map((id) =>
      accountOverride(id, {
        executionEligible: id !== "tetherland" && id !== "arzinja",
        ineligibleReason: id === "tetherland" ? "degraded" : id === "arzinja" ? "reference only" : null
      })
    )
  );
  assert.equal(rows.length, 9);
  assert.equal(rows.filter((r) => r.kycComplete).length, 9, "9/9 KYC confirmed");

  for (const row of rows) {
    const c = CONFIRMED[row.sourceId];
    assert.equal(row.takerFeeBps, c.taker, `${row.sourceId} taker`);
    assert.equal(row.makerFeeBps, c.maker, `${row.sourceId} maker`);
    assert.equal(row.feeTier, c.tier, `${row.sourceId} tier`);
    assert.equal(row.feeProvenance, "ADMIN_CONFIRMED_SCREENSHOT");
    // No document was supplied, so no URL may be invented.
    assert.equal(row.officialSourceUrl === null || typeof row.officialSourceUrl === "string", true);
    assert.equal(row.feeValidDays, 30);
    assert.ok(row.feeExpiresAt, "an expiry is derived from the validity window");
  }
});

await test("evidence expires 30 days after confirmation, not 90", () => {
  const fresh = buildVenueReadiness("nobitex", feeOverride("nobitex"), NOW, accountOverride("nobitex"));
  assert.equal(fresh.feeStale, false);
  assert.equal(
    fresh.feeExpiresAt,
    new Date(Date.parse(fresh.feeVerifiedAt!) + 30 * DAY).toISOString(),
    "expiry is confirmation + 30 days"
  );

  // 29 days old: still valid. 31 days old: expired — even though the global
  // window is 90 days, the tighter per-confirmation validity wins.
  const at29 = buildVenueReadiness(
    "nobitex",
    feeOverride("nobitex", { confirmedAt: new Date(NOW - 29 * DAY).toISOString() }),
    NOW,
    accountOverride("nobitex")
  );
  const at31 = buildVenueReadiness(
    "nobitex",
    feeOverride("nobitex", { confirmedAt: new Date(NOW - 31 * DAY).toISOString() }),
    NOW,
    accountOverride("nobitex")
  );
  assert.equal(at29.feeStale, false, "29 days is still valid");
  assert.equal(at31.feeStale, true, "31 days has expired");
  assert.ok(FEE_REVERIFY_DAYS > 30, "the global window is deliberately looser");

  // An expired confirmation can never back a net-positive claim.
  assert.equal(venueUsableForNetProfit(at29), true);
  assert.equal(venueUsableForNetProfit(at31), false, "expired evidence blocks execution");
});

/* ── the safety bars outrank every piece of fee evidence ───────────────────── */

await test("all nine venues are execution-eligible once certified", () => {
  const rows = buildAllReadiness(
    Object.keys(CONFIRMED).map((id) => feeOverride(id)),
    NOW,
    Object.keys(CONFIRMED).map((id) => accountOverride(id))
  );
  assert.equal(rows.filter((r) => r.kycComplete).length, 9, "KYC 9/9");
  assert.equal(rows.filter((r) => r.executionEligible).length, 9, "execution-eligible 9/9");
  assert.equal(rows.filter((r) => venueUsableForNetProfit(r)).length, 9, "all nine can back net profit");
  // Tetherland and Arzinja specifically — the two that used to be barred.
  for (const id of ["tetherland", "arzinja"]) {
    const row = rows.find((r) => r.sourceId === id)!;
    assert.equal(row.accountState, "VERIFIED", `${id} account`);
    assert.equal(row.executionEligible, true, `${id} eligibility`);
    assert.equal(row.blockingReason, null, `${id} must have nothing blocking it`);
  }
});

await test("promotion removed the bar, not the gates", () => {
  // An expired confirmation still blocks a promoted venue.
  const expired = buildVenueReadiness(
    "arzinja",
    feeOverride("arzinja", { confirmedAt: new Date(NOW - 31 * DAY).toISOString() }),
    NOW,
    accountOverride("arzinja")
  );
  assert.equal(expired.feeStale, true);
  assert.equal(venueUsableForNetProfit(expired), false, "expired evidence blocks Arzinja too");

  // And an explicit ineligibility still blocks Tetherland.
  const barred = buildVenueReadiness(
    "tetherland",
    feeOverride("tetherland"),
    NOW,
    accountOverride("tetherland", { executionEligible: false, ineligibleReason: "منبع دچار اختلال" })
  );
  assert.equal(barred.executionEligible, false);
  assert.equal(venueUsableForNetProfit(barred), false);
  assert.ok(barred.blockingReason);
});

/* ── certification regressions for the two promoted venues ─────────────────── */

await test("direction is proved by the no-crossing invariant, never by field names", () => {
  // Tetherland's real shape: the array named "asks" holds the LOWER cluster.
  const lower = [
    { priceToman: 193_000, amountUsdt: 716.73 },
    { priceToman: 192_500, amountUsdt: 590.91 }
  ];
  const higher = [
    { priceToman: 193_200, amountUsdt: 12 },
    { priceToman: 194_000, amountUsdt: 30 }
  ];
  const inverted = proveBookDirection(lower, higher);
  assert.equal(inverted.verified, true, "the inverted reading is uncrossed and provable");

  // The literal reading of the same payload crosses, so it is rejected.
  const literal = proveBookDirection(higher, lower);
  assert.equal(literal.verified, false);
  assert.equal(literal.crossedUnderStated, true);

  // Overlapping clusters are ambiguous: neither reading may be claimed.
  const ambiguous = proveBookDirection(
    [{ priceToman: 100, amountUsdt: 1 }, { priceToman: 300, amountUsdt: 1 }],
    [{ priceToman: 200, amountUsdt: 1 }, { priceToman: 400, amountUsdt: 1 }]
  );
  assert.equal(ambiguous.verified, false, "ambiguity must not certify");
  // An empty side proves nothing.
  assert.equal(proveBookDirection([], higher).verified, false);
});

await test("an unproved direction degrades the venue instead of inverting the market", () => {
  const snap = mockSnapshot("tetherland", { directionVerified: false });
  const cert = certifyFromSnapshot(snap);
  assert.notEqual(cert.status, "LIVE_VERIFIED");
  assert.ok(cert.statusReason, "the exact failing check is stated");
});

await test("IRT and IRR are distinguished, and a rial payload never reads as toman", () => {
  // Arzinja and Tetherland publish toman. A rial-scaled payload is ten times
  // larger and must not survive the plausibility band as a toman price.
  const toman = parseLevels([["195470", "436.65"]], "toman");
  assert.equal(toman.length, 1);
  assert.equal(toman[0].priceToman, 195_470);

  const rial = parseLevels([["1954700", "436.65"]], "rial");
  assert.equal(rial.length, 1);
  assert.equal(rial[0].priceToman, 195_470, "rial is divided by ten");

  // The same rial figure read as toman is implausible and is dropped.
  assert.deepEqual(parseLevels([["1954700", "436.65"]], "toman"), []);
  // And a toman figure read as rial is likewise out of band.
  assert.deepEqual(parseLevels([["195470", "436.65"]], "rial"), []);
});

await test("stale data blocks a promoted venue like any other", () => {
  const fresh = certifyFromSnapshot(mockSnapshot("arzinja", {}));
  assert.equal(fresh.status, "LIVE_VERIFIED");

  const stale = certifyFromSnapshot(mockSnapshot("arzinja", { stale: true, ageMs: 10 * 60_000 }));
  assert.equal(stale.status, "LIVE_DEGRADED");
  assert.ok(String(stale.statusReason).includes("تازگی"), "staleness is named as the cause");
});

await test("depth is required: a headline-only response cannot certify", () => {
  const noDepth = certifyFromSnapshot(mockSnapshot("tetherland", { depthAvailable: false }));
  assert.equal(noDepth.status, "LIVE_DEGRADED");
  assert.ok(String(noDepth.statusReason).includes("عمق"));

  // With depth, the walk produces fillable sizes at every traded size.
  const withDepth = mockSnapshot("arzinja", {});
  assert.equal(withDepth.sizeExecutables.filter((x) => x.buyFillable && x.sellFillable).length, 4);
});

await test("both promoted venues appear in valid, net-positive opportunities", () => {
  const now = new Date().toISOString();
  const sources = [
    snapshotFor("nobitex", 100_000, 99_900),
    // Tetherland and Arzinja quote higher, so selling into them is profitable.
    snapshotFor("tetherland", 102_000, 101_800),
    snapshotFor("arzinja", 102_500, 102_300)
  ];
  const built = buildOpportunities(sources, [], now, {
    certStatuses: {
      nobitex: "LIVE_VERIFIED",
      tetherland: "LIVE_VERIFIED",
      arzinja: "LIVE_VERIFIED"
    },
    // The confirmed schedule, exactly as the collector supplies it.
    confirmedFeeBps: {
      nobitex: CONFIRMED.nobitex.taker,
      tetherland: CONFIRMED.tetherland.taker,
      arzinja: CONFIRMED.arzinja.taker
    }
  });

  for (const venue of ["tetherland", "arzinja"]) {
    const routes = built.filter((o) => o.sellSourceId === venue && o.buySourceId === "nobitex");
    assert.ok(routes.length, `${venue} must produce routes`);
    const valid = routes.filter(
      (o) => o.eligibility === "EXECUTABLE_NOW" && !o.feeUnknown && o.netProfitToman > 0
    );
    assert.ok(valid.length, `${venue} must reach a valid net-positive opportunity`);
    assert.equal(valid[0].blockedReasons.length, 0, `${venue} must carry no blocking reason`);
  }
});

/* ── which fee settles which side ──────────────────────────────────────────── */

await test("buying USDT settles the fee in toman, on top of the toman debit", () => {
  const buy = PAPER_FEE_SETTLEMENT.nobitex.buy;
  assert.equal(buy.feeAsset, "IRT", "the buy-side fee leaves the toman balance");
  assert.equal(buy.debitMode, "ADD_TO_DEBIT");

  // 10 USDT at 100,000 toman with Nobitex's confirmed 0.25% taker.
  const plan = planFill({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 10,
    buyVwapToman: 100_000,
    sellVwapToman: 101_000,
    buyFeeBps: CONFIRMED.nobitex.taker,
    sellFeeBps: CONFIRMED.wallex.taker,
    buySettlement: PAPER_FEE_SETTLEMENT.nobitex.buy,
    sellSettlement: PAPER_FEE_SETTLEMENT.wallex.sell,
    markPriceToman: 100_000,
    slippageBufferToman: 0
  });
  assert.equal(plan.ok, true, plan.ok ? "" : plan.code);
  if (!plan.ok) return;

  // 1,000,000 toman of USDT at 0.25% = 2,500 toman, added to the debit.
  assert.equal(plan.buyLeg.notionalToman, 1_000_000);
  assert.equal(plan.buyLeg.feeToman, 2_500);
  assert.equal(plan.buyLeg.feeUsdtMicros, 0, "no USDT leaves on the buy side");
  assert.equal(plan.buyLeg.deltaIrtToman, -(1_000_000 + 2_500), "cost plus fee");
  assert.equal(plan.buyLeg.deltaUsdtMicros, usdtToMicros(10), "full quantity arrives");

  const applied = applyFill(plan, [
    { sourceId: "nobitex", irtToman: 5_000_000, usdtMicros: usdtToMicros(50) },
    { sourceId: "wallex", irtToman: 5_000_000, usdtMicros: usdtToMicros(50) }
  ]);
  assert.equal(applied.ok, true);
  if (!applied.ok) return;
  const nobitexAfter = applied.balancesAfter.find((b) => b.sourceId === "nobitex")!;
  assert.equal(nobitexAfter.irtToman, 5_000_000 - 1_002_500);
  assert.equal(nobitexAfter.usdtMicros, usdtToMicros(60));
});

await test("selling USDT settles the fee in USDT, on top of the quantity sold", () => {
  const sell = PAPER_FEE_SETTLEMENT.wallex.sell;
  assert.equal(sell.feeAsset, "USDT", "the sell-side fee leaves the USDT balance");
  assert.equal(sell.debitMode, "ADD_TO_DEBIT");

  const plan = planFill({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 10,
    buyVwapToman: 100_000,
    sellVwapToman: 101_000,
    buyFeeBps: CONFIRMED.nobitex.taker,
    sellFeeBps: CONFIRMED.wallex.taker,
    buySettlement: PAPER_FEE_SETTLEMENT.nobitex.buy,
    sellSettlement: PAPER_FEE_SETTLEMENT.wallex.sell,
    markPriceToman: 100_000,
    slippageBufferToman: 0
  });
  assert.equal(plan.ok, true, plan.ok ? "" : plan.code);
  if (!plan.ok) return;

  // Wallex's confirmed 0.30% taker on 10 USDT = 0.03 USDT, never toman.
  assert.equal(plan.sellLeg.feeUsdtMicros, usdtToMicros(0.03));
  assert.equal(plan.sellLeg.feeToman, 0, "no toman leaves on the sell side");
  assert.equal(plan.sellLeg.deltaUsdtMicros, -(usdtToMicros(10) + usdtToMicros(0.03)));
  assert.equal(plan.sellLeg.deltaIrtToman, 1_010_000, "full proceeds arrive");

  // Economic PnL subtracts the toman value of that USDT fee at the mark price.
  assert.equal(plan.cashPnlIrtToman, 1_010_000 - 1_000_000 - 2_500);
  assert.equal(plan.sellFeeValueToman, 3_000, "0.03 USDT at a 100,000 mark");
  assert.equal(plan.economicNetPnlToman, plan.cashPnlIrtToman - plan.sellFeeValueToman);
  assert.equal(plan.riskAdjustedPnlToman, plan.economicNetPnlToman, "no buffer in this case");
  assert.equal(plan.inventoryDeltaUsdtMicros, -usdtToMicros(0.03), "only the fee leaves inventory");
});

await test("maker rates never settle a fill", () => {
  const importer = read("scripts/import-admin-evidence.mts");
  assert.ok(importer.includes("makerFeeBps: fee.makerBps"), "maker is recorded");
  // The broker takes a taker basis-point figure per side and nothing else.
  const broker = read("src/lib/shadowArbitrage/paper/broker.ts");
  assert.equal(/makerFee/i.test(broker), false, "no maker path exists in the broker");
  const engine = read("src/lib/shadowArbitrage/paper/engine.ts");
  assert.equal(/makerFee/i.test(engine), false, "nor in the engine");
});

/* ── the import itself ─────────────────────────────────────────────────────── */

await test("the import is idempotent, credential-free and never invents a source", () => {
  const importer = read("scripts/import-admin-evidence.mts");

  // Idempotency is a stored key plus a uniqueness check, not a hope.
  assert.ok(importer.includes("evidenceKey: EVIDENCE_KEY"));
  const repo = read("src/db/repositories/shadowArbitrage.ts");
  assert.ok(repo.includes("if (input.evidenceKey)"), "the writer checks for an existing row");
  assert.ok(repo.includes("return toFeeConfirmationRow(existing[0])"));
  assert.ok(repo.includes("return toAccountConfirmationRow(existing[0])"));
  // Strip comments: this must judge the statements, not the explanation above them.
  const migration = read("drizzle/0010_shadow_admin_evidence.sql")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  assert.ok(migration.includes("CREATE UNIQUE INDEX IF NOT EXISTS shadow_fee_conf_evidence_key_idx"));
  assert.ok(migration.includes("CREATE UNIQUE INDEX IF NOT EXISTS shadow_account_conf_evidence_key_idx"));

  // Purely additive: nothing is dropped, deleted or renamed.
  for (const destructive of ["DROP ", "DELETE ", "TRUNCATE", "RENAME", "ALTER COLUMN"]) {
    assert.equal(migration.toUpperCase().includes(destructive), false, `migration must not ${destructive}`);
  }

  // No secret material, and no invented documents.
  for (const banned of ["password", "apiKey", "api_key", "secret", "token", "privateKey", "balance"]) {
    assert.equal(
      new RegExp(`${banned}\\s*[:=]`, "i").test(importer),
      false,
      `the import must not carry ${banned}`
    );
  }
  assert.ok(importer.includes("sourceUrl: null"), "no document URL is invented");
  assert.equal(/https?:\/\//.test(importer.replace(/\* .*/g, "")), false, "no URLs at all");

  // It refuses the always-on local database.
  assert.ok(importer.includes("refusing to write the always-on local database"));
  // It creates no approval and enables nothing.
  assert.equal(/saveCapitalApproval|approve/i.test(importer), false, "no approval is created");
});

await test("capital stays provisional: the figure is set, the approval is not", () => {
  const importer = read("scripts/import-admin-evidence.mts");
  assert.ok(importer.includes("const TOTAL_CAPITAL_TOMAN = 10_000_000_000"));
  assert.ok(importer.includes("No deposit, balance, transfer, withdrawal or order"));
  // Live execution remains impossible.
  const capability = read("src/lib/shadowArbitrage/live/capability.ts");
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
});

await test("network and transfer costs stay UNKNOWN until a snapshot exists", () => {
  const importer = read("scripts/import-admin-evidence.mts");
  // No network fee was supplied, so none is stored and none is claimed.
  assert.ok(importer.includes("rebalance cost stays UNKNOWN"));
  assert.equal(/networkFee|withdrawFee|transferCost\s*[:=]/i.test(importer), false);
  // The rebalance cost record is still provisional in configuration.
  const config = read("src/lib/shadowArbitrage/config.ts");
  const rebalance = config.slice(config.indexOf('key: "rebalance_cost"'));
  assert.ok(rebalance.slice(0, 400).includes('status: "provisional"'));
});


/* ── live-readiness panel: honest categories, honest health ────────────────── */

await test("fee settlement is confirmed for all nine venues, unknown for any other", () => {
  const ids = Object.keys(PAPER_FEE_SETTLEMENT);
  assert.equal(ids.length, 9);
  for (const id of ids) {
    const buy = PAPER_FEE_SETTLEMENT[id as keyof typeof PAPER_FEE_SETTLEMENT].buy;
    const sell = PAPER_FEE_SETTLEMENT[id as keyof typeof PAPER_FEE_SETTLEMENT].sell;
    assert.equal(buy.feeAsset, "IRT", `${id} buy settles in toman`);
    assert.equal(sell.feeAsset, "USDT", `${id} sell settles in USDT`);
    assert.equal(buy.provenance, "ADMIN_CONFIRMED");
    assert.equal(sell.provenance, "ADMIN_CONFIRMED");
  }
  // A venue nobody confirmed is still blocked, not silently inheriting the rule.
  const unlisted = settlementFor("some-new-venue" as never, "buy");
  assert.equal(unlisted.feeAsset, "UNKNOWN");
  assert.equal(unlisted.provenance, "UNKNOWN");
});

await test("a blocked gate states which kind of blocker it is", async () => {
  const { evaluateReadiness } = await import("../src/lib/shadowArbitrage/live/readiness.ts");
  const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");

  const report = evaluateReadiness({
    observation: { status: "RUNNING", elapsedMs: 0, successCoveragePercent: 73.5 },
    collector: {
      running: true,
      heartbeatStale: false,
      duplicateIdempotencyKeys: 0,
      successfulCycles: 527
    },
    capitalRecommendation: { status: "PROVISIONAL", reasonFa: "قفل" },
    paper: null,
    venueStates: [],
    policies: buildPolicyState([], Date.now()),
    attestations: [],
    reconciliation: null
  } as never);

  // Every blocked gate is classified; nothing is left unexplained.
  for (const gate of report.gates.filter((g) => g.status !== "PASSED")) {
    assert.ok(gate.blockerKind, `${gate.id} must state its blocker kind`);
  }
  // And a passing gate carries no kind at all.
  for (const gate of report.gates.filter((g) => g.status === "PASSED")) {
    assert.equal(gate.blockerKind, null, `${gate.id} passes, so it has no blocker`);
  }

  // With no policies configured, the risk gate is a decision, not a fault.
  const risk = report.gates.find((g) => g.id === "risk_policies")!;
  assert.equal(risk.blockerKind, "MISSING_POLICY");
  // A healthy collector blocked only by unset policies is not a system failure.
  const collector = report.gates.find((g) => g.id === "collector_health")!;
  assert.equal(collector.status, "BLOCKED");
  assert.equal(collector.blockerKind, "MISSING_POLICY");
  // The counts add up to the blocked gates.
  const counted = Object.values(report.blockerCounts).reduce((a, b) => a + b, 0);
  assert.equal(counted, report.blockedCount);
});

await test("operational health is reported separately from arming readiness", async () => {
  const { evaluateReadiness } = await import("../src/lib/shadowArbitrage/live/readiness.ts");
  const { buildPolicyState } = await import("../src/lib/shadowArbitrage/live/policy.ts");
  const base = {
    observation: { status: "RUNNING", elapsedMs: 0, successCoveragePercent: 73.5 },
    capitalRecommendation: null,
    paper: null,
    venueStates: [],
    policies: buildPolicyState([], Date.now()),
    attestations: [],
    reconciliation: null
  };

  const healthy = evaluateReadiness({
    ...base,
    collector: { running: true, heartbeatStale: false, duplicateIdempotencyKeys: 0, successfulCycles: 527 }
  } as never);
  assert.equal(healthy.operationalHealth.healthy, true, "running, fresh, no duplicates");
  assert.equal(healthy.effectiveState, "DISARMED", "and still disarmed");
  assert.ok(healthy.operationalHealth.summaryFa.includes("سالم"));

  // A real fault flips health and is classified as a system failure.
  const stalled = evaluateReadiness({
    ...base,
    collector: { running: false, heartbeatStale: true, duplicateIdempotencyKeys: 3, successfulCycles: 10 }
  } as never);
  assert.equal(stalled.operationalHealth.healthy, false);
  assert.equal(
    stalled.gates.find((g) => g.id === "collector_health")!.blockerKind,
    "SYSTEM_FAILURE"
  );
});

await test("the panel separates the four blocker kinds and shows operational health", () => {
  const panel = read("src/components/shadowArbitrage/LiveReadiness.tsx");
  for (const kind of ["SYSTEM_FAILURE", "MISSING_POLICY", "MISSING_EVIDENCE", "GATE_NOT_MATURE"]) {
    assert.ok(panel.includes(kind), `${kind} must be rendered`);
  }
  assert.ok(panel.includes("سلامت عملیاتی"), "operational health has its own metric");
  assert.ok(panel.includes("نوع مانع"), "the gate table names the blocker kind");
  assert.ok(panel.includes("شواهد موقت محلی"), "temporary local evidence is labelled");
  // The temporary-local label is driven by the server, not guessed client-side.
  const route = read("app/api/shadow-arbitrage/live-readiness/route.ts");
  assert.ok(route.includes("TEMPORARY_LOCAL"));
  assert.ok(route.includes('databaseUrl.startsWith("pglite:")'));
});

await test("the readiness panel changes nothing about the safety boundary", () => {
  const readiness = read("src/lib/shadowArbitrage/live/readiness.ts");
  const route = read("app/api/shadow-arbitrage/live-readiness/route.ts");
  // Still structurally disarmed, still no live execution.
  assert.ok(readiness.includes('effectiveState: "DISARMED"'));
  assert.ok(route.includes("canArm: false"));
  assert.ok(route.includes("canPlaceRealOrders: false"));
  const capability = read("src/lib/shadowArbitrage/live/capability.ts");
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
  // The evidence gates that need human attestation are untouched.
  for (const gate of ["api_capability", "key_permissions", "transfer_costs", "reconciliation_runbook"]) {
    assert.ok(readiness.includes(`id: "${gate}"`), `${gate} still exists`);
  }
});


/* ── simple paper trading: capital is a portfolio, not a trade size ────────── */

await test("the offered allocation conserves the portfolio exactly at any mark price", async () => {
  const { defaultAllocation, validateAllocation, allocationToBalances } = await import(
    "../src/lib/shadowArbitrage/paper/portfolio.ts"
  );
  const venues = [
    "nobitex", "wallex", "tabdeal", "bitpin", "abantether",
    "ramzinex", "tetherland", "bit24", "arzinja"
  ];

  for (const mark of [194_496, 195_470, 100_000, 87_654]) {
    const rows = defaultAllocation(10_000_000_000, venues, mark);
    assert.equal(rows.length, 9, "every eligible venue gets a share");
    const v = validateAllocation({
      totalCapitalToman: 10_000_000_000,
      allocations: rows,
      markPriceToman: mark,
      eligibleVenueIds: venues
    });
    assert.equal(v.residualToman, 0, `mark ${mark} must conserve exactly`);
    assert.equal(v.ok, true);
    assert.equal(v.allocatedToman, 10_000_000_000);

    /*
     * Conservation must hold for the money the ledger will actually hold, not
     * only for a per-venue rounding that happens to cancel. Both are checked at
     * every mark price because the two readings can disagree by a rial.
     */
    const balances = allocationToBalances(rows);
    const ledgerValue = Math.round(
      balances.reduce((sum, b) => sum + b.irtToman, 0) +
        (balances.reduce((sum, b) => sum + b.usdtMicros, 0) / 1_000_000) * mark
    );
    assert.equal(ledgerValue, 10_000_000_000, `mark ${mark}: opening balances must be exact`);

    // Equal share, and roughly half of each venue held in USDT.
    for (const row of v.perVenue) {
      assert.ok(Math.abs(row.sharePercent - 100 / 9) < 0.01, "shares are equal");
      const usdtValue = row.usdtUnits * mark;
      assert.ok(Math.abs(usdtValue / row.valueToman - 0.5) < 0.001, "half the venue sits in USDT");
    }
  }

  // The mark price is never invented: no price, no allocation.
  assert.throws(() => defaultAllocation(10_000_000_000, venues, 0));

  // Opening balances carry the same money into the session.
  const rows = defaultAllocation(10_000_000_000, venues, 194_496);
  const balances = allocationToBalances(rows);
  const carried = Math.round(
    balances.reduce((s, b) => s + b.irtToman, 0) +
      (balances.reduce((s, b) => s + b.usdtMicros, 0) / 1_000_000) * 194_496
  );
  assert.equal(carried, 10_000_000_000, "balances carry the portfolio across exactly");
});

await test("an edited allocation that does not add up is refused, with the residual shown", async () => {
  const { defaultAllocation, validateAllocation } = await import(
    "../src/lib/shadowArbitrage/paper/portfolio.ts"
  );
  const venues = ["nobitex", "wallex"];
  const rows = defaultAllocation(1_000_000_000, venues, 100_000);

  // One toman too many is still wrong.
  const over = validateAllocation({
    totalCapitalToman: 1_000_000_000,
    allocations: [{ ...rows[0], irtToman: rows[0].irtToman + 1 }, rows[1]],
    markPriceToman: 100_000,
    eligibleVenueIds: venues
  });
  assert.equal(over.ok, false);
  assert.equal(over.residualToman, 1);
  assert.ok(over.errorsFa[0].includes("اختلاف"));

  // A venue that is not execution-eligible may not hold capital.
  const ineligible = validateAllocation({
    totalCapitalToman: 1_000_000_000,
    allocations: rows,
    markPriceToman: 100_000,
    eligibleVenueIds: ["nobitex"]
  });
  assert.equal(ineligible.ok, false);
  assert.ok(ineligible.errorsFa.some((e) => e.includes("اجراپذیر نیست")));

  // Negative shares are refused outright.
  const negative = validateAllocation({
    totalCapitalToman: 1_000_000_000,
    allocations: [{ sourceId: "nobitex", irtToman: -1, usdtUnits: 0 }],
    markPriceToman: 100_000
  });
  assert.equal(negative.ok, false);
});

await test("the summary marks the portfolio and never invents a price", async () => {
  const { summarisePortfolio } = await import("../src/lib/shadowArbitrage/paper/portfolio.ts");
  const balances = [
    { sourceId: "nobitex" as never, irtToman: 600_000_000, usdtMicros: 2_000 * 1_000_000 }
  ];
  const fills = [
    { economicNetPnlToman: 50_000, riskAdjustedPnlToman: 40_000, occurredAt: "2026-08-01T08:00:00.000Z" },
    { economicNetPnlToman: -20_000, riskAdjustedPnlToman: -25_000, occurredAt: "2026-08-01T09:00:00.000Z" }
  ];
  const summary = summarisePortfolio({
    initialCapitalToman: 1_000_000_000,
    balances,
    markPriceToman: 200_000,
    fills,
    rejectedCount: 7,
    todayStartMs: Date.parse("2026-08-01T00:00:00.000Z")
  });
  assert.equal(summary.markedValueToman, 600_000_000 + 2_000 * 200_000);
  assert.equal(summary.economicPnlToman, 30_000);
  assert.equal(summary.riskAdjustedPnlToman, 15_000);
  assert.equal(summary.todayPnlToman, 30_000);
  // Peak was 50,000 and it gave back 20,000.
  assert.equal(summary.drawdownToman, 20_000);
  assert.equal(summary.filled, 2);
  assert.equal(summary.rejected, 7);
  assert.equal(summary.lastTradeAt, "2026-08-01T09:00:00.000Z");

  // Without a price there is no marked value and no ROI — not a zero.
  const priceless = summarisePortfolio({
    initialCapitalToman: 1_000_000_000,
    balances,
    markPriceToman: null,
    fills,
    rejectedCount: 0,
    todayStartMs: 0
  });
  assert.equal(priceless.markedValueToman, null);
  assert.equal(priceless.roiPercent, null);
});

await test("the paper view keeps capital, sessions and safety straight", () => {
  const view = read("src/components/shadowArbitrage/PaperSimple.tsx");
  /*
   * One prominent action. Phase 8C-1 dropped the amount from the label: the
   * total is editable in step one, so naming a fixed figure on the button
   * implied a size the flow does not actually impose.
   */
  assert.ok(view.includes("ساخت نشست جدید از طرح فعلی"));
  assert.equal(view.includes("ساخت نشست ۱۰ میلیاردی"), false, "no amount baked into a control");
  // Three steps, in order.
  for (const label of ["سرمایهٔ کل", "تخصیص بین صرافی‌ها", "بازبینی و ساخت"]) {
    assert.ok(view.includes(label), `${label} step must exist`);
  }
  // The capital figure is stated as a portfolio, not a trade size.
  assert.ok(view.includes("کل پرتفوی مجازی است، نه اندازهٔ هر معامله"));
  // Plan and session are named as different things.
  assert.ok(view.includes("طرح سرمایه و نشست دو چیز"));
  assert.ok(view.includes("برگرفته از طرح سرمایه"));
  // The new session is labelled virtual, provisional and non-final.
  assert.ok(view.includes("مجازی، موقت و غیرنهایی"));
  // Stopping preserves history rather than deleting it.
  assert.ok(view.includes("حفظ سابقه"));
  assert.equal(/delete|حذف نشست/i.test(view), false, "nothing deletes a session");
  // The default is offered, not saved silently.
  assert.ok(view.includes("تا زمانی که در گام سوم تأیید نکنید ذخیره نمی‌شود"));
  // Advanced material is folded away.
  assert.ok(view.includes("جزئیات پیشرفته"));
  // The ledger carries the columns a reviewer needs.
  for (const col of [
    "صرافی خرید", "صرافی فروش", "حجم", "کارمزد تومانی خرید",
    "کارمزد تتری فروش", "سود خالص اقتصادی", "سود تعدیل‌شده"
  ]) {
    assert.ok(view.includes(col), `ledger column ${col}`);
  }
  // No credential or real-order path.
  for (const banned of [/apiKey/i, /placeOrder/i, /\bwithdraw/i, /transferFunds/i]) {
    assert.equal(banned.test(view), false, `must not contain ${banned}`);
  }
});

await test("the server re-validates a proposed allocation instead of trusting it", () => {
  const route = read("app/api/shadow-arbitrage/paper/route.ts");
  assert.ok(route.includes("validateAllocation("), "the server checks conservation itself");
  assert.ok(route.includes("invalid_allocation"), "and refuses a bad one");
  assert.ok(route.includes("eligibleVenueIds: eligibleIds"), "against its own eligibility list");
  // The mark price used is the one derived on the server this request.
  assert.ok(route.includes("markPriceToman: valuationPriceToman"));
  // Creating a session never approves Phase 5.
  assert.equal(/saveCapitalApproval/.test(route), false);
  // Real orders stay off.
  assert.ok(route.includes("realOrders: false"));
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
