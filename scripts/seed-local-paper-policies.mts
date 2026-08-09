#!/usr/bin/env npx tsx
/**
 * Local-only: apply PAPER_POLICY_SET for sizing validation.
 * Does not create/stop paper sessions. Preserves admin-set keys.
 */
import { runMigrations } from "../src/db/migrate.ts";
import { closeDb } from "../src/db/client.ts";
import { applyRiskPolicySet, loadRiskPolicyValues } from "../src/db/repositories/shadowLive.ts";
import {
  PAPER_POLICY_SET,
  PAPER_POLICY_SET_KEY,
  PAPER_POLICY_SET_VALID_DAYS
} from "../src/lib/shadowArbitrage/live/paperPolicySet.ts";
import { paperPolicySetFingerprint } from "../src/lib/shadowArbitrage/live/paperPolicySetHash.ts";
import { buildPolicyState } from "../src/lib/shadowArbitrage/live/policy.ts";

await runMigrations();

const fingerprint = paperPolicySetFingerprint();
const state = buildPolicyState(await loadRiskPolicyValues(), Date.now());
const preserveKeys = PAPER_POLICY_SET.filter((entry) => {
  const current = state.find((p) => p.definition.key === entry.key);
  return Boolean(current?.configured) && current?.setBy !== "local-fee-parity-seed";
}).map((e) => e.key as string);

const result = await applyRiskPolicySet({
  setKey: PAPER_POLICY_SET_KEY,
  fingerprint,
  entries: PAPER_POLICY_SET.map((e) => ({ policyKey: e.key, value: e.value })),
  setBy: "local-fee-parity-seed",
  validForDays: PAPER_POLICY_SET_VALID_DAYS,
  note: "local Step3 — paper policies for sizing validation only",
  preserveKeys
});

const after = buildPolicyState(await loadRiskPolicyValues(), Date.now());
console.log(
  JSON.stringify(
    {
      ok: true,
      fingerprint,
      applied: result.applied,
      preserved: result.preserved,
      configured: after.filter((p) => p.configured).map((p) => ({
        key: p.definition.key,
        value: p.value
      }))
    },
    null,
    2
  )
);
await closeDb();
