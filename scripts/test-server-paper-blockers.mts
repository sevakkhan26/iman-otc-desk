#!/usr/bin/env npx tsx
/**
 * Server Paper blockers regression (SHADOW-TELEMETRY-FORENSIC-CLOSURE):
 *  A) previewToken lifecycle — fresh OK; stale/mismatch; idempotent apply; persistence
 *  B) LEG_RISK resume → UnresolvedLegRiskError; audited reconcile; idempotency
 *  + observation start after COMPLETED opens a NEW session
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  bindingFromSessionSetupPreview,
  buildSessionSetupPreview,
  hashSessionSetupPreviewToken
} from "../src/lib/shadowArbitrage/paper/sessionCapital.ts";
import {
  PREVIEW_TOKEN_TTL_MS,
  loadSessionCapitalPreview,
  persistSessionCapitalPreview,
  requestMatchesPreviewBinding
} from "../src/lib/shadowArbitrage/paper/sessionCapitalPreviewStore.ts";

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

const VENUES = ["nobitex", "wallex", "tabdeal"];
const ELIGIBLE = ["nobitex", "wallex"];
const OBS = [
  {
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    occurrences: 2,
    riskAdjustedPnlToman: 50_000,
    capacityUsdtMicros: 500_000_000
  }
];
const MARK = 200_000;
const CLOCK = Date.parse("2026-09-09T12:00:00.000Z");
const PAPER_OPENING = [
  { sourceId: "nobitex", irtToman: 20_000_000, usdtUnits: 100 },
  { sourceId: "wallex", irtToman: 20_000_000, usdtUnits: 100 }
];

await test("operator UI mounts Paper pause/resume and bounded non-overlapping reads", async () => {
  const source = await readFile("src/components/ShadowArbitrageView.tsx", "utf8");
  assert.match(source, /\/api\/shadow-arbitrage\/paper\?view=operator/);
  assert.match(source, /loadInFlight\.current/);
  assert.match(source, /AbortSignal\.timeout\(15_000\)/);
  assert.match(source, /توقف امن Paper/);
  assert.match(source, /body: JSON\.stringify\(\{ action, sessionId: active\.id \}\)/);
  assert.doesNotMatch(source, /request\("\/api\/shadow-arbitrage\/history"\)/);
  assert.doesNotMatch(source, /request\("\/api\/shadow-arbitrage\/analytics"\)/);
});

await test("compact operator API returns before slow reporting queries", async () => {
  const source = await readFile("app/api/shadow-arbitrage/paper/route.ts", "utf8");
  const compact = source.indexOf("if (operatorView)");
  const reporting = source.indexOf("const [wizardSnapshots, wizardFees");
  assert.ok(compact >= 0 && reporting > compact);
  assert.match(source, /currentCycle: snap\.cycleSummaries\[0\]/);
  assert.match(source, /safeMaxUsdt: safeMaxMicros/);
  assert.match(source, /selectedSizeUsdt: latestDecision/);
  assert.match(source, /sizingWaterfall: audit/);
  assert.match(source, /terminalReason:/);
  assert.match(source, /const latestProposalRows = operatorView\s*\? \[\]/);
  assert.match(source, /operatorView \? operatorSnapshot\(\) : snapshot\(reason\)/);
  assert.match(source, /loadCycleSummaries\(session\.id, 1\)/);
  assert.match(source, /return runSerialized\(async \(\) =>/);
});

function paperFill(
  lifecycleId: string,
  netPnl = -2_506_250,
  balancesAfter: Array<{ sourceId: string; irtToman: number; usdtMicros: number }> = [
    { sourceId: "nobitex", irtToman: 17_493_750, usdtMicros: 125_000_000 },
    { sourceId: "wallex", irtToman: 20_000_000, usdtMicros: 100_000_000 }
  ]
) {
  return {
    lifecycleId,
    routeKey: "nobitex->wallex@25",
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: 25,
    buyVwapToman: 100_000,
    sellVwapToman: 0,
    buyNotionalToman: 2_500_000,
    sellNotionalToman: 0,
    buyFeeBps: 25,
    sellFeeBps: 25,
    buyFeeAsset: "IRT",
    buyFeeDebitMode: "ADD_TO_DEBIT",
    buyFeeProvenance: "ADMIN_CONFIRMED",
    sellFeeAsset: "USDT",
    sellFeeDebitMode: "ADD_TO_DEBIT",
    sellFeeProvenance: "ADMIN_CONFIRMED",
    feeTomanTotal: 6_250,
    feeUsdtMicrosTotal: 0,
    slippageBufferToman: 0,
    grossSpreadToman: 0,
    markPriceToman: 100_000,
    cashPnlIrtToman: netPnl,
    sellFeeValueToman: 0,
    economicNetPnlToman: -6_250,
    riskAdjustedPnlToman: -7_250,
    inventoryDeltaUsdtMicros: 25_000_000,
    balancesAfter
  };
}

await test("hash is deterministic regardless of allocation array order", () => {
  const base = {
    activeSessionId: null as string | null,
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    oldCapitalToman: null as number | null,
    mode: "capital_derived" as const,
    effectiveMaxOrderUsdt: 100,
    willWritePolicy: true,
    orderCapChoice: "AUTO_CAPITAL_DERIVED" as const,
    manualOrderCapUsdt: null as number | null,
    durationDays: 4,
    reserveToman: 10_000_000,
    allocationValid: true
  };
  const a = hashSessionSetupPreviewToken({
    ...base,
    allocations: [
      { sourceId: "wallex", irtToman: 40_000_000, usdtUnits: 100 },
      { sourceId: "nobitex", irtToman: 50_000_000, usdtUnits: 50 }
    ]
  });
  const b = hashSessionSetupPreviewToken({
    ...base,
    allocations: [
      { sourceId: "nobitex", irtToman: 50_000_000, usdtUnits: 50 },
      { sourceId: "wallex", irtToman: 40_000_000, usdtUnits: 100 }
    ]
  });
  assert.equal(a, b);
  assert.equal(a.length, 64);
});

await test("clock is not part of previewToken", () => {
  const common = {
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    eligibleVenueIds: ELIGIBLE,
    allocationObservations: OBS,
    activeSessionId: null as string | null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED" as const,
    durationDays: 4
  };
  const p1 = buildSessionSetupPreview({ ...common, clockMs: CLOCK });
  const p2 = buildSessionSetupPreview({ ...common, clockMs: CLOCK + 60_000 });
  assert.equal(p1.previewToken, p2.previewToken);
  assert.notEqual(p1.startedAt, p2.startedAt);
});

await test("allocation drift changes token (root cause of live rebuild mismatch)", () => {
  const p1 = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    eligibleVenueIds: ELIGIBLE,
    allocationObservations: OBS,
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4,
    clockMs: CLOCK
  });
  const p2 = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    eligibleVenueIds: ELIGIBLE,
    allocationObservations: [
      {
        buySourceId: "wallex",
        sellSourceId: "nobitex",
        occurrences: 9,
        riskAdjustedPnlToman: 900_000,
        capacityUsdtMicros: 900_000_000
      }
    ],
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4,
    clockMs: CLOCK
  });
  assert.notEqual(p1.previewToken, p2.previewToken);
});

const scratch = await mkdtemp(path.join(tmpdir(), "server-paper-blockers-"));
process.env.DATABASE_URL = `pglite:${scratch}`;
process.env.SHADOW_RELEASE_BOOTSTRAP = "false";

const { runMigrations } = await import("../src/db/migrate.ts");
const { closeDb } = await import("../src/db/client.ts");
await runMigrations();

const paperRepo = await import("../src/db/repositories/shadowPaper.ts");
const obsRepo = await import("../src/db/repositories/shadowArbitrage.ts");

await test("fresh preview binding persists; expired/mismatch → reject", async () => {
  const preview = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    eligibleVenueIds: ELIGIBLE,
    allocationObservations: OBS,
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4,
    clockMs: CLOCK
  });
  const binding = bindingFromSessionSetupPreview(preview, {
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    manualOrderCapUsdt: null,
    durationDays: 4
  });
  assert.equal(hashSessionSetupPreviewToken(binding), preview.previewToken);
  await persistSessionCapitalPreview({
    version: 1,
    previewToken: preview.previewToken,
    createdAt: new Date(CLOCK).toISOString(),
    expiresAt: new Date(CLOCK + PREVIEW_TOKEN_TTL_MS).toISOString(),
    binding,
    startedAt: preview.startedAt,
    endsAt: preview.endsAt,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    paperPolicyMinUsdt: preview.paperPolicyMinUsdt,
    smartSizeCeilingUsdt: preview.smartSizeCeilingUsdt,
    usableCapitalToman: preview.usableCapitalToman,
    reserveCapitalToman: preview.reserveCapitalToman,
    limits: preview.limits
  });
  const loaded = await loadSessionCapitalPreview(preview.previewToken, CLOCK + 1_000);
  assert.ok(loaded);
  assert.equal(
    requestMatchesPreviewBinding({
      binding: loaded!.binding,
      totalCapitalToman: 100_000_000,
      valuationPriceToman: MARK,
      durationDays: 4,
      orderCapChoice: "AUTO_CAPITAL_DERIVED",
      manualOrderCapUsdt: null,
      activeSessionId: null
    }),
    true
  );
  assert.equal(
    await loadSessionCapitalPreview(preview.previewToken, CLOCK + PREVIEW_TOKEN_TTL_MS + 1),
    null,
    "expired token must not load"
  );
  assert.equal(
    await loadSessionCapitalPreview("0".repeat(64), CLOCK + 1_000),
    null,
    "unknown token → null (invalid_preview_token)"
  );
  assert.equal(
    requestMatchesPreviewBinding({
      binding: loaded!.binding,
      totalCapitalToman: 200_000_000,
      valuationPriceToman: MARK,
      durationDays: 4,
      orderCapChoice: "AUTO_CAPITAL_DERIVED",
      manualOrderCapUsdt: null,
      activeSessionId: null
    }),
    false,
    "mismatched capital → invalid_preview_token"
  );
});

await test("apply uses frozen binding despite live allocation drift; idempotent", async () => {
  const preview = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    eligibleVenueIds: ELIGIBLE,
    allocationObservations: OBS,
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4,
    clockMs: CLOCK
  });
  const binding = bindingFromSessionSetupPreview(preview, {
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4
  });
  await persistSessionCapitalPreview({
    version: 1,
    previewToken: preview.previewToken,
    createdAt: new Date(CLOCK).toISOString(),
    expiresAt: new Date(CLOCK + PREVIEW_TOKEN_TTL_MS).toISOString(),
    binding,
    startedAt: preview.startedAt,
    endsAt: preview.endsAt,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    paperPolicyMinUsdt: preview.paperPolicyMinUsdt,
    smartSizeCeilingUsdt: preview.smartSizeCeilingUsdt,
    usableCapitalToman: preview.usableCapitalToman,
    reserveCapitalToman: preview.reserveCapitalToman,
    limits: preview.limits
  });
  const drifted = buildSessionSetupPreview({
    totalCapitalToman: 100_000_000,
    valuationPriceToman: MARK,
    venueIds: VENUES,
    eligibleVenueIds: ELIGIBLE,
    allocationObservations: [
      {
        buySourceId: "wallex",
        sellSourceId: "nobitex",
        occurrences: 20,
        riskAdjustedPnlToman: 1_000_000,
        capacityUsdtMicros: 1_000_000_000
      }
    ],
    activeSessionId: null,
    orderCapChoice: "AUTO_CAPITAL_DERIVED",
    durationDays: 4,
    clockMs: CLOCK
  });
  assert.notEqual(drifted.previewToken, preview.previewToken);

  const stored = await loadSessionCapitalPreview(preview.previewToken, CLOCK + 5_000);
  assert.ok(stored);
  const r1 = await paperRepo.replaceActivePaperSessionCapital({
    totalCapitalToman: stored!.binding.totalCapitalToman,
    valuationPriceToman: stored!.binding.valuationPriceToman,
    openingAllocations: stored!.binding.allocations,
    createdBy: "test-blockers",
    previewToken: preview.previewToken,
    name: "blocker-a session"
  });
  assert.equal(r1.reused, false);
  assert.equal(r1.newSession.status, "RUNNING");
  assert.deepEqual(
    r1.newSession.openingAllocations.map((a) => a.sourceId).sort(),
    stored!.binding.allocations.map((a) => a.sourceId).sort()
  );
  const r2 = await paperRepo.replaceActivePaperSessionCapital({
    totalCapitalToman: stored!.binding.totalCapitalToman,
    valuationPriceToman: stored!.binding.valuationPriceToman,
    openingAllocations: stored!.binding.allocations,
    createdBy: "test-blockers",
    previewToken: preview.previewToken
  });
  assert.equal(r2.reused, true);
  assert.equal(r2.newSession.id, r1.newSession.id);
});

await test("LEG_RISK resume throws UnresolvedLegRiskError with ledger/lifecycle/code", async () => {
  const session = await paperRepo.createPaperSession({
    observationId: null,
    name: "leg-risk blocker",
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: 60_000_000,
    valuationPriceToman: 100_000,
    openingAllocations: PAPER_OPENING,
    approvalFingerprint: null,
    createdBy: "test",
    note: null
  });
  await paperRepo.setPaperSessionStatus(session.id, "RUNNING");
  const balancesAfter = [
    { sourceId: "nobitex", irtToman: 17_493_750, usdtMicros: 125_000_000 },
    { sourceId: "wallex", irtToman: 20_000_000, usdtMicros: 100_000_000 }
  ];
  const fill = {
    ...paperFill("risk-blocker-1", -2_506_250, balancesAfter),
    executionOutcome: "LEG_RISK" as const,
    executionEvidence: {
      outcome: "LEG_RISK",
      legRisk: { firstLegFilledUsdt: 25, secondLegFilledUsdt: 0 }
    }
  };
  await paperRepo.commitPaperCycle({
    sessionId: session.id,
    runId: null,
    occurredAt: new Date().toISOString(),
    fills: [fill],
    skips: [],
    requireRunning: true
  });
  assert.equal((await paperRepo.getPaperSession(session.id))?.status, "PAUSED");
  const rows = await paperRepo.loadPaperLedger(session.id, { outcome: "LEG_RISK" });
  assert.equal(rows.length, 1);
  const unresolved = await paperRepo.listUnresolvedLegRiskRows(session.id);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0]!.ledgerId, rows[0]!.id);

  let caught: unknown = null;
  try {
    await paperRepo.setPaperSessionStatus(session.id, "RUNNING");
  } catch (e) {
    caught = e;
  }
  assert.ok(paperRepo.isUnresolvedLegRiskError(caught));
  const err = caught as InstanceType<typeof paperRepo.UnresolvedLegRiskError>;
  assert.equal(err.code, "unresolved_leg_risk");
  assert.equal(err.sessionId, session.id);
  assert.equal(err.ledgerId, rows[0]!.id);
  assert.equal(err.lifecycleId, "risk-blocker-1");
  assert.equal(err.rejectionCode, "leg_risk_second_leg_failed");

  // Persist balances untouched through failed resume attempt
  const bals = await paperRepo.loadPaperBalances(session.id);
  assert.deepEqual(
    bals.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    balancesAfter
  );

  // Audited reconcile — does not delete LEG_RISK or mutate balances
  const closure = await paperRepo.reconcilePaperLegRisk({
    sessionId: session.id,
    ledgerId: rows[0]!.id,
    closedBy: "admin-test",
    evidence: {
      reason: "paper_simulated_exposure_acknowledged",
      inventoryKept: true,
      source: "test-server-paper-blockers"
    },
    note: "Paper-only closure for blocker B"
  });
  assert.equal(closure.reused, false);
  assert.equal(closure.ledgerId, rows[0]!.id);
  assert.equal((await paperRepo.listUnresolvedLegRiskRows(session.id)).length, 0);
  // LEG_RISK row still present
  assert.equal((await paperRepo.loadPaperLedger(session.id, { outcome: "LEG_RISK" })).length, 1);
  assert.deepEqual(
    (await paperRepo.loadPaperBalances(session.id)).sort((a, b) =>
      a.sourceId.localeCompare(b.sourceId)
    ),
    balancesAfter
  );

  // Idempotent reconcile
  const again = await paperRepo.reconcilePaperLegRisk({
    sessionId: session.id,
    ledgerId: rows[0]!.id,
    closedBy: "admin-test",
    evidence: { reason: "retry" }
  });
  assert.equal(again.reused, true);
  assert.equal(again.id, closure.id);

  // Resume now allowed
  const resumed = await paperRepo.setPaperSessionStatus(session.id, "RUNNING");
  assert.equal(resumed?.status, "RUNNING");
});

await test("observation start after COMPLETED creates a NEW session", async () => {
  const first = await obsRepo.setObservationStatus("start", 30_000);
  assert.equal(first.status, "RUNNING");
  const completed = await obsRepo.setObservationStatus("complete");
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.id, first.id);
  // resume on COMPLETED is a no-op
  const resumed = await obsRepo.setObservationStatus("resume");
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.status, "COMPLETED");
  // start opens a new session
  const next = await obsRepo.setObservationStatus("start", 30_000);
  assert.notEqual(next.id, first.id);
  assert.equal(next.status, "RUNNING");
  const latest = await obsRepo.getObservation();
  assert.equal(latest?.id, next.id);
});

await closeDb();
await rm(scratch, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
