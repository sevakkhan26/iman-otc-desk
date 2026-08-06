#!/usr/bin/env npx tsx
/**
 * Isolated local Paper session with exactly 100,000,000 toman.
 * Does NOT touch production. Uses DATABASE_URL (default pglite local).
 *
 *   DATABASE_URL=pglite:.data/pglite-trade-details-rc \
 *   SHADOW_DECISION_TRACE=true \
 *   npx tsx scripts/seed-local-paper-100m.mts
 */
import { SHADOW_SOURCES } from "../src/lib/shadowArbitrage/config.ts";
import { defaultAllocation } from "../src/lib/shadowArbitrage/paper/portfolio.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { closeDb } from "../src/db/client.ts";
import {
  createPaperSession,
  getActivePaperSession,
  setPaperSessionStatus,
  loadPaperBalances
} from "../src/db/repositories/shadowPaper.ts";

const CAPITAL = 100_000_000;
/** Local mark for allocation only — not a live production price. */
const MARK = 200_000;

const venueIds = SHADOW_SOURCES.map((s) => s.id);

await runMigrations();

const existing = await getActivePaperSession();
if (existing && existing.status !== "STOPPED") {
  if (existing.totalCapitalToman === CAPITAL) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          reused: true,
          sessionId: existing.id,
          status: existing.status,
          totalCapitalToman: existing.totalCapitalToman
        },
        null,
        2
      )
    );
    await closeDb();
    process.exit(0);
  }
  await setPaperSessionStatus(existing.id, "STOPPED");
  console.log("stopped prior active session", existing.id, existing.totalCapitalToman);
}

const alloc = defaultAllocation(CAPITAL, venueIds, MARK);
const sumIrt = alloc.reduce((s, a) => s + a.irtToman, 0);
const sumUsdtToman = alloc.reduce((s, a) => s + Math.round(a.usdtUnits * MARK), 0);
const total = sumIrt + sumUsdtToman;
const residual = CAPITAL - total;

if (residual !== 0) {
  console.error("allocation residual not zero", { total, residual, CAPITAL });
  await closeDb();
  process.exit(1);
}

const session = await createPaperSession({
  observationId: null,
  name: "نشست محلی ۱۰۰ میلیون (RC)",
  mode: "APPROVED_PLAN",
  totalCapitalToman: CAPITAL,
  valuationPriceToman: MARK,
  openingAllocations: alloc,
  approvalFingerprint: "local-seed-100m",
  createdBy: "seed-local-paper-100m",
  note: "Isolated local only — not production"
});
await setPaperSessionStatus(session.id, "RUNNING");

const bals = await loadPaperBalances(session.id);
const balsTotal = bals.reduce(
  (s, b) => s + b.irtToman + Math.round((b.usdtMicros / 1e6) * MARK),
  0
);

console.log(
  JSON.stringify(
    {
      ok: true,
      reused: false,
      sessionId: session.id,
      status: "RUNNING",
      totalCapitalToman: CAPITAL,
      allocationRows: alloc.length,
      residual,
      balanceMarkedTotal: balsTotal,
      venues: venueIds.length
    },
    null,
    2
  )
);

await closeDb();
