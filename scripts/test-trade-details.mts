#!/usr/bin/env npx tsx
/**
 * Read-only trade details view — pure unit tests.
 * No database, no network, no production contact.
 */
import assert from "node:assert/strict";
import {
  MISSING_FA,
  buildTradeDetailsView,
  listMissingTradeEvidenceKeys,
  type ClosedTradeEvidence
} from "../src/lib/shadowArbitrage/paper/tradeDetailsView.ts";
import {
  TOMAN_TO_RIAL,
  UNCOMPUTABLE_FA,
  experimentTotalsCoverage,
  netProfitPerUsdt,
  netReturnOnCapital,
  summarizeTradeSet,
  tomanToRial,
  totalModeledFeeToman
} from "../src/lib/shadowArbitrage/paper/tradeProfitability.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

const sample: ClosedTradeEvidence = {
  id: "ledger-1",
  sessionId: "sess-1",
  runId: "cycle-1",
  experimentRunId: "exp-1",
  lifecycleId: "life-1",
  routeKey: "nobitex->wallex",
  buySourceId: "nobitex",
  sellSourceId: "wallex",
  sizeUsdt: 100,
  buyVwapToman: 200_000,
  sellVwapToman: 201_000,
  buyNotionalToman: 20_000_000,
  sellNotionalToman: 20_100_000,
  buyFeeBps: 10,
  sellFeeBps: 10,
  buyFeeAsset: "IRT",
  sellFeeAsset: "USDT",
  feeTomanTotal: 20_000,
  feeUsdtMicrosTotal: 100_000,
  sellFeeValueToman: 20_000,
  grossSpreadToman: 100_000,
  cashPnlIrtToman: 80_000,
  economicNetPnlToman: 60_000,
  riskAdjustedPnlToman: 55_000,
  slippageBufferToman: 5_000,
  markPriceToman: 200_500,
  occurredAt: "2026-08-05T12:00:00.000Z",
  outcome: "FILLED",
  sizingPolicy: "SMART_CAPITAL_DEPTH",
  sizingReason: "حداکثر سود تعدیل‌شده در ظرفیت قابل‌استفاده",
  bindingConstraint: "depth_cap",
  limitingSide: "buy",
  limitingSourceId: "nobitex",
  limitingUsableUsdtMicros: 150_000_000,
  capitalCapUsdtMicros: 500_000_000,
  depthCapUsdtMicros: 120_000_000,
  selectedPercentOfUsable: 66.67,
  nextLargerSizeUsdt: 120,
  nextLargerRejectionCode: "depth_insufficient",
  nextLargerRejectionReason: "عمق برای حجم بزرگ‌تر کافی نیست"
};

test("duration is zero and both endpoints are occurredAt (atomic dual-leg)", () => {
  const v = buildTradeDetailsView(sample);
  assert.equal(v.timeline.duration.durationMs, 0);
  assert.equal(v.timeline.duration.startField, "occurredAt");
  assert.equal(v.timeline.duration.endField, "occurredAt");
  assert.equal(v.timeline.duration.startIso, sample.occurredAt);
  assert.equal(v.timeline.buyFillAt.status, "present");
  assert.equal(v.timeline.sellFillAt.status, "present");
  assert.equal(v.timeline.buyFillAt.value, sample.occurredAt);
  assert.equal(v.timeline.completionAt.value, sample.occurredAt);
});

test("separate decision/order/submission timestamps are missing, not zero", () => {
  const v = buildTradeDetailsView(sample);
  assert.equal(v.timeline.decisionAt.status, "missing");
  assert.equal(v.timeline.orderCreatedAt.status, "missing");
  assert.equal(v.timeline.submissionAt.status, "missing");
  assert.notEqual(v.timeline.decisionAt.missingFa, "0");
  assert.ok(v.timeline.decisionAt.missingFa.includes("ثبت") || v.timeline.decisionAt.missingFa.length > 0);
});

test("fee and net P&L render from persisted fields only", () => {
  const v = buildTradeDetailsView(sample);
  assert.equal(v.transaction.feeTomanTotal.value, 20_000);
  assert.equal(v.transaction.feeUsdtMicros.value, 100_000);
  assert.equal(v.transaction.economicNetPnl.value, 60_000);
  assert.equal(v.transaction.cashPnl.value, 80_000);
  assert.equal(v.transaction.grossSpread.value, 100_000);
});

test("missing economic PnL is missing, not zero", () => {
  const v = buildTradeDetailsView({
    ...sample,
    economicNetPnlToman: null,
    cashPnlIrtToman: null
  });
  assert.equal(v.transaction.economicNetPnl.status, "missing");
  assert.equal(v.transaction.economicNetPnl.value, null);
  assert.equal(v.transaction.cashPnl.status, "missing");
});

