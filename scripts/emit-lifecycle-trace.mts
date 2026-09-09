#!/usr/bin/env npx tsx
/**
 * Emit lifecycle funnel trace JSON by stable lifecycle ID.
 * Read-only against DATABASE_URL. Does not invent fields.
 *
 *   DATABASE_URL=pglite:... npx tsx scripts/emit-lifecycle-trace.mts <lifecycleId> [out.json]
 */
import { writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.ts";
import { getLifecycleEvidenceByLifecycleId } from "../src/db/repositories/shadowLifecycleEvidence.ts";
import { getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const lifecycleId = process.argv[2];
const outPath = process.argv[3];
if (!lifecycleId) {
  console.error("usage: emit-lifecycle-trace.mts <lifecycleId> [out.json]");
  process.exit(2);
}

const evidence = await getLifecycleEvidenceByLifecycleId(lifecycleId, 100);
const db = await getDbAsync();
const ledger = await db.execute(
  sql`SELECT id, session_id, outcome, rejection_code, reason_codes, economic_net_pnl_toman,
             size_usdt, route_key, occurred_at::text, sizing_audit
      FROM shadow_paper_ledger WHERE lifecycle_id = ${lifecycleId}
      ORDER BY occurred_at`
);
const candidate = await db.execute(
  sql`SELECT * FROM shadow_paper_candidate_state WHERE lifecycle_id = ${lifecycleId}`
);
const lifecycle = await db.execute(
  sql`SELECT id, route_key, eligibility, raw_spread_percent, net_edge_percent,
             max_net_edge_percent, fee_unknown, blocked_reasons, observation_count
      FROM shadow_opportunity_lifecycles WHERE id = ${lifecycleId}`
);

const payload = {
  lifecycleId,
  emittedAt: new Date().toISOString(),
  lifecycleEvidence: evidence,
  ledger: (ledger as { rows?: unknown[] }).rows ?? ledger,
  candidateState: (candidate as { rows?: unknown[] }).rows ?? candidate,
  opportunityLifecycle: (lifecycle as { rows?: unknown[] }).rows ?? lifecycle
};

const text = JSON.stringify(payload, null, 2);
if (outPath) writeFileSync(outPath, text);
else console.log(text);
await closeDb();
