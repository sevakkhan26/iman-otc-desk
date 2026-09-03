#!/usr/bin/env npx tsx
/**
 * PAPER-V2 Economic liveness monitoring — regression coverage (no push / no Live).
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
  assessEconomicLiveness,
  buildCycleFunnel,
  buildEndReportValidityWindows,
  mergeValidityState,
  emptyPersistedState,
  ECONOMIC_LIVENESS_DEFAULTS,
  detectImmediateFeeBlocks,
  attributeDominantDropoutCauses
} = await import("../src/lib/shadowArbitrage/paper/economicLiveness.ts");

const { buildThreeWayHealthSplit } = await import(
  "../src/lib/shadowArbitrage/paper/dataHealth.ts"
);

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
    expiresAt: over.expiresAt !== undefined ? over.expiresAt : "2026-09-30T13:00:00.000Z",
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

const NOW = Date.parse("2026-09-03T12:00:00.000Z");

console.log("\n== Economic liveness — health split + detectors ==");

await test("worker/cycles healthy + fee expired => infra/data healthy but ECONOMICS_INVALID + alert", () => {
  const expiresAt = "2026-09-01T00:00:00.000Z";
  const a = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    candidateEvaluationContinuing: true,
    lastFillAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    filledThisCycle: 0,
    funnel: buildCycleFunnel({
      opportunities: [
        {
          buyVwapToman: 100_000,
          sellVwapToman: 101_000,
          netProfitToman: 0,
          feeUnknown: true
        }
      ],
      decisions: [{ kind: "SKIP", code: "fee_unknown" }],
      filledCount: 0
    }),
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
    requiredSourceIds: ["nobitex"]
  });

  assert.equal(a.health.infraHealth, "healthy");
  assert.equal(a.health.marketDataHealth, "healthy");
  assert.equal(a.health.infraImpliesEconomics, false);
  assert.equal(a.health.economicLiveness, "ECONOMICS_INVALID");
  assert.equal(a.validityState, "ECONOMICS_INVALID");
  assert.ok(a.alerts.some((x) => x.code === "ECONOMICS_INVALID" || x.code === "FEE_BLOCK_IMMEDIATE"));
  assert.equal(a.supervisorPayload.infraHealth, "healthy");
  assert.equal(a.supervisorPayload.economicLivenessStatus, "ECONOMICS_INVALID");
  assert.equal(a.supervisorPayload.terminal_output_authoritative, false);

  const split = buildThreeWayHealthSplit({
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    economicLiveness: "ECONOMICS_INVALID"
  });
  assert.equal(split.infraImpliesEconomics, false);
});

await test("candidates flowing + no fill >6h => CRITICAL", () => {
  const lastFill = new Date(NOW - 7 * 60 * 60 * 1000).toISOString();
  const a = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    candidateEvaluationContinuing: true,
    lastFillAt: lastFill,
    funnel: buildCycleFunnel({
      opportunities: [
        {
          buyVwapToman: 100_000,
          sellVwapToman: 100_500,
          netProfitToman: 100,
          feeUnknown: false
        }
      ],
      decisions: [{ kind: "SKIP", code: "sizing_blocked" }],
      filledCount: 0
    }),
    venues: [venue({ sourceId: "nobitex", ok: true, expiresAt: "2026-10-01T00:00:00.000Z" })],
    requiredSourceIds: ["nobitex"]
  });
  assert.equal(a.noFill.classification, "CRITICAL");
  assert.ok(a.alerts.some((x) => x.code === "NO_FILL_CRITICAL"));
  assert.ok(
    a.hoursSinceFill != null && a.hoursSinceFill >= ECONOMIC_LIVENESS_DEFAULTS.noFillCriticalHours
  );
  assert.ok(
    a.validityState === "ECONOMICS_DEGRADED" || a.health.economicLiveness === "CRITICAL" ||
      a.health.economicLiveness === "ECONOMICS_DEGRADED"
  );
});

await test("no candidates + no fills => not execution stall (NO_EXECUTABLE_OPPORTUNITIES)", () => {
  const a = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    candidateEvaluationContinuing: true,
    lastFillAt: new Date(NOW - 10 * 60 * 60 * 1000).toISOString(),
    funnel: buildCycleFunnel({
      opportunities: [],
      decisions: [],
      filledCount: 0
    }),
    venues: [venue({ sourceId: "nobitex", ok: true })],
    requiredSourceIds: ["nobitex"]
  });
  assert.equal(a.noFill.classification, "NO_EXECUTABLE_OPPORTUNITIES");
  assert.ok(!a.alerts.some((x) => x.code === "NO_FILL_CRITICAL"));
  assert.equal(a.health.economicLiveness, "NO_EXECUTABLE_OPPORTUNITIES");
});

await test("raw-positive >0 + positive-net=0 sustained => economic degradation", () => {
  const since = new Date(NOW - 4 * 60 * 60 * 1000).toISOString();
  const funnel = buildCycleFunnel({
    opportunities: [
      {
        buyVwapToman: 100_000,
        sellVwapToman: 101_000, // raw positive
        netProfitToman: -500, // not positive-net
        feeUnknown: false
      },
      {
        buyVwapToman: 100_000,
        sellVwapToman: 100_800,
        netProfitToman: -100,
        feeUnknown: false
      }
    ],
    decisions: [
      { kind: "SKIP", code: "net_non_positive" },
      { kind: "SKIP", code: "fee_unknown" }
    ],
    filledCount: 0
  });
  assert.ok(funnel.rawPositive >= 1);
  assert.equal(funnel.positiveNet, 0);

  const a = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "degraded",
    candidateEvaluationContinuing: true,
    lastFillAt: new Date(NOW - 30 * 60 * 1000).toISOString(),
    funnel,
    venues: [venue({ sourceId: "wallex", ok: true })],
    requiredSourceIds: ["wallex"],
    prior: {
      ...emptyPersistedState(),
      rawPositiveWithoutNetSince: since,
      lastFillAt: new Date(NOW - 30 * 60 * 1000).toISOString()
    }
  });
  assert.equal(a.positiveNetDropout.active, true);
  assert.equal(a.positiveNetDropout.severity, "CRITICAL");
  assert.ok(a.alerts.some((x) => x.code === "POSITIVE_NET_DROPOUT_CRITICAL"));
  assert.ok(a.positiveNetDropout.dominantCauses.length >= 1);
  assert.ok(
    a.validityState === "ECONOMICS_DEGRADED" ||
      a.health.economicLiveness === "ECONOMICS_DEGRADED" ||
      a.health.economicLiveness === "CRITICAL"
  );
});

await test("fee_unknown threshold crossed => alert with exact blocker", () => {
  let prior = emptyPersistedState();
  const expiredVenue = venue({
    sourceId: "bitpin",
    ok: false,
    takerFeeBps: null,
    miss: "tier_mismatch",
    tierLabel: "VIP1",
    evidenceTierLabel: "Base",
    executionMode: "ORDER_BOOK",
    expiresAt: "2026-09-20T00:00:00.000Z",
    blockerFa: "tier mismatch"
  });
  // Force 5 consecutive cycles at >=50% fee_unknown
  let last = prior;
  let final = null as ReturnType<typeof assessEconomicLiveness> | null;
  for (let i = 0; i < ECONOMIC_LIVENESS_DEFAULTS.feeUnknownConsecutiveCycles; i++) {
    final = assessEconomicLiveness({
      nowMs: NOW + i * 60_000,
      infraHealth: "healthy",
      marketDataHealth: "healthy",
      candidateEvaluationContinuing: true,
      lastFillAt: new Date(NOW - 60 * 60 * 1000).toISOString(),
      funnel: buildCycleFunnel({
        opportunities: [
          {
            buyVwapToman: 1,
            sellVwapToman: 2,
            netProfitToman: 0,
            feeUnknown: true
          }
        ],
        decisions: [
          { kind: "SKIP", code: "fee_unknown" },
          { kind: "SKIP", code: "fee_unknown" },
          { kind: "SKIP", code: "sizing_blocked" }
        ],
        filledCount: 0
      }),
      venues: [expiredVenue],
      requiredSourceIds: ["bitpin"],
      prior: last
    });
    last = final.nextPersisted;
  }
  assert.ok(final);
  assert.equal(final!.feeBlocks.rollingFeeUnknownAlert, true);
  assert.ok(final!.alerts.some((x) => x.code === "FEE_UNKNOWN_ROLLING"));
  const rolling = final!.alerts.find((x) => x.code === "FEE_UNKNOWN_ROLLING");
  assert.ok(rolling?.detail);
  // Immediate fee block also present with exact venue/mode/tier/miss
  const imm = detectImmediateFeeBlocks({
    venues: [expiredVenue],
    nowMs: NOW,
    requiredSourceIds: ["bitpin"]
  });
  assert.equal(imm.critical, true);
  assert.equal(imm.blockers[0].sourceId, "bitpin");
  assert.equal(imm.blockers[0].executionMode, "ORDER_BOOK");
  assert.equal(imm.blockers[0].miss, "tier_mismatch");
  assert.ok(imm.blockers[0].tierLabel);
  assert.ok(final!.feeBlocks.blockers.some((b) => b.sourceId === "bitpin" && b.miss === "tier_mismatch"));
});

await test("refreshed fee before expiry => warning clears / run valid", () => {
  const soon = new Date(NOW + 5 * 60 * 60 * 1000).toISOString(); // T_6H
  const warned = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    candidateEvaluationContinuing: true,
    lastFillAt: new Date(NOW - 10 * 60 * 1000).toISOString(),
    funnel: buildCycleFunnel({
      opportunities: [
        { buyVwapToman: 1, sellVwapToman: 2, netProfitToman: 10, feeUnknown: false }
      ],
      decisions: [{ kind: "EXECUTE" }],
      filledCount: 1
    }),
    venues: [venue({ sourceId: "nobitex", ok: true, expiresAt: soon, takerFeeBps: 25 })],
    requiredSourceIds: ["nobitex"]
  });
  assert.equal(warned.validityState, "WARNING");
  assert.ok(warned.feeBlocks.expiryWarnings.some((w) => w.level === "T_6H"));

  const refreshedExp = new Date(NOW + 40 * 24 * 60 * 60 * 1000).toISOString();
  const cleared = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    candidateEvaluationContinuing: true,
    lastFillAt: new Date(NOW - 5 * 60 * 1000).toISOString(),
    filledThisCycle: 1,
    funnel: buildCycleFunnel({
      opportunities: [
        { buyVwapToman: 1, sellVwapToman: 2, netProfitToman: 10, feeUnknown: false }
      ],
      decisions: [{ kind: "EXECUTE" }],
      filledCount: 1
    }),
    venues: [
      venue({
        sourceId: "nobitex",
        ok: true,
        expiresAt: refreshedExp,
        takerFeeBps: 25,
        confirmedAt: nowIsoSafe(NOW)
      })
    ],
    requiredSourceIds: ["nobitex"],
    prior: {
      ...warned.nextPersisted,
      // still only WARNING — never crossed degraded
      validityState: "WARNING",
      firstDegradedAt: null
    }
  });
  assert.equal(cleared.validityState, "VALID");
  assert.equal(cleared.feeBlocks.expiryWarnings.length, 0);
  assert.equal(cleared.firstDegradedAt, null);
  assert.equal(cleared.health.economicLiveness, "HEALTHY");
});

function nowIsoSafe(ms: number) {
  return new Date(ms).toISOString();
}

await test("invalidation timestamp immutable / auditable", () => {
  const firstIso = "2026-09-01T13:00:00.000Z";
  const prior = {
    ...emptyPersistedState(),
    validityState: "ECONOMICS_INVALID" as const,
    firstDegradedAt: firstIso,
    validityReasons: ["RUNTIME_FEE_EXPIRED"]
  };
  // Later cycle with refreshed fees must NOT clear firstDegradedAt / INVALID
  const a = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    candidateEvaluationContinuing: true,
    lastFillAt: nowIsoSafe(NOW),
    funnel: buildCycleFunnel({
      opportunities: [
        { buyVwapToman: 1, sellVwapToman: 2, netProfitToman: 5, feeUnknown: false }
      ],
      decisions: [{ kind: "EXECUTE" }],
      filledCount: 1
    }),
    venues: [
      venue({
        sourceId: "nobitex",
        ok: true,
        expiresAt: "2026-12-01T00:00:00.000Z",
        takerFeeBps: 25
      })
    ],
    requiredSourceIds: ["nobitex"],
    prior,
    priorFeeDegradedFromTimestamp: firstIso
  });
  assert.equal(a.firstDegradedAt, firstIso);
  assert.equal(a.validityState, "ECONOMICS_INVALID");
  assert.equal(a.nextPersisted.firstDegradedAt, firstIso);

  const merged = mergeValidityState({
    prior,
    proposed: "VALID",
    reasons: [],
    nowIso: nowIsoSafe(NOW),
    allowRecoverWarnings: true
  });
  assert.equal(merged.firstDegradedAt, firstIso);
  assert.equal(merged.validityState, "ECONOMICS_INVALID");
});

await test("end report separates valid vs invalid window", () => {
  const start = "2026-08-25T00:00:00.000Z";
  const degraded = "2026-08-31T13:00:00.000Z";
  const end = "2026-09-03T00:00:00.000Z";
  const report = buildEndReportValidityWindows({
    runStartedAt: start,
    runEndedAt: end,
    firstDegradedAt: degraded,
    validityStateAtEnd: "ECONOMICS_INVALID"
  });
  assert.equal(report.validWindow.from, start);
  assert.equal(report.validWindow.to, degraded);
  assert.equal(report.invalidWindow.from, degraded);
  assert.equal(report.invalidWindow.to, end);
  assert.equal(report.firstDegradedAt, degraded);
  assert.ok(report.note.toLowerCase().includes("valid"));

  const allValid = buildEndReportValidityWindows({
    runStartedAt: start,
    runEndedAt: end,
    firstDegradedAt: null,
    validityStateAtEnd: "VALID"
  });
  assert.equal(allValid.invalidWindow.from, null);
  assert.equal(allValid.validWindow.from, start);
  assert.equal(allValid.validWindow.to, end);
});

await test("supervisor payload contains required machine-readable fields", () => {
  const a = assessEconomicLiveness({
    nowMs: NOW,
    infraHealth: "healthy",
    marketDataHealth: "healthy",
    candidateEvaluationContinuing: true,
    lastFillAt: new Date(NOW - 4 * 60 * 60 * 1000).toISOString(),
    funnel: buildCycleFunnel({
      opportunities: [
        { buyVwapToman: 1, sellVwapToman: 2, netProfitToman: 1, feeUnknown: false }
      ],
      decisions: [{ kind: "SKIP", code: "portfolio_not_selected" }],
      filledCount: 0
    }),
    venues: [venue({ sourceId: "ramzinex", ok: true })],
    requiredSourceIds: ["ramzinex"]
  });
  const p = a.supervisorPayload;
  assert.equal(p.version, "supervisor_economic_liveness_v1");
  assert.ok("infraHealth" in p);
  assert.ok("marketDataHealth" in p);
  assert.ok("economicLivenessStatus" in p);
  assert.ok("last_fill_at" in p);
  assert.ok("hours_since_fill" in p);
  assert.ok("rolling_funnel_counts" in p);
  assert.ok("reject_distribution" in p);
  assert.ok("fee_blockers" in p);
  assert.ok("first_degraded_at" in p);
  assert.equal(p.terminal_output_authoritative, false);
});

await test("dominant dropout attribution categorizes fee/slippage/buffer", () => {
  const causes = attributeDominantDropoutCauses({
    fee_unknown: 10,
    net_non_positive: 5,
    slippage_exceeded: 2
  });
  assert.equal(causes[0].category, "fee");
  assert.ok(causes.some((c) => c.category === "buffer"));
  assert.ok(causes.some((c) => c.category === "slippage"));
});

console.log(`\n== Summary: ${passed} passed, ${failed} failed ==\n`);
if (failed > 0) process.exit(1);