test("sizing evidence: binding constraint and next-larger rejection when present", () => {
  const v = buildTradeDetailsView(sample);
  assert.equal(v.sizing.bindingConstraint.value, "depth_cap");
  assert.equal(v.sizing.nextLargerSizeUsdt.value, 120);
  assert.equal(v.sizing.nextLargerRejectionCode.value, "depth_insufficient");
  assert.equal(v.sizing.capitalCapUsdt.value, 500);
  assert.equal(v.sizing.depthCapUsdt.value, 120);
});

test("utilization before/after and candidate list are missing in current ledger", () => {
  const v = buildTradeDetailsView(sample);
  assert.equal(v.sizing.utilBefore.status, "missing");
  assert.equal(v.sizing.utilAfter.status, "missing");
  assert.equal(v.sizing.candidatesEvaluated.status, "missing");
  assert.equal(v.sizing.availableIrt.status, "missing");
});

test("technical IDs: ledger and lifecycle present; order/fill/idempotency missing", () => {
  const v = buildTradeDetailsView(sample, {
    policyFingerprint: "fp-abc",
    releaseVersion: "4.1.10.1"
  });
  assert.equal(v.technical.ledgerId.value, "ledger-1");
  assert.equal(v.technical.lifecycleId.value, "life-1");
  assert.equal(v.technical.sessionId.value, "sess-1");
  assert.equal(v.technical.runId.value, "cycle-1");
  assert.equal(v.technical.experimentId.value, "exp-1");
  assert.equal(v.technical.policyFingerprint.value, "fp-abc");
  assert.equal(v.technical.orderId.status, "missing");
  assert.equal(v.technical.fillId.status, "missing");
  assert.equal(v.technical.idempotencyKey.status, "missing");
  assert.equal(v.technical.decisionId.status, "missing");
});

test("missing field keys are listed for the audit report", () => {
  const v = buildTradeDetailsView(sample);
  const keys = listMissingTradeEvidenceKeys(v);
  assert.ok(keys.includes("timeline.decisionAt"));
  assert.ok(keys.includes("sizing.utilBefore"));
  assert.ok(keys.includes("technical.orderId"));
  assert.ok(!keys.includes("transaction.sizeUsdt"));
  assert.ok(!keys.includes("timeline.buyFillAt"));
});

test("MISSING_FA constant is stable Persian", () => {
  assert.equal(MISSING_FA, "ثبت نشده");
});

test("does not invent buy price when VWAP null", () => {
  const v = buildTradeDetailsView({
    ...sample,
    buyVwapToman: null,
    sellVwapToman: null
  });
  assert.equal(v.transaction.buyVwap.status, "missing");
  assert.equal(v.transaction.sellVwap.status, "missing");
  assert.equal(v.transaction.buyPrice.status, "missing");
});

test("toman-to-rial is ×10 presentation only", () => {
  assert.equal(TOMAN_TO_RIAL, 10);
  assert.equal(tomanToRial(1), 10);
  assert.equal(tomanToRial(60_000), 600_000);
  assert.equal(tomanToRial(-1.5), -15);
});

test("profit per USDT uses size once", () => {
  assert.equal(netProfitPerUsdt(60_000, 100), 600);
  assert.equal(netProfitPerUsdt(60_000, 0), null);
  assert.equal(netProfitPerUsdt(null, 100), null);
});

test("net return percent and bps on buy notional", () => {
  const r = netReturnOnCapital(60_000, 20_000_000);
  assert.ok(r);
  assert.equal(r!.percent, 0.3);
  assert.equal(r!.bps, 30);
  assert.equal(netReturnOnCapital(60_000, null), null);
  assert.equal(netReturnOnCapital(60_000, 0), null);
});

test("no double-counting of two-leg volume in set summary", () => {
  const s = summarizeTradeSet([
    {
      sizeUsdt: 100,
      grossSpreadToman: 100_000,
      feeTomanTotal: 20_000,
      feeUsdtMicrosTotal: 0,
      sellFeeValueToman: 0,
      economicNetPnlToman: 60_000,
      buyNotionalToman: 20_000_000
    },
    {
      sizeUsdt: 50,
      grossSpreadToman: 40_000,
      feeTomanTotal: 5_000,
      feeUsdtMicrosTotal: 0,
      sellFeeValueToman: 0,
      economicNetPnlToman: 30_000,
      buyNotionalToman: 10_000_000
    }
  ]);
  // 100 + 50, not 100*2 + 50*2
  assert.equal(s.volumeUsdt, 150);
  assert.equal(s.tradeCount, 2);
  assert.equal(s.economicNet.ok && s.economicNet.money.toman, 90_000);
  assert.equal(s.profitableCount, 2);
});

