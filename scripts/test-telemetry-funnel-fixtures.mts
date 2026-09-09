#!/usr/bin/env npx tsx
/**
 * Deterministic FIXTURE_NOT_REAL_TRADE proofs:
 *  1) FILLED — full funnel round-trip into decision_traces + lifecycle_evidence
 *  2) NET-POSITIVE-BUT-NOT-FILLED — exact terminal reason (never sizing_blocked)
 *
 * Invented books only. LIVE=false. Throwaway PGlite.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";

const mkdtempAsync = promisify(mkdtemp);
const dataDir = await mkdtempAsync(path.join(tmpdir(), "otc-telemetry-funnel-"));
process.env.DATABASE_URL = `pglite:${path.join(dataDir, "pglite")}`;
process.env.SHADOW_COLLECTOR_ENABLED = "false";
process.env.SHADOW_RELEASE_BOOTSTRAP = "false";
process.env.SHADOW_DECISION_TRACE = "true";
process.env.SHADOW_PAPER_ENSURE = "0";
process.env.LIVE = "false";

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations } = await import("../src/db/migrate.ts");
await runMigrations();

const { SHADOW_SOURCES } = await import("../src/lib/shadowArbitrage/config.ts");
const { snapshotFromResult } = await import("../src/lib/shadowArbitrage/adapters/base.ts");
const { certifyFromSnapshot } = await import("../src/lib/shadowArbitrage/certification.ts");
const { buildOpportunitiesDetailed } = await import("../src/lib/shadowArbitrage/calculate.ts");
const {
  recordFeeConfirmation,
  recordAccountConfirmation
} = await import("../src/db/repositories/shadowArbitrage.ts");
const { recordFeeTierEvidence } = await import("../src/db/repositories/shadowFeeTier.ts");
const { loadEffectiveFees } = await import("../src/lib/shadowArbitrage/effectiveFees.ts");
const { recordRiskPolicy } = await import("../src/db/repositories/shadowLive.ts");
const {
  createPaperSession,
  setPaperSessionStatus,
  loadPaperLedger
} = await import("../src/db/repositories/shadowPaper.ts");
const { runPaperExecutionForCycle } = await import(
  "../src/lib/shadowArbitrage/paper/run.ts"
);
const { listDecisionTraces } = await import(
  "../src/db/repositories/shadowDecisionTraces.ts"
);
const {
  listLifecycleEvidence,
  getLifecycleEvidenceByLifecycleId
} = await import("../src/db/repositories/shadowLifecycleEvidence.ts");
const { isBannedTerminalReason } = await import(
  "../src/lib/shadowArbitrage/paper/reasons.ts"
);
const { paperReasonFromSizing } = await import(
  "../src/lib/shadowArbitrage/paper/engine.ts"
);

const now = new Date();
const nowIso = now.toISOString();
const MARK = 100_000;

// Unit: never emit sizing_blocked
{
  const blocked = paperReasonFromSizing({
    status: "BLOCKED",
    policy: "MAX_RA_PNL",
    blockers: [{ code: "depth_exhausted", subject: "wallex", detailFa: "x" }],
    candidates: [],
    sizeUsdtMicros: null,
    bindingConstraint: null,
    capacity: null,
    selection: null,
    economics: null,
    audit: null,
    constraints: []
  } as never);
  assert.notEqual(blocked, "sizing_blocked");
  assert.equal(blocked, "insufficient_depth");
  const empty = paperReasonFromSizing({
    status: "BLOCKED",
    policy: "MAX_RA_PNL",
    blockers: [],
    candidates: [],
    sizeUsdtMicros: null,
    bindingConstraint: null,
    capacity: null,
    selection: null,
    economics: null,
    audit: null,
    constraints: []
  } as never);
  assert.notEqual(empty, "sizing_blocked");
  assert.equal(empty, "sizing_invalid_size");
  assert.equal(isBannedTerminalReason("sizing_blocked"), true);
}

const OTHER = { bid: 100_100, ask: 101_700 };
const BOOKS_FILL: Record<string, { bid: number; ask: number } | null> = {
  nobitex: { bid: 99_000, ask: 99_900 },
  wallex: { bid: 101_600, ask: 101_700 },
  tabdeal: OTHER,
  bitpin: OTHER,
  abantether: OTHER,
  ramzinex: OTHER,
  tetherland: OTHER,
  bit24: OTHER,
  arzinja: OTHER
};

function levels(price: number, side: "bid" | "ask", amount = 60) {
  const step = side === "bid" ? -60 : 60;
  return Array.from({ length: 60 }, (_, i) => ({
    priceToman: price + step * i,
    amountUsdt: amount
  }));
}

function buildSnapshots(
  books: Record<string, { bid: number; ask: number } | null>,
  depthAmount = 60
) {
  return SHADOW_SOURCES.filter((c) => c.enabled).map((cfg) => {
    const book = books[cfg.id] ?? null;
    const isQuote = cfg.marketModel === "OTC_QUOTE";
    return snapshotFromResult(
      cfg,
      {
        kind: isQuote ? "OTC_QUOTE" : "BOOK",
        bids: book && !isQuote ? levels(book.bid, "bid", depthAmount) : [],
        asks: book && !isQuote ? levels(book.ask, "ask", depthAmount) : [],
        bestBidToman: book?.bid ?? null,
        bestAskToman: book?.ask ?? null,
        maxUsdt: isQuote ? 500 : null,
        sourceTimestamp: nowIso,
        priceUnit: "IRT",
        depthAvailable: Boolean(book) && !isQuote,
        directionVerified: true,
        endpoint: "fixture://invented",
        httpStatus: 200,
        latencyMs: 90,
        attempts: 1,
        rateLimited: false,
        normalizationNote: "FIXTURE_NOT_REAL_TRADE"
      },
      nowIso
    );
  });
}

const VENUE_FEES: Record<
  string,
  { mode: "ORDER_BOOK" | "OTC_QUOTE"; tier: string | null; maker: number; taker: number }
> = {
  nobitex: { mode: "ORDER_BOOK", tier: "Base", maker: 25, taker: 25 },
  wallex: { mode: "ORDER_BOOK", tier: "Base Level 1", maker: 25, taker: 30 },
  tabdeal: { mode: "ORDER_BOOK", tier: "VIP1", maker: 24, taker: 28 },
  bitpin: { mode: "ORDER_BOOK", tier: "Base Level 1", maker: 30, taker: 35 },
  abantether: { mode: "OTC_QUOTE", tier: null, maker: 30, taker: 30 },
  ramzinex: { mode: "ORDER_BOOK", tier: "Base", maker: 20, taker: 25 },
  tetherland: { mode: "ORDER_BOOK", tier: "Bronze", maker: 45, taker: 45 },
  bit24: { mode: "ORDER_BOOK", tier: "VIP0", maker: 20, taker: 20 },
  arzinja: { mode: "ORDER_BOOK", tier: "Level 1", maker: 0, taker: 0 }
};

for (const cfg of SHADOW_SOURCES) {
  const fee = VENUE_FEES[cfg.id];
  if (!fee) continue;
  await recordAccountConfirmation({
    sourceId: cfg.id,
    kycComplete: true,
    accountState: "VERIFIED",
    executionEligible: true,
    ineligibleReason: null,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    validDays: 30,
    evidenceKey: "fixture-account-telemetry",
    confirmedBy: "fixture-admin",
    confirmedAt: nowIso,
    note: "FIXTURE_NOT_REAL_TRADE"
  });
  await recordFeeConfirmation({
    sourceId: cfg.id,
    takerFeeBps: fee.taker,
    makerFeeBps: fee.maker,
    feeTier: fee.tier,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    validDays: 30,
    evidenceKey: "fixture-fee-telemetry",
    confirmedBy: "fixture-admin",
    confirmedAt: nowIso,
    note: "FIXTURE_NOT_REAL_TRADE"
  });
  await recordFeeTierEvidence({
    sourceId: cfg.id,
    executionMode: fee.mode,
    tierLabel: fee.tier,
    makerFeeBps: fee.maker,
    takerFeeBps: fee.taker,
    provenance: "ADMIN_CONFIRMED_SCREENSHOT",
    evidenceKey: "fixture-tier-telemetry",
    confirmedBy: "fixture-admin",
    confirmedAt: nowIso,
    validForDays: 30,
    expiresAt: new Date(Date.now() + 30 * 864e5).toISOString(),
    sourceUrl: null,
    note: "FIXTURE_NOT_REAL_TRADE"
  });
}

for (const [policyKey, value] of [
  ["max_order_size_usdt", 2_000],
  ["max_venue_exposure_percent", 40],
  ["min_risk_adjusted_edge_percent", 0.05],
  ["max_quote_age_ms", 60_000],
  ["max_slippage_bps", 600],
  ["max_inventory_deviation_percent", 40]
] as const) {
  await recordRiskPolicy({
    policyKey,
    value,
    setBy: "fixture-admin",
    validForDays: 30,
    note: "FIXTURE_NOT_REAL_TRADE"
  });
}

const { confirmedFeeBps } = await loadEffectiveFees(Date.now());

async function runCycle(opts: {
  name: string;
  books: Record<string, { bid: number; ask: number } | null>;
  depthAmount: number;
  capitalToman: number;
  usdtUnits: number;
  irtToman: number;
}) {
  const snapshots = buildSnapshots(opts.books, opts.depthAmount);
  const certBySource: Record<string, ReturnType<typeof certifyFromSnapshot>> = {};
  for (const s of snapshots) certBySource[s.sourceId] = certifyFromSnapshot(s);
  const certStatuses = Object.fromEntries(
    Object.entries(certBySource).map(([id, c]) => [id, c.status])
  ) as never;
  const accountEvidence = Object.fromEntries(
    SHADOW_SOURCES.map((c) => [c.id, { executionEligible: true, kycComplete: true }])
  );
  const built = buildOpportunitiesDetailed(snapshots, [], nowIso, {
    certStatuses,
    accountEvidence,
    confirmedFeeBps
  });
  const paper = await createPaperSession({
    observationId: null,
    name: opts.name,
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: opts.capitalToman,
    valuationPriceToman: MARK,
    openingAllocations: SHADOW_SOURCES.map((c) => ({
      sourceId: c.id,
      irtToman: opts.irtToman,
      usdtUnits: opts.usdtUnits
    })),
    approvalFingerprint: null,
    createdBy: "fixture-admin",
    note: "FIXTURE_NOT_REAL_TRADE"
  });
  await setPaperSessionStatus(paper.id, "RUNNING");
  const outcome = await runPaperExecutionForCycle({
    runId: randomUUID(),
    occurredAt: new Date().toISOString(),
    cycleStatus: "success",
    sources: snapshots,
    opportunities: built.opportunities,
    // Arrival observations: same invented books (deterministic fixture).
    observeSources: async () =>
      snapshots.map((s) => ({
        ...s,
        receivedAt: new Date().toISOString(),
        ageMs: 0
      }))
  });
  return { paper, outcome, built, snapshots };
}

// --- FILLED ---
const fill = await runCycle({
  name: "FIXTURE_NOT_REAL_TRADE filled",
  books: BOOKS_FILL,
  depthAmount: 60,
  capitalToman: SHADOW_SOURCES.length * (300_000_000 + 1_500 * MARK),
  usdtUnits: 1_500,
  irtToman: 300_000_000
});
assert.equal(fill.outcome.ran, true, JSON.stringify(fill.outcome));
assert.ok((fill.outcome.filled ?? 0) >= 1, `expected fill: ${JSON.stringify(fill.outcome)}`);

const fillLedger = await loadPaperLedger(fill.paper.id, { outcome: "FILLED", limit: 20 });
assert.ok(fillLedger.length >= 1);
const filledLife = fillLedger[0]!.lifecycleId;

const traces = await listDecisionTraces({ sessionId: fill.paper.id, limit: 10 });
assert.ok(traces.rows.length >= 1, "decision trace missing");
assert.ok(traces.rows[0]!.traceComplete);
const traded = traces.rows[0]!.candidates.find((c) => c.status === "traded");
assert.ok(traded, "traded candidate missing");
assert.ok(Array.isArray(traded!.funnelStages) && traded!.funnelStages!.length >= 10);
assert.ok(traded!.lifecycleEvidence);

const evFill = await listLifecycleEvidence({ sessionId: fill.paper.id, limit: 200 });
assert.ok(evFill.some((e) => e.outcome === "FILLED"));
const fillEv = evFill.find((e) => e.lifecycleId === filledLife && e.outcome === "FILLED");
assert.ok(fillEv);
assert.equal(fillEv!.terminalReason, null);

const roundTrip = await getLifecycleEvidenceByLifecycleId(filledLife, 5);
assert.ok(roundTrip.length >= 1);
assert.equal(roundTrip[0]!.lifecycleId, filledLife);

await setPaperSessionStatus(fill.paper.id, "STOPPED");

// --- NET-POS UNFILLED: same economics, near-zero balances → exact capital/size reject ---
const unfill = await runCycle({
  name: "FIXTURE_NOT_REAL_TRADE netpos-unfilled",
  books: BOOKS_FILL,
  depthAmount: 60,
  capitalToman: SHADOW_SOURCES.length * (1000 + 0.01 * MARK),
  usdtUnits: 0.01,
  irtToman: 1000
});
assert.equal(unfill.outcome.ran, true);
const skipLedger = await loadPaperLedger(unfill.paper.id, { outcome: "SKIPPED", limit: 500 });
assert.ok(skipLedger.length >= 1, "expected skips on starved capital");
for (const s of skipLedger) {
  assert.ok(s.rejectionCode, `missing rejectionCode on ${s.lifecycleId}`);
  assert.notEqual(s.rejectionCode, "sizing_blocked");
  assert.equal(isBannedTerminalReason(s.rejectionCode), false);
}
const evSkip = await listLifecycleEvidence({ sessionId: unfill.paper.id, limit: 500 });
const skippedEv = evSkip.filter((e) => e.outcome === "SKIPPED");
assert.ok(skippedEv.length >= 1);
for (const e of skippedEv) {
  assert.ok(e.terminalReason);
  assert.notEqual(e.terminalReason, "sizing_blocked");
  assert.ok(Array.isArray(e.stages) && e.stages.length >= 10);
}

const ART = process.env.TELEMETRY_ART_DIR;
if (ART) {
  mkdirSync(path.join(ART, "fixtures"), { recursive: true });
  writeFileSync(
    path.join(ART, "fixtures", "FIXTURE_FILLED.json"),
    JSON.stringify(
      {
        label: "FIXTURE_NOT_REAL_TRADE",
        kind: "FILLED",
        lifecycleId: filledLife,
        evidence: fillEv!.evidence,
        stages: fillEv!.stages,
        decisionTraceCandidate: traded
      },
      null,
      2
    )
  );
  const sampleSkip = skippedEv[0]!;
  writeFileSync(
    path.join(ART, "fixtures", "FIXTURE_NETPOS_UNFILLED.json"),
    JSON.stringify(
      {
        label: "FIXTURE_NOT_REAL_TRADE",
        kind: "NET_POSITIVE_BUT_NOT_FILLED",
        lifecycleId: sampleSkip.lifecycleId,
        terminalReason: sampleSkip.terminalReason,
        evidence: sampleSkip.evidence,
        stages: sampleSkip.stages
      },
      null,
      2
    )
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      label: "FIXTURE_NOT_REAL_TRADE",
      filledLifecycleId: filledLife,
      unfilledSkips: skipLedger.length,
      sampleUnfilledTerminal: skippedEv[0]!.terminalReason,
      evidenceFilled: evFill.filter((e) => e.outcome === "FILLED").length,
      evidenceSkipped: skippedEv.length
    },
    null,
    2
  )
);

await closeDb();
