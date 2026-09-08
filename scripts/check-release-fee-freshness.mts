/**
 * Local release/preflight guard for canonical fee-evidence freshness.
 *
 * Exit codes:
 *   0 — ok (expires beyond T_7D lead)
 *   1 — refresh due (T_7D / T_24H / T_6H) but not yet expired
 *   2 — expired or does not cover optional planned end
 *
 * Does not invent, extend, or write fee evidence. Fail-closed companion to
 * validateFeeHorizonForRun (which remains the hard start gate).
 */
import {
  assessCanonicalFeeEvidenceFreshness,
  EXPIRES_AT,
  RELEASE_KEY,
  VALID_DAYS
} from "../src/lib/shadowArbitrage/releaseBootstrap.ts";

const nowMs = Date.now();
const plannedRaw = (process.env.PLANNED_END_ISO ?? "").trim();
const plannedEndMs = plannedRaw ? Date.parse(plannedRaw) : null;
if (plannedRaw && !Number.isFinite(plannedEndMs)) {
  console.error(`invalid PLANNED_END_ISO: ${plannedRaw}`);
  process.exit(2);
}

const freshness = assessCanonicalFeeEvidenceFreshness({
  nowMs,
  plannedEndMs: plannedEndMs && Number.isFinite(plannedEndMs) ? plannedEndMs : null
});

console.log(JSON.stringify({
  ...freshness,
  ttlPolicy: {
    validDays: VALID_DAYS,
    derivation: "expiresAt = confirmedAt + VALID_DAYS * 86400000 (recordFeeTierEvidence)"
  }
}, null, 2));

if (freshness.expired || freshness.coversPlannedEnd === false) {
  console.error(`[fee-freshness] BLOCKED releaseKey=${RELEASE_KEY} expiresAt=${EXPIRES_AT} level=${freshness.level}`);
  process.exit(2);
}
if (freshness.refreshDue) {
  console.error(`[fee-freshness] REFRESH_DUE releaseKey=${RELEASE_KEY} expiresAt=${EXPIRES_AT} level=${freshness.level}`);
  process.exit(1);
}
console.error(`[fee-freshness] OK releaseKey=${RELEASE_KEY} expiresAt=${EXPIRES_AT}`);
process.exit(0);
