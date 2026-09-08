#!/usr/bin/env npx tsx
/**
 * PAPER-V2 Phase 1A / 1B / 1D — unit coverage (no push / no Live).
 */
import assert from "node:assert/strict";

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

const {
  validateFeeHorizonForRun,
  feeExpiryWarnings,
  assessRuntimeFeeHorizon,
  toEconomicsValidityAudit,
  FEE_WARNING_WINDOWS_MS,
  feeWarningLevelForMsUntil
} = await import("../src/lib/shadowArbitrage/paper/feeHorizon.ts");

const { assessCanonicalFeeEvidenceFreshness, EXPIRES_AT, RELEASE_KEY } = await import(
  "../src/lib/shadowArbitrage/releaseBootstrap.ts"
);

const { buildRejectDiagnostics } = await import(
  "../src/lib/shadowArbitrage/paper/rejectDiagnostics.ts"
);

const {
  buildVenueHealthSplit,
  classifyMarketDataHealth,
  classifyExecutionReadiness,
  summarizeHealthSplit
} = await import("../src/lib/shadowArbitrage/paper/dataHealth.ts");

type V = import("../src/lib/shadowArbitrage/effectiveFees.ts").VenueEffectiveFee;

function venue(over: Partial<V> & { sourceId: string }): V {
  return {
    sourceId: over.sourceId,
    nameFa: over.nameFa ?? over.sourceId,
    executionMode: over.executionMode ?? "ORDER_BOOK",
    executionModeFa: "دفتر سفارش",
    currentTierLabel: over.currentTierLabel ?? "Base",
    evidenceTierLabel: over.evidenceTierLabel ?? "Base",
    ok: over.ok ?? true,
    makerFeeBps: over.makerFeeBps ?? 25,
    takerFeeBps: over.takerFeeBps ?? 25,
    provenance: over.provenance ?? "ADMIN_CONFIRMED_SCREENSHOT",
    evidenceKey: over.evidenceKey ?? "k",
    confirmedBy: over.confirmedBy ?? "test",
    confirmedAt: over.confirmedAt ?? "2026-08-01T13:00:00.000Z",
    validForDays: over.validForDays ?? 30,
    expiresAt: over.expiresAt !== undefined ? over.expiresAt : "2026-08-31T13:00:00.000Z",
    sourceUrl: null,
    note: null,
    miss: over.miss ?? null,
    blockerFa: over.blockerFa ?? null,
    executable: over.executable ?? true,
    referenceModes: [],
    noticesFa: [],
    history: []
  };
}

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const PLANNED_END = Date.parse("2026-09-01T12:00:00.000Z"); // 7d from NOW

console.log("\n== Phase 1A — fee horizon ==");

