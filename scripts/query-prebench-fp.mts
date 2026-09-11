#!/usr/bin/env npx tsx
import { writeFileSync } from "node:fs";
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";
const out = process.env.OUT ?? "";
const db = await getDbAsync();
const R: Record<string, unknown> = {};
async function q(label: string, query: ReturnType<typeof sql>) {
  try {
    const r = await db.execute(query);
    R[label] = { ok: true, rows: (r as { rows?: unknown[] }).rows ?? r };
  } catch (e) {
    R[label] = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
await q("session", sql`SELECT id::text, approval_fingerprint, valuation_price_toman, opening_allocations, total_capital_toman::text, observation_id::text FROM shadow_paper_sessions LIMIT 1`);
await q("policies", sql`SELECT key, value::text, configured, expires_at::text FROM shadow_risk_policies ORDER BY key`);
await q("experiments", sql`SELECT id::text, run_key, policy_fingerprint, status FROM shadow_paper_experiments ORDER BY created_at DESC LIMIT 5`);
await closeDb();
const text = JSON.stringify(R, null, 2) + "\n";
console.log(text);
if (out) writeFileSync(out, text);
