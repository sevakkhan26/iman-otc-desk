#!/usr/bin/env npx tsx
/**
 * Isolated STOPPED session + one FILLED ledger row for fee-UI browser proof.
 * Does not replace the live 100M RUNNING session.
 */
import { randomUUID } from "node:crypto";
import { runMigrations } from "../src/db/migrate.ts";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import {
  createPaperSession,
  getActivePaperSession,
  setPaperSessionStatus
} from "../src/db/repositories/shadowPaper.ts";
import { defaultAllocation } from "../src/lib/shadowArbitrage/paper/portfolio.ts";
import { SHADOW_SOURCES } from "../src/lib/shadowArbitrage/config.ts";
import { shadowPaperLedger } from "../src/db/schema.ts";
import { runSerialized } from "../src/db/repositories/shadowArbitrage.ts";

await runMigrations();

const active = await getActivePaperSession();
const CAP = 50_000_000;
const MARK = 186_000;
const alloc = defaultAllocation(
  CAP,
  SHADOW_SOURCES.map((s) => s.id),
  MARK
);
const s = await createPaperSession({
  observationId: null,
  name: "fixture-fee-ui (isolated)",
  mode: "APPROVED_PLAN",
  totalCapitalToman: CAP,
  valuationPriceToman: MARK,
  openingAllocations: alloc,
  approvalFingerprint: "fixture-fee",
  createdBy: "fixture",
  note: "Isolated fixture for fee UI — not the live 100M session"
});
await setPaperSessionStatus(s.id, "STOPPED");

const id = randomUUID();
const now = new Date().toISOString();
const db = await getDbAsync();
await runSerialized(async () => {
  await db.insert(shadowPaperLedger).values({
    id,
    sessionId: s.id,
    runId: null,
    idempotencyKey: `${s.id}|fixture-life-1`,
    lifecycleId: "fixture-life-1",
    routeKey: "nobitex->wallex",
    outcome: "FILLED",
    eventType: "FILLED",
    reasonCodes: [],
    buySourceId: "nobitex",
    sellSourceId: "wallex",
    sizeUsdt: "100",
    buyVwapToman: 186_000,
    sellVwapToman: 186_500,
    buyNotionalToman: 18_600_000,
    sellNotionalToman: 18_650_000,
    buyFeeBps: 10,
    sellFeeBps: 10,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    buyFeeDebitMode: "ADD_TO_COST",
    sellFeeDebitMode: "DEDUCT_FROM_QTY",
    buyFeeProvenance: "ADMIN_CONFIRMED",
    sellFeeProvenance: "ADMIN_CONFIRMED",
    feeTomanTotal: 18_600,
    feeUsdtMicrosTotal: 100_000,
    sellFeeValueToman: 18_600,
    grossSpreadToman: 50_000,
    markPriceToman: 186_000,
    cashPnlIrtToman: 31_400,
    inventoryDeltaUsdtMicros: 0,
    economicNetPnlToman: 12_800,
    riskAdjustedPnlToman: 12_000,
    slippageBufferToman: 0,
    balancesAfter: [],
    occurredAt: now,
    createdAt: now
  });
});

console.log(
  JSON.stringify(
    {
      fixtureSessionId: s.id,
      ledgerId: id,
      activeLiveSessionId: active?.id ?? null,
      activeLiveCapital: active?.totalCapitalToman ?? null,
      note: "Fixture is STOPPED; live 100M session remains active"
    },
    null,
    2
  )
);
await closeDb();
