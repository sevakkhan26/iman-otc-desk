#!/usr/bin/env npx tsx
/**
 * Local-only: restore canonical nine-venue fee/account evidence from
 * releaseBootstrap.APPROVED_VENUES into the database named by DATABASE_URL.
 *
 *   DATABASE_URL=pglite:.data/pglite-local-rc-step2 \
 *     npx tsx scripts/seed-local-fee-evidence.mts
 *
 * Does not touch Production. Does not create/stop paper sessions.
 * Idempotent; skips venues with newer admin evidence.
 */
import { runMigrations } from "../src/db/migrate.ts";
import { closeDb } from "../src/db/client.ts";
import { seedLocalFeeEvidence } from "../src/lib/shadowArbitrage/localFeeEvidenceSeed.ts";
import { loadEffectiveFees } from "../src/lib/shadowArbitrage/effectiveFees.ts";
import { APPROVED_VENUES } from "../src/lib/shadowArbitrage/releaseBootstrap.ts";

await runMigrations();

const result = await seedLocalFeeEvidence();
const fees = await loadEffectiveFees(Date.now());
const okVenues = fees.venues.filter((v) => v.ok && v.takerFeeBps !== null);
const blocked = fees.venues.filter((v) => !v.ok);

console.log(
  JSON.stringify(
    {
      ok: true,
      seed: result,
      expectedVenues: APPROVED_VENUES.length,
      effectiveOk: okVenues.length,
      blocked: blocked.map((b) => ({
        sourceId: b.sourceId,
        miss: b.miss,
        blockerFa: b.blockerFa
      })),
      feesApplied9of9: okVenues.length === APPROVED_VENUES.length && blocked.length === 0
    },
    null,
    2
  )
);

await closeDb();
if (okVenues.length !== APPROVED_VENUES.length) process.exit(2);