await test("start-horizon failure when evidence expires before planned_end", () => {
  const v = venue({
    sourceId: "nobitex",
    expiresAt: "2026-08-31T13:00:00.000Z" // before planned end Sep 1
  });
  const r = validateFeeHorizonForRun({
    venues: [v],
    plannedEndMs: PLANNED_END,
    nowMs: NOW
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockers.length, 1);
  assert.equal(r.blockers[0].sourceId, "nobitex");
  assert.equal(r.blockers[0].executionMode, "ORDER_BOOK");
  assert.equal(r.blockers[0].tierLabel, "Base");
  assert.equal(r.blockers[0].expiresAt, "2026-08-31T13:00:00.000Z");
  assert.equal(r.blockers[0].reason, "expires_before_planned_end");
});

await test("warning window T-7d, T-24h and T-6h", () => {
  const exp = new Date(NOW + 5 * 60 * 60 * 1000).toISOString(); // 5h -> T_6H
  const v = venue({ sourceId: "wallex", expiresAt: exp, ok: true });
  const w = feeExpiryWarnings({ venues: [v], nowMs: NOW });
  assert.equal(w.length, 1);
  assert.equal(w[0].level, "T_6H");

  const exp24 = new Date(NOW + 20 * 60 * 60 * 1000).toISOString();
  const v2 = venue({ sourceId: "bitpin", expiresAt: exp24, ok: true });
  const w2 = feeExpiryWarnings({ venues: [v2], nowMs: NOW });
  assert.equal(w2[0].level, "T_24H");

  const exp7 = new Date(NOW + 3 * 24 * 60 * 60 * 1000).toISOString(); // 3d -> T_7D
  const v3 = venue({ sourceId: "nobitex", expiresAt: exp7, ok: true });
  const w3 = feeExpiryWarnings({ venues: [v3], nowMs: NOW });
  assert.equal(w3[0].level, "T_7D");
  assert.ok(FEE_WARNING_WINDOWS_MS.T_7D > FEE_WARNING_WINDOWS_MS.T_24H);
  assert.ok(FEE_WARNING_WINDOWS_MS.T_24H > FEE_WARNING_WINDOWS_MS.T_6H);
});

await test("exact expiry transition marks ECONOMICS_INVALID / DEGRADED_FROM_TIMESTAMP", () => {
  const expiresAt = "2026-08-31T13:00:00.000Z";
  const before = assessRuntimeFeeHorizon({
    venues: [venue({ sourceId: "nobitex", expiresAt, ok: true, takerFeeBps: 25 })],
    nowMs: Date.parse("2026-08-31T12:59:59.000Z")
  });
  assert.equal(before.economicsState, "ECONOMICS_VALID");

  const after = assessRuntimeFeeHorizon({
    venues: [
      venue({
        sourceId: "nobitex",
        expiresAt,
        ok: false,
        takerFeeBps: null,
        miss: "expired",
        blockerFa: "منقضی"
      })
    ],
    nowMs: Date.parse("2026-08-31T13:00:00.000Z")
  });
  assert.equal(after.economicsState, "ECONOMICS_INVALID");
  assert.equal(after.degradedFromTimestamp, expiresAt);
  const audit = toEconomicsValidityAudit(after, Date.parse("2026-08-31T13:00:01.000Z"));
  assert.equal(audit.reportState, "DEGRADED_FROM_TIMESTAMP");
  assert.equal(audit.degradedFromTimestamp, expiresAt);
});

await test("refreshed evidence restores horizon validity for a new start", () => {
  const refreshed = venue({
    sourceId: "nobitex",
    confirmedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    ok: true,
    takerFeeBps: 25
  });
  const r = validateFeeHorizonForRun({
    venues: [refreshed],
    plannedEndMs: Date.parse("2026-09-08T00:00:00.000Z"),
    nowMs: Date.parse("2026-09-01T00:00:00.000Z")
  });
  assert.equal(r.ok, true);
  assert.equal(r.blockers.length, 0);
});

await test("tier mismatch blocks start (exact venue/mode/tier)", () => {
  const v = venue({
    sourceId: "tabdeal",
    ok: false,
    takerFeeBps: null,
    miss: "tier_mismatch",
    currentTierLabel: "VIP",
    evidenceTierLabel: "Base",
    expiresAt: "2026-10-01T00:00:00.000Z",
    blockerFa: "پلکان ناسازگار"
  });
  const r = validateFeeHorizonForRun({
    venues: [v],
    plannedEndMs: PLANNED_END,
    nowMs: NOW
  });
  assert.equal(r.ok, false);
  assert.equal(r.blockers[0].reason, "tier_mismatch");
  assert.equal(r.blockers[0].tierLabel, "Base");
  assert.equal(r.blockers[0].sourceId, "tabdeal");
  assert.equal(r.blockers[0].executionMode, "ORDER_BOOK");
});

await test("non-expiring evidence (expiresAt=null) is accepted when ok", () => {
  const v = venue({
    sourceId: "arzinja",
    expiresAt: null,
    ok: true,
    takerFeeBps: 0,
    validForDays: null
  });
  const r = validateFeeHorizonForRun({
    venues: [v],
    plannedEndMs: PLANNED_END,
    nowMs: NOW
  });
  assert.equal(r.ok, true);
  const w = feeExpiryWarnings({ venues: [v], nowMs: NOW });
  assert.equal(w.length, 0);
});

await test("canonical release freshness reports EXPIRED after EXPIRES_AT (no date invent)", () => {
  const after = assessCanonicalFeeEvidenceFreshness({
    nowMs: Date.parse(EXPIRES_AT) + 1000
  });
  assert.equal(after.releaseKey, RELEASE_KEY);
  assert.equal(after.expired, true);
  assert.equal(after.refreshDue, true);
  assert.equal(after.level, "EXPIRED");
  assert.equal(feeWarningLevelForMsUntil(-1), "EXPIRED");
  assert.equal(feeWarningLevelForMsUntil(3 * 24 * 60 * 60 * 1000), "T_7D");
});

await test("canonical release freshness T_7D lead before expiry", () => {
  const before = assessCanonicalFeeEvidenceFreshness({
    nowMs: Date.parse(EXPIRES_AT) - 3 * 24 * 60 * 60 * 1000
  });
  assert.equal(before.expired, false);
  assert.equal(before.refreshDue, true);
  assert.equal(before.level, "T_7D");
});

console.log("\n== Phase 1B — reject diagnostics ==");

await test("sizing_blocked diagnostics carry blocker codes + constraints", () => {
  const d = buildRejectDiagnostics({
    rejectionCodes: ["sizing_blocked"],
    routeKey: "bitpin->wallex",
    buySourceId: "bitpin",
    sellSourceId: "wallex",
    candidateSizeUsdt: 25,
    buyVwapToman: 100_000,
    sellVwapToman: 100_100,
    netProfitToman: -50,
    buyFeeBps: 35,
    sellFeeBps: 20,
    sizing: {
      status: "BLOCKED",
      sizeUsdtMicros: null,
      sizeUsdt: null,
      bindingConstraint: "depth",
      selection: null,
      inventory: null,
      quote: null,
      economics: null,
      blockers: [
        {
          code: "not_net_positive",
          subject: "bitpin→wallex",
          detailFa: "سود مثبت نیست"
        }
      ],
      constraints: [],
      capacity: {
        limitingSide: "buy",
        limitingSourceId: "bitpin",
        limitingUsableMicros: 1_000_000,
        capitalCapMicros: 5_000_000,
        depthCapMicros: 2_000_000
      },
      audit: {
        status: "BLOCKED",
        rejectionReason: "سود مثبت نیست"
      }
    } as any
  });
  assert.equal(d.version, "paper_v2_reject_diagnostics_v1");
  assert.ok(d.sizingAudit);
  assert.deepEqual(d.sizingAudit!.blockerCodes, ["not_net_positive"]);
  assert.equal((d.sizingAudit!.capacity as any).limitingSourceId, "bitpin");
  assert.equal(d.prices?.buyVwapToman, 100_000);
  assert.equal(d.economics?.buyFeeBps, 35);
});

await test("market_data_time_incoherent includes sourceSkewMs + timestamps", () => {
  const d = buildRejectDiagnostics({
    rejectionCodes: ["market_data_time_incoherent"],
    routeKey: "tabdeal->ramzinex",
    buySourceId: "tabdeal",
    sellSourceId: "ramzinex",
    candidateSizeUsdt: 10,
    buyVwapToman: 200_000,
    sellVwapToman: 200_240,
    coherence: {
      coherent: false,
      reason: "cross_venue_time_skew",
      sourceSkewMs: 1000,
      venueClockSkewMs: 3200,
      eventToDecisionLatencyMs: 100,
      sourceEventLatencyMs: 50,
      receiveAgeMs: 80
    },
    buySnap: {
      sourceId: "tabdeal",
      receivedAt: "2026-08-29T12:00:00.000Z",
      sourceTimestamp: "2026-08-29T11:59:57.000Z",
      ageMs: 3000,
      marketData: {
        sourceEventTimestamp: "2026-08-29T11:59:57.000Z",
        receiveTimestamp: "2026-08-29T12:00:00.000Z",
        sourceEventAgeMs: 3000
      }
    } as any,
    sellSnap: {
      sourceId: "ramzinex",
      receivedAt: "2026-08-29T12:00:01.000Z",
      sourceTimestamp: "2026-08-29T11:59:53.800Z",
      ageMs: 6200,
      marketData: {
        sourceEventTimestamp: "2026-08-29T11:59:53.800Z",
        receiveTimestamp: "2026-08-29T12:00:01.000Z",
        sourceEventAgeMs: 6200
      }
    } as any
  });
  assert.equal(d.coherence?.sourceSkewMs, 1000);
  assert.equal(d.coherence?.venueClockSkewMs, 3200);
  assert.equal(d.coherence?.buy?.sourceEventTimestamp, "2026-08-29T11:59:57.000Z");
  assert.equal(d.coherence?.sell?.receivedAt, "2026-08-29T12:00:01.000Z");
  assert.ok(d.coherence?.buy?.ageMs != null);
  assert.ok(d.coherence?.sell?.ageMs != null);
});

await test("fee_unknown diagnostics include miss/evidence/expiresAt", () => {
  const d = buildRejectDiagnostics({
    rejectionCodes: ["fee_unknown"],
    routeKey: "nobitex->wallex",
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    candidateSizeUsdt: 20,
    buyFee: venue({
      sourceId: "nobitex",
      ok: false,
      takerFeeBps: null,
      miss: "expired",
      expiresAt: "2026-08-31T13:00:00.000Z",
      evidenceKey: "fee-nobitex-1",
      blockerFa: "منقضی"
    }),
    sellFee: venue({
      sourceId: "wallex",
      ok: true,
      takerFeeBps: 10,
      expiresAt: "2026-09-30T00:00:00.000Z",
      evidenceKey: "fee-wallex-1"
    })
  });
  assert.equal(d.feeUnknown?.buy?.miss, "expired");
  assert.equal(d.feeUnknown?.buy?.expiresAt, "2026-08-31T13:00:00.000Z");
  assert.equal(d.feeUnknown?.buy?.evidenceKey, "fee-nobitex-1");
  assert.equal(d.feeUnknown?.sell?.ok, true);
});

console.log("\n== Phase 1D — data health vs execution readiness ==");

await test("fee unknown blocks execution while market data stays healthy/visible", () => {
  assert.equal(classifyMarketDataHealth({ health: "healthy" }), "healthy");
  assert.equal(
    classifyExecutionReadiness({
      feeOk: false,
      feeMiss: "expired",
      takerFeeBps: null
    }),
    "blocked_fee_stale"
  );
  const split = buildVenueHealthSplit({
    sourceId: "nobitex",
    health: "healthy",
    feeOk: false,
    feeMiss: "expired",
    takerFeeBps: null,
    executionEligible: true,
    accountState: "VERIFIED"
  });
  assert.equal(split.marketDataHealth, "healthy");
  assert.equal(split.marketDataVisible, true);
  assert.equal(split.executionAllowed, false);
  assert.ok(split.executionBlockerFa);

  const summary = summarizeHealthSplit([
    split,
    buildVenueHealthSplit({
      sourceId: "wallex",
      health: "healthy",
      feeOk: true,
      takerFeeBps: 10,
      executionEligible: true,
      accountState: "VERIFIED"
    })
  ]);
  assert.equal(summary.marketDataHealthy, 2);
  assert.equal(summary.executionReady, 1);
  assert.equal(summary.executionBlockedFee, 1);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
