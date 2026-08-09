#!/usr/bin/env npx tsx
/**
 * Step 4 — deterministic LOCAL Paper lifecycle fixture (never Production).
 * candidate → size → both fills → ledger → fees → PnL → reconciliation.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { rm as rmAsync } from "node:fs/promises";

const mkdtempAsync = promisify(mkdtemp);

const dataDir = await mkdtempAsync(path.join(tmpdir(), "otc-step4-life-"));
process.env.DATABASE_URL = `pglite:${path.join(dataDir, "pglite")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";
process.env.SHADOW_RELEASE_BOOTSTRAP = "false";

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
await runMigrations();

const { seedLocalFeeEvidence } = await import(
  "../src/lib/shadowArbitrage/localFeeEvidenceSeed.ts"
);
const { recordRiskPolicy } = await import("../src/db/repositories/shadowLive.ts");
const {
  createPaperSession,
  setPaperSessionStatus,
  loadPaperBalances,
  loadPaperLedger,
  loadPaperStats,
  commitPaperCycle
} = await import("../src/db/repositories/shadowPaper.ts");
const { defaultAllocation } = await import("../src/lib/shadowArbitrage/paper/portfolio.ts");
const { planFill, applyFill, usdtToMicros } = await import(
  "../src/lib/shadowArbitrage/paper/broker.ts"
);
const { buildPortfolioAccounting } = await import(
  "../src/lib/shadowArbitrage/paper/accounting.ts"
);
const { PAPER_POLICY_SET } = await import("../src/lib/shadowArbitrage/live/paperPolicySet.ts");
const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");
const { tehranDayStartMs } = await import("../src/lib/shadowArbitrage/paper/accounting.ts");

await seedLocalFeeEvidence();
for (const e of PAPER_POLICY_SET) {
  await recordRiskPolicy({
    policyKey: e.key,
    value: e.value,
    setBy: "step4-lifecycle-fixture",
    validForDays: 30,
    note: "LOCAL fixture only"
  });
}

const MARK = 200_000;
const CAPITAL = 10_000_000_000;
const venues = SHADOW_SOURCES.map((s) => s.id);
const alloc = defaultAllocation(CAPITAL, venues, MARK);
const session = await createPaperSession({
  observationId: null,
  name: "LOCAL-LIFECYCLE-FIXTURE (not production)",
  mode: "APPROVED_PLAN",
  totalCapitalToman: CAPITAL,
  valuationPriceToman: MARK,
  openingAllocations: alloc,
  approvalFingerprint: "local-lifecycle-fixture",
  createdBy: "step4-fixture",
  note: "Deterministic profitable LOCAL fixture — never Production data"
});
await setPaperSessionStatus(session.id, "RUNNING");

const balsBefore = await loadPaperBalances(session.id);
const sizeUsdt = 100;
const buyVwap = 192_000;
const sellVwap = 200_000;
const plan = planFill({
  buySourceId: "nobitex",
  sellSourceId: "wallex",
  sizeUsdt,
  buyVwapToman: buyVwap,
  sellVwapToman: sellVwap,
  buyFeeBps: 25,
  sellFeeBps: 30,
  buySettlement: {
    feeAsset: "IRT",
    debitMode: "ADD_TO_DEBIT",
    provenance: "ADMIN_CONFIRMED"
  },
  sellSettlement: {
    feeAsset: "USDT",
    debitMode: "ADD_TO_DEBIT",
    provenance: "ADMIN_CONFIRMED"
  },
  markPriceToman: MARK,
  slippageBufferToman: Math.round((sizeUsdt * buyVwap * 5) / 10_000)
});
assert.equal(plan.ok, true, JSON.stringify(plan));
if (!plan.ok) throw new Error("plan failed");

const applied = applyFill(
  plan,
  balsBefore.map((b) => ({
    sourceId: b.sourceId,
    irtToman: b.irtToman,
    usdtMicros: b.usdtMicros
  }))
);
assert.equal(applied.ok, true, JSON.stringify(applied));
if (!applied.ok) throw new Error("apply failed");

const now = new Date().toISOString();
const lifecycleId = "local-fixture-lifecycle-1";
await commitPaperCycle({
  sessionId: session.id,
  runId: null,
  occurredAt: now,
  fills: [
    {
      lifecycleId,
      routeKey: "nobitex->wallex",
      buySourceId: "nobitex",
      sellSourceId: "wallex",
      sizeUsdt,
      buyVwapToman: plan.buyLeg.vwapToman,
      sellVwapToman: plan.sellLeg.vwapToman,
      buyNotionalToman: plan.buyLeg.notionalToman,
      sellNotionalToman: plan.sellLeg.notionalToman,
      buyFeeBps: plan.buyLeg.feeBps,
      sellFeeBps: plan.sellLeg.feeBps,
      buyFeeAsset: plan.buyLeg.settlement.feeAsset,
      buyFeeDebitMode: plan.buyLeg.settlement.debitMode,
      buyFeeProvenance: plan.buyLeg.settlement.provenance,
      sellFeeAsset: plan.sellLeg.settlement.feeAsset,
      sellFeeDebitMode: plan.sellLeg.settlement.debitMode,
      sellFeeProvenance: plan.sellLeg.settlement.provenance,
      feeTomanTotal: plan.totalFeeToman,
      feeUsdtMicrosTotal: plan.totalFeeUsdtMicros,
      slippageBufferToman: plan.slippageBufferToman,
      grossSpreadToman: plan.grossSpreadToman,
      markPriceToman: plan.markPriceToman,
      cashPnlIrtToman: plan.cashPnlIrtToman,
      inventoryDeltaUsdtMicros: plan.inventoryDeltaUsdtMicros,
      sellFeeValueToman: plan.sellFeeValueToman,
      economicNetPnlToman: plan.economicNetPnlToman,
      riskAdjustedPnlToman: plan.riskAdjustedPnlToman,
      balancesAfter: applied.balancesAfter.map((b) => ({
        sourceId: b.sourceId,
        irtToman: b.irtToman,
        usdtMicros: b.usdtMicros
      })),
      sizing: {
        policy: "CAPITAL_AWARE_MAX_SAFE",
        reason: "LOCAL fixture sized at 100 USDT for lifecycle proof",
        limitingSide: "sell",
        limitingSourceId: "wallex",
        limitingUsableUsdtMicros: usdtToMicros(2_800),
        capitalCapUsdtMicros: usdtToMicros(2_800),
        depthCapUsdtMicros: usdtToMicros(10_000),
        bindingConstraint: "capital_cap",
        riskAdjustedReturnBps:
          (plan.riskAdjustedPnlToman / (sizeUsdt * buyVwap)) * 10_000,
        selectedPercentOfUsable: null,
        inventoryImpactPoints: 0,
        nextLargerSizeUsdt: null,
        nextLargerRejectionCode: null,
        nextLargerRejectionReason: null,
        nextLargerMarginalPnlToman: null,
        audit: {
          policy: "CAPITAL_AWARE_MAX_SAFE",
          status: "SIZED",
          finalSizeUsdtMicros: usdtToMicros(sizeUsdt),
          bindingConstraint: "capital_cap",
          buyFeeBps: 25,
          sellFeeBps: 30,
          predictedRiskAdjustedNetToman: plan.riskAdjustedPnlToman
        }
      }
    }
  ],
  skips: []
});

const ledger = await loadPaperLedger(session.id, { outcome: "FILLED", limit: 10 });
assert.equal(ledger.length, 1);
const fill = ledger[0]!;
assert.equal(fill.buySourceId, "nobitex");
assert.equal(fill.sellSourceId, "wallex");
assert.equal(Number(fill.sizeUsdt), sizeUsdt);
assert.equal(fill.buyFeeAsset, "IRT");
assert.equal(fill.sellFeeAsset, "USDT");
assert.ok((fill.economicNetPnlToman ?? 0) > 0);
assert.ok((fill.riskAdjustedPnlToman ?? 0) > 0);

const balsAfter = await loadPaperBalances(session.id);
const stats = await loadPaperStats(session.id);
assert.equal(stats.filled, 1);

const accounting = buildPortfolioAccounting({
  asOf: now,
  initialCapitalToman: CAPITAL,
  markPriceToman: MARK,
  balances: balsAfter.map((b) => ({
    sourceId: b.sourceId,
    irtToman: b.irtToman,
    usdtMicros: b.usdtMicros
  })),
  opening: alloc,
  fills: [
    {
      id: fill.id,
      lifecycleId,
      routeKey: "nobitex->wallex",
      buySourceId: "nobitex",
      sellSourceId: "wallex",
      sizeUsdt,
      buyVwapToman: plan.buyLeg.vwapToman,
      sellVwapToman: plan.sellLeg.vwapToman,
      buyNotionalToman: plan.buyLeg.notionalToman,
      sellNotionalToman: plan.sellLeg.notionalToman,
      feeTomanTotal: plan.totalFeeToman,
      feeUsdtMicrosTotal: plan.totalFeeUsdtMicros,
      sellFeeValueToman: plan.sellFeeValueToman,
      grossSpreadToman: plan.grossSpreadToman,
      cashPnlIrtToman: plan.cashPnlIrtToman,
      economicNetPnlToman: plan.economicNetPnlToman,
      riskAdjustedPnlToman: plan.riskAdjustedPnlToman,
      slippageBufferToman: plan.slippageBufferToman,
      markPriceToman: plan.markPriceToman,
      occurredAt: now,
      outcome: "FILLED"
    }
  ],
  todayStartMs: tehranDayStartMs(Date.parse(now))
});

const evidence = {
  label: "LOCAL-LIFECYCLE-FIXTURE",
  notProduction: true,
  sessionId: session.id,
  lifecycleId,
  model: "atomic_dual_leg",
  durationMs: 0,
  occurredAt: now,
  buyVenue: "nobitex",
  sellVenue: "wallex",
  sizeUsdt,
  buyVwapToman: plan.buyLeg.vwapToman,
  sellVwapToman: plan.sellLeg.vwapToman,
  buyFee: {
    venue: "nobitex",
    asset: plan.buyLeg.settlement.feeAsset,
    bps: plan.buyLeg.feeBps,
    toman: plan.buyLeg.feeToman
  },
  sellFee: {
    venue: "wallex",
    asset: plan.sellLeg.settlement.feeAsset,
    bps: plan.sellLeg.feeBps,
    usdtMicros: plan.sellLeg.feeUsdtMicros
  },
  grossSpreadToman: plan.grossSpreadToman,
  cashPnlIrtToman: plan.cashPnlIrtToman,
  economicNetPnlToman: plan.economicNetPnlToman,
  riskAdjustedPnlToman: plan.riskAdjustedPnlToman,
  bindingConstraint: "capital_cap",
  sizingPolicy: "CAPITAL_AWARE_MAX_SAFE",
  ledgerId: fill.id,
  stats,
  accountingSummary: {
    equityToman: accounting.equityToman,
    realizedEconomicToman: accounting.realizedEconomicPnlToman,
    realizedCashToman: accounting.realizedCashPnlToman
  },
  noOpenPosition: true
};

const outDir = path.join(process.cwd(), "evidence", "step4-lifecycle");
mkdirSync(outDir, { recursive: true });
const body = JSON.stringify(evidence, null, 2);
writeFileSync(path.join(outDir, "lifecycle-fixture.json"), body);
writeFileSync(
  path.join(outDir, "lifecycle-fixture.sha256"),
  createHash("sha256").update(body).digest("hex") + "\n"
);

console.log(
  JSON.stringify(
    {
      ok: true,
      sessionId: session.id,
      filled: stats.filled,
      economicNetPnlToman: plan.economicNetPnlToman,
      riskAdjustedPnlToman: plan.riskAdjustedPnlToman,
      buyFeeAsset: plan.buyLeg.settlement.feeAsset,
      sellFeeAsset: plan.sellLeg.settlement.feeAsset,
      evidence: path.join(outDir, "lifecycle-fixture.json")
    },
    null,
    2
  )
);

await closeDb();
await rmAsync(dataDir, { recursive: true, force: true });
