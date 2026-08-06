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

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