test("zero volume and missing fee handling", () => {
  assert.equal(netProfitPerUsdt(10, 0), null);
  const feeMissing = totalModeledFeeToman({
    feeTomanTotal: 1000,
    feeUsdtMicrosTotal: 50_000,
    sellFeeValueToman: null
  });
  assert.equal(feeMissing.ok, false);
  if (!feeMissing.ok) assert.ok(feeMissing.reasonFa.includes(UNCOMPUTABLE_FA));

  const feeOk = totalModeledFeeToman({
    feeTomanTotal: 1000,
    feeUsdtMicrosTotal: 50_000,
    sellFeeValueToman: 2000
  });
  assert.equal(feeOk.ok, true);
  if (feeOk.ok) assert.equal(feeOk.toman, 3000);

  const s = summarizeTradeSet([
    {
      sizeUsdt: 10,
      grossSpreadToman: 100,
      feeTomanTotal: 1,
      feeUsdtMicrosTotal: 1000,
      sellFeeValueToman: null,
      economicNetPnlToman: -5,
      buyNotionalToman: 1000
    }
  ]);
  assert.equal(s.totalFees.ok, false);
  assert.equal(s.losingCount, 1);
});

test("complete-run totals vs page: coverage gap when loaded < server", () => {
  const gap = experimentTotalsCoverage({ loadedFilledCount: 20, serverFilledCount: 100 });
  assert.equal(gap.complete, false);
  assert.ok(gap.gapFa && gap.gapFa.includes("20"));
  assert.ok(gap.gapFa && gap.gapFa.includes("100"));

  const ok = experimentTotalsCoverage({ loadedFilledCount: 100, serverFilledCount: 100 });
  assert.equal(ok.complete, true);
  assert.equal(ok.gapFa, null);

  const unknown = experimentTotalsCoverage({ loadedFilledCount: 50, serverFilledCount: null });
  assert.equal(unknown.complete, false);
});

test("profitability on detail view prefers economic net", () => {
  const v = buildTradeDetailsView(sample);
  assert.ok(v.profitability.economicNet.ok);
  if (v.profitability.economicNet.ok) {
    assert.equal(v.profitability.economicNet.money.toman, 60_000);
    assert.equal(v.profitability.economicNet.money.rial, 600_000);
  }
  assert.ok(v.profitability.profitPerUsdt.ok);
  if (v.profitability.profitPerUsdt.ok) {
    assert.equal(v.profitability.profitPerUsdt.money.toman, 600);
  }
});

test("filter summary is independent of page slice size", () => {
  const trades = Array.from({ length: 25 }, (_, i) => ({
    sizeUsdt: 10,
    grossSpreadToman: 1000,
    feeTomanTotal: 100,
    feeUsdtMicrosTotal: 0,
    sellFeeValueToman: 0,
    economicNetPnlToman: i % 2 === 0 ? 500 : -200,
    buyNotionalToman: 100_000
  }));
  const full = summarizeTradeSet(trades);
  const page = summarizeTradeSet(trades.slice(0, 20));
  assert.equal(full.tradeCount, 25);
  assert.equal(page.tradeCount, 20);
  assert.notEqual(full.volumeUsdt, page.volumeUsdt);
  assert.equal(full.volumeUsdt, 250);
  assert.equal(page.volumeUsdt, 200);
});


await test("fee attribution per venue and reconciliation", async () => {
  const { buildFeeAttribution, historicalUsdtRateFromFee } = await import(
    "../src/lib/shadowArbitrage/paper/feeAttribution.ts"
  );
  assert.equal(historicalUsdtRateFromFee(18600, 100_000), 186000);
  assert.equal(historicalUsdtRateFromFee(null, 100_000), null);
  const v = buildFeeAttribution({
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 100,
    buyNotionalToman: 18_600_000,
    sellNotionalToman: 18_650_000,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    feeTomanTotal: 18_600,
    feeUsdtMicrosTotal: 100_000,
    sellFeeValueToman: 18_600,
    grossSpreadToman: 50_000,
    economicNetPnlToman: 12_800,
    markPriceToman: 186_000,
    slippageBufferToman: 0
  });
  assert.equal(v.buy.venueId, "nobitex");
  assert.equal(v.sell.venueId, "wallex");
  assert.equal(v.buy.currency, "IRT");
  assert.equal(v.sell.currency, "USDT");
  assert.equal(v.sell.conversionRateTomanPerUsdt, 186_000);
  assert.equal(v.total.ok, true);
  assert.equal(v.reconciliation.matches, true);
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
