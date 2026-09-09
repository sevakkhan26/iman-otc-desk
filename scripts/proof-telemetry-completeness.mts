#!/usr/bin/env npx tsx
/** Post-run completeness check for bounded Local Paper proof. */
import { closeDb, getDbAsync } from "../src/db/client.ts";
import { sql } from "drizzle-orm";

const db = await getDbAsync();
const sessions = await db.execute(
  sql`SELECT id::text, status, trades_executed, cycles_evaluated FROM shadow_paper_sessions`
);
const ledger = await db.execute(
  sql`SELECT outcome, coalesce(rejection_code,'__NULL__') AS code, count(*)::int AS n
      FROM shadow_paper_ledger GROUP BY 1,2 ORDER BY 1,2`
);
const traces = await db.execute(
  sql`SELECT count(*)::int AS n, count(*) FILTER (WHERE trace_complete)::int AS complete
      FROM shadow_paper_decision_traces`
);
const ev = await db.execute(
  sql`SELECT outcome, coalesce(terminal_reason,'__NULL__') AS t, count(*)::int AS n
      FROM shadow_paper_lifecycle_evidence GROUP BY 1,2 ORDER BY n DESC`
);
const banned = await db.execute(
  sql`SELECT count(*)::int AS n FROM shadow_paper_ledger
      WHERE outcome='SKIPPED' AND (rejection_code IS NULL OR rejection_code='sizing_blocked')`
);
const bannedEv = await db.execute(
  sql`SELECT count(*)::int AS n FROM shadow_paper_lifecycle_evidence
      WHERE outcome='SKIPPED' AND (terminal_reason IS NULL OR terminal_reason='sizing_blocked')`
);
const fees = await db.execute(
  sql`SELECT count(*)::int AS n FROM shadow_fee_tier_evidence`
);

const rows = (r: unknown) => ((r as { rows?: unknown[] }).rows ?? r) as Array<Record<string, unknown>>;
const out = {
  sessions: rows(sessions),
  ledger: rows(ledger),
  traces: rows(traces),
  evidence: rows(ev),
  feeTierEvidence: rows(fees),
  bannedLedgerTerminals: rows(banned),
  bannedEvidenceTerminals: rows(bannedEv)
};
console.log(JSON.stringify(out, null, 2));

const bannedN = Number(rows(banned)[0]?.n ?? 0);
const bannedEN = Number(rows(bannedEv)[0]?.n ?? 0);
const sessN = rows(sessions).length;
const traceN = Number(rows(traces)[0]?.n ?? 0);
const feeN = Number(rows(fees)[0]?.n ?? 0);

if (sessN < 1) throw new Error("PROOF_FAIL: no paper session");
if (feeN < 1) throw new Error("PROOF_FAIL: fee evidence not seeded");
if (traceN < 1) throw new Error("PROOF_FAIL: no decision traces");
if (bannedN > 0 || bannedEN > 0) throw new Error("PROOF_FAIL: banned/null terminals present");
console.log("PROOF_COMPLETENESS_OK");
await closeDb();
