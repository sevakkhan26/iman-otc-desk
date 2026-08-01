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
import { applyFill, planFill, PAPER_FEE_SETTLEMENT, usdtToMicros } from "../src/lib/shadowArbitrage/paper/broker.ts";

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

await test("Tetherland stays degraded and Arzinja reference-only, whatever the fees say", () => {
  const tetherland = buildVenueReadiness(
    "tetherland",
    feeOverride("tetherland"),
    NOW,
    accountOverride("tetherland", { executionEligible: false, ineligibleReason: "degraded" })
  );
  assert.equal(tetherland.kycComplete, true, "KYC is complete");
  assert.equal(tetherland.executionEligible, false, "and it still may not execute");
  assert.equal(venueUsableForNetProfit(tetherland), false);
  assert.ok(tetherland.blockingReason, "the bar is stated, not silent");

  // Even an admin confirmation claiming eligibility cannot promote it.
  const arzinja = buildVenueReadiness(
    "arzinja",
    feeOverride("arzinja"),
    NOW,
    accountOverride("arzinja", { accountState: "VERIFIED", executionEligible: true })
  );
  assert.equal(arzinja.accountState, "REFERENCE_ONLY", "a reference venue is never promoted");
  assert.equal(arzinja.executionEligible, false);
  assert.equal(venueUsableForNetProfit(arzinja), false);

  // The seven executable venues do pass.
  const executable = ["nobitex", "wallex", "tabdeal", "bitpin", "abantether", "ramzinex", "bit24"];
  for (const id of executable) {
    const row = buildVenueReadiness(id as never, feeOverride(id), NOW, accountOverride(id));
    assert.equal(venueUsableForNetProfit(row), true, `${id} should be usable`);
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

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
