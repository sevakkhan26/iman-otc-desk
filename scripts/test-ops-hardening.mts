#!/usr/bin/env npx tsx
/**
 * Phase 7A.2 — operational hardening tests.
 *
 * Covers the failure modes the production checks exist for: database outage,
 * pending migrations, a stale collector lease, container restart continuity,
 * backup corruption and a restore mismatch. Runs against a throwaway PGlite
 * instance and the real shell scripts; it never touches a live database and
 * never contacts an exchange.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

const dir = await mkdtemp(path.join(tmpdir(), "otc-ops-"));
process.env.DATABASE_URL = `pglite:${path.join(dir, "pglite")}`;

const { closeDb } = await import("../src/db/client.ts");
const { runMigrations, migrationStatus } = await import("../src/db/migrate.ts");
const { checkLiveness, checkReadiness, evaluateOpsFindings, OPS_EXIT } = await import(
  "../src/lib/ops/health.ts"
);
const repo = await import("../src/db/repositories/shadowArbitrage.ts");
const paperRepo = await import("../src/db/repositories/shadowPaper.ts");

const REPO_ROOT = new URL("..", import.meta.url).pathname;

/* ── liveness and readiness ───────────────────────────────────────────────── */

await test("liveness answers without touching the database", () => {
  const live = checkLiveness();
  assert.equal(live.status, "alive");
  assert.ok(live.uptimeSeconds >= 0);
  // Nothing else may be present: the probe is unauthenticated.
  assert.deepEqual(Object.keys(live).sort(), ["status", "uptimeSeconds"]);
});

await test("readiness fails closed while migrations are pending", async () => {
  const before = await migrationStatus();
  assert.ok(before.pending.length > 0, "a fresh database has pending migrations");

  const readiness = await checkReadiness();
  assert.equal(readiness.status, "not_ready");
  const migrations = readiness.checks.find((c) => c.name === "migrations");
  assert.equal(migrations?.ok, false);
  assert.ok(migrations?.detail.includes("pending"));
});

await test("readiness reports no sensitive data", async () => {
  await runMigrations();
  const readiness = await checkReadiness();
  const serialized = JSON.stringify(readiness).toLowerCase();
  for (const leak of ["pglite:", "postgres://", "password", "secret", "token", process.env.DATABASE_URL!.toLowerCase()]) {
    assert.equal(serialized.includes(leak), false, `readiness must not expose ${leak}`);
  }
  // Check names and short details only.
  assert.deepEqual(
    readiness.checks.map((c) => c.name).sort(),
    ["collector", "database", "migrations"]
  );
});

await test("readiness passes migrations once they are applied", async () => {
  const status = await migrationStatus();
  assert.equal(status.pending.length, 0);
  assert.equal(status.applied.length, status.onDisk.length);
  const readiness = await checkReadiness();
  assert.equal(readiness.checks.find((c) => c.name === "migrations")?.ok, true);
});

await test("readiness fails closed on a stale or absent collector lease", async () => {
  // No heartbeat at all yet.
  let readiness = await checkReadiness();
  let collector = readiness.checks.find((c) => c.name === "collector");
  assert.equal(collector?.ok, false);
  assert.equal(readiness.status, "not_ready");

  // A held, fresh lease flips it.
  await repo.claimWorkerLease({ workerId: "ops-test-1", pollIntervalMs: 30_000 });
  readiness = await checkReadiness();
  collector = readiness.checks.find((c) => c.name === "collector");
  assert.equal(collector?.ok, true, "a held lease with a fresh heartbeat is ready");
  assert.equal(collector?.detail.includes("ops-test-1"), false, "the worker id is never exposed");

  // Releasing it makes readiness fail again — the lease is the signal.
  await repo.releaseWorkerLease("ops-test-1");
  readiness = await checkReadiness();
  assert.equal(readiness.checks.find((c) => c.name === "collector")?.ok, false);
  assert.equal(readiness.status, "not_ready");
});

/* ── ops-check exit codes ─────────────────────────────────────────────────── */

const healthyReadiness = {
  status: "ready" as const,
  checks: [
    { name: "database" as const, ok: true, detail: "reachable" },
    { name: "migrations" as const, ok: true, detail: "9/9 applied" },
    { name: "collector" as const, ok: true, detail: "lease held, heartbeat fresh" }
  ]
};

const baseInput = {
  maxFailedCycles: 0,
  maxDuplicateKeys: 0,
  maxBackupAgeHours: 24,
  newestBackupAgeHours: 1,
  paperReconciliationMismatches: 0
};

await test("ops-check returns a distinct exit code per failure class", () => {
  assert.equal(
    evaluateOpsFindings(healthyReadiness, baseInput, { failedRuns: 0, duplicateIdempotencyKeys: 0 })
      .exitCode,
    OPS_EXIT.OK
  );

  const dbDown = {
    ...healthyReadiness,
    status: "not_ready" as const,
    checks: healthyReadiness.checks.map((c) =>
      c.name === "database" ? { ...c, ok: false, detail: "unreachable" } : c
    )
  };
  assert.equal(
    evaluateOpsFindings(dbDown, baseInput, { failedRuns: 0, duplicateIdempotencyKeys: 0 }).exitCode,
    OPS_EXIT.DATABASE_FAILURE
  );

  const pending = {
    ...healthyReadiness,
    checks: healthyReadiness.checks.map((c) =>
      c.name === "migrations" ? { ...c, ok: false, detail: "1 pending" } : c
    )
  };
  assert.equal(
    evaluateOpsFindings(pending, baseInput, { failedRuns: 0, duplicateIdempotencyKeys: 0 }).exitCode,
    OPS_EXIT.MIGRATIONS_PENDING
  );

  const stale = {
    ...healthyReadiness,
    checks: healthyReadiness.checks.map((c) =>
      c.name === "collector" ? { ...c, ok: false, detail: "heartbeat stale" } : c
    )
  };
  assert.equal(
    evaluateOpsFindings(stale, baseInput, { failedRuns: 0, duplicateIdempotencyKeys: 0 }).exitCode,
    OPS_EXIT.STALE_COLLECTOR
  );

  assert.equal(
    evaluateOpsFindings(healthyReadiness, baseInput, {
      failedRuns: 3,
      duplicateIdempotencyKeys: 0
    }).exitCode,
    OPS_EXIT.FAILED_CYCLES
  );
  assert.equal(
    evaluateOpsFindings(healthyReadiness, baseInput, {
      failedRuns: 0,
      duplicateIdempotencyKeys: 2
    }).exitCode,
    OPS_EXIT.DUPLICATE_KEYS
  );
  assert.equal(
    evaluateOpsFindings(
      healthyReadiness,
      { ...baseInput, newestBackupAgeHours: null },
      { failedRuns: 0, duplicateIdempotencyKeys: 0 }
    ).exitCode,
    OPS_EXIT.BACKUP_FAILURE
  );
  assert.equal(
    evaluateOpsFindings(
      healthyReadiness,
      { ...baseInput, newestBackupAgeHours: 99 },
      { failedRuns: 0, duplicateIdempotencyKeys: 0 }
    ).exitCode,
    OPS_EXIT.BACKUP_FAILURE
  );
  assert.equal(
    evaluateOpsFindings(
      healthyReadiness,
      { ...baseInput, paperReconciliationMismatches: 1 },
      { failedRuns: 0, duplicateIdempotencyKeys: 0 }
    ).exitCode,
    OPS_EXIT.PAPER_RECONCILIATION_MISMATCH
  );
});

await test("ops-check treats an unmeasured ledger and an unset limit honestly", () => {
  // Unmeasured reconciliation is a failure, not a pass.
  const unmeasured = evaluateOpsFindings(
    healthyReadiness,
    { ...baseInput, paperReconciliationMismatches: null },
    { failedRuns: 0, duplicateIdempotencyKeys: 0 }
  );
  assert.equal(unmeasured.exitCode, OPS_EXIT.PAPER_RECONCILIATION_MISMATCH);
  assert.ok(
    unmeasured.findings.find((f) => f.name === "paper_reconciliation")?.detail.includes("not measured")
  );

  // An unset backup age limit reports "not checked" instead of passing silently.
  const noLimit = evaluateOpsFindings(
    healthyReadiness,
    { ...baseInput, maxBackupAgeHours: null, newestBackupAgeHours: null },
    { failedRuns: 0, duplicateIdempotencyKeys: 0 }
  );
  assert.equal(noLimit.exitCode, OPS_EXIT.OK);
  assert.ok(noLimit.findings.find((f) => f.name === "backup")?.detail.includes("not checked"));
});

/* ── restart continuity ───────────────────────────────────────────────────── */

await test("restart preserves observation, paper session, balances and ledgers", async () => {
  const observation = await repo.ensureObservationSession(30_000);
  const session = await paperRepo.createPaperSession({
    observationId: observation.id,
    name: "ops restart",
    mode: "PROVISIONAL_EVALUATION",
    totalCapitalToman: 50_000_000,
    valuationPriceToman: 100_000,
    openingAllocations: [
      { sourceId: "nobitex", irtToman: 20_000_000, usdtUnits: 100 },
      { sourceId: "wallex", irtToman: 20_000_000, usdtUnits: 100 }
    ],
    approvalFingerprint: null,
    createdBy: "admin",
    note: null
  });
  await paperRepo.setPaperSessionStatus(session.id, "RUNNING");
  await paperRepo.commitPaperCycle({
    sessionId: session.id,
    runId: null,
    occurredAt: new Date(Date.UTC(2026, 6, 30, 2, 0, 0)).toISOString(),
    fills: [],
    skips: [
      {
        lifecycleId: "ops-lc-1",
        routeKey: "nobitex->wallex@25",
        buySourceId: "nobitex",
        sellSourceId: "wallex",
        sizeUsdt: 25,
        rejectionCode: "fee_unknown",
        reasonCodes: ["fee_unknown"],
        rejectionReason: "کارمزد تأییدنشده",
        requiredRebalance: null
      }
    ]
  });
  await paperRepo.setPaperSessionStatus(session.id, "PAUSED");

  const before = {
    observationId: observation.id,
    balances: await paperRepo.loadPaperBalances(session.id),
    ledger: await paperRepo.loadPaperLedger(session.id),
    states: await paperRepo.loadCandidateStates(session.id),
    summaries: await paperRepo.loadCycleSummaries(session.id)
  };

  // Simulate a container restart: drop every connection and re-open.
  await closeDb();

  const observationAfter = await repo.getObservation();
  assert.equal(observationAfter?.id, before.observationId, "observation.id survives the restart");

  const sessionAfter = await paperRepo.getActivePaperSession();
  assert.equal(sessionAfter?.id, session.id, "the paper session survives");
  assert.equal(sessionAfter?.status, "PAUSED", "a paused session stays paused across a restart");

  assert.deepEqual(await paperRepo.loadPaperBalances(session.id), before.balances);
  assert.deepEqual(await paperRepo.loadPaperLedger(session.id), before.ledger);
  assert.deepEqual(await paperRepo.loadCandidateStates(session.id), before.states);
  assert.deepEqual(await paperRepo.loadCycleSummaries(session.id), before.summaries);

  // Re-running the identical cycle after the restart adds no duplicate detail row.
  const replay = await paperRepo.commitPaperCycle({
    sessionId: session.id,
    runId: null,
    occurredAt: new Date(Date.UTC(2026, 6, 30, 2, 0, 30)).toISOString(),
    fills: [],
    skips: [
      {
        lifecycleId: "ops-lc-1",
        routeKey: "nobitex->wallex@25",
        buySourceId: "nobitex",
        sellSourceId: "wallex",
        sizeUsdt: 25,
        rejectionCode: "fee_unknown",
        reasonCodes: ["fee_unknown"],
        rejectionReason: "کارمزد تأییدنشده",
        requiredRebalance: null
      }
    ]
  });
  assert.equal(replay.detailedEventsWritten, 0, "no duplicate execution after restart");
  assert.equal((await paperRepo.loadPaperLedger(session.id)).length, before.ledger.length);
});

/* ── backup and restore scripts ───────────────────────────────────────────── */

/**
 * Strip comments so the scans below test what the code DOES, not what the
 * documentation says it does not do. A comment saying "no webhook here" must
 * not fail a scan for webhooks.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/(^|\s)\/\/.*$/, "$1"))
    .join("\n");
}

function bashCheck(script: string) {
  execFileSync("bash", ["-n", path.join(REPO_ROOT, script)], { stdio: "pipe" });
}

await test("backup and restore scripts are syntactically valid", () => {
  for (const s of [
    "scripts/backup-production-db.sh",
    "scripts/restore-drill.sh",
    "scripts/pg-backup.sh",
    "scripts/pg-restore.sh"
  ]) {
    bashCheck(s);
  }
});

await test("the backup script publishes atomically and never overwrites", async () => {
  const src = await readFile(path.join(REPO_ROOT, "scripts/backup-production-db.sh"), "utf8");
  // Atomic: written to .partial, renamed only after verification.
  assert.ok(src.includes(".dump.partial"));
  const partialIndex = src.indexOf('mv "${PARTIAL}"');
  const verifyIndex = src.indexOf("pg_restore --list");
  assert.ok(verifyIndex > 0 && partialIndex > verifyIndex, "publication must follow verification");
  // Interrupted runs clean up.
  assert.ok(src.includes("trap cleanup_partial EXIT"));
  // Never overwrite.
  assert.ok(src.includes("refusing to overwrite"));
  // Integrity artefacts.
  assert.ok(src.includes(".dump.sha256"));
  assert.ok(src.includes('"verified": true'));
  // No secret output.
  assert.ok(src.includes("set +x"), "tracing must be disabled");
  assert.ok(src.includes("umask 077"));
  assert.equal(/PGPASSWORD/.test(src), false, "no password variable is ever handled");
  assert.equal(/echo .*\$\{?DB_PASS/.test(src), false);
});

await test("the restore drill can only ever touch a validated throwaway database", async () => {
  const src = await readFile(path.join(REPO_ROOT, "scripts/restore-drill.sh"), "utf8");
  assert.ok(src.includes('DRILL_PREFIX="otc_restore_drill_"'));
  assert.ok(src.includes("refusing to touch the live database"));
  assert.ok(src.includes("refusing to touch a system database"));
  assert.ok(src.includes("name failed strict validation"));
  // Re-validated before every statement, not once.
  assert.ok((src.match(/validate_target/g) ?? []).length >= 5);
  // The only DROP targets the drill database.
  const drops = src.match(/DROP DATABASE[^\n]*/g) ?? [];
  assert.equal(drops.length, 1);
  assert.ok(drops[0].includes("${DRILL_DB}"));
  // It verifies exactly what the requirement asks for.
  for (const probe of [
    "schema_meta",
    "shadow_observation_sessions",
    "shadow_paper_sessions",
    "shadow_paper_balances",
    "shadow_paper_ledger",
    "economic_net_pnl_toman"
  ]) {
    assert.ok(src.includes(probe), `the drill must verify ${probe}`);
  }
});

await test("a corrupt backup is detected before anything is restored", async () => {
  // The drill checksums the artefact and refuses on mismatch, before creating
  // any database. This exercises that logic with the same shell semantics.
  const dump = path.join(dir, "fake.dump");
  await writeFile(dump, "PGDMP-not-really");
  await writeFile(`${dump}.sha256`, "0000000000000000000000000000000000000000000000000000000000000000  fake.dump\n");

  const script = `
set -euo pipefail
DUMP="${dump}"
if command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$DUMP" | cut -d' ' -f1)"
else
  ACTUAL="$(shasum -a 256 "$DUMP" | cut -d' ' -f1)"
fi
EXPECTED="$(cut -d' ' -f1 < "$DUMP.sha256")"
if [ "$ACTUAL" != "$EXPECTED" ]; then echo "CORRUPT"; exit 3; fi
echo "OK"
`;
  let code = 0;
  let out = "";
  try {
    out = execFileSync("bash", ["-c", script], { encoding: "utf8" });
  } catch (e) {
    const err = e as { status?: number; stdout?: string };
    code = err.status ?? 0;
    out = err.stdout ?? "";
  }
  assert.equal(code, 3, "a checksum mismatch must abort");
  assert.ok(out.includes("CORRUPT"));

  // And the drill wires exactly this check in before touching a database.
  const drill = await readFile(path.join(REPO_ROOT, "scripts/restore-drill.sh"), "utf8");
  const checksumIndex = drill.indexOf("checksum mismatch");
  const createIndex = drill.indexOf("CREATE DATABASE");
  assert.ok(checksumIndex > 0 && createIndex > checksumIndex, "verify before creating anything");
});

await test("a restore mismatch fails the drill instead of passing quietly", async () => {
  const src = await readFile(path.join(REPO_ROOT, "scripts/restore-drill.sh"), "utf8");
  // Every check increments a failure counter and the script exits non-zero.
  assert.ok(src.includes("FAILURES=$((FAILURES + 1))"));
  assert.ok(src.includes('if [ "${FAILURES}" -eq 0 ]'));
  assert.ok(src.includes("restore drill FAILED"));
  assert.ok(src.includes("exit 1"));
  // A missing table is a failure, not a skipped check.
  assert.ok(src.includes('check "rows ${TABLE}" "table missing" fail'));
});

await test("the scheduler template is inactive and carries no credential", async () => {
  const tpl = await readFile(path.join(REPO_ROOT, "scripts/backup-scheduler.template"), "utf8");
  assert.ok(tpl.includes("DISABLED BY DEFAULT"));
  assert.ok(tpl.includes("REPLACE_WITH_SCHEDULE"), "no cadence is chosen for the operator");
  // Every unit line is commented out; nothing is executable as-is.
  const active = tpl
    .split("\n")
    .filter((l) => l.trim() && !l.trimStart().startsWith("#"));
  assert.equal(active.length, 0, `template must be fully commented: ${active.join(" | ")}`);
  // No credential VALUE may appear — a sentence saying "no webhook" is fine,
  // an actual URL or assignment is not.
  const credentialShapes: Array<[string, RegExp]> = [
    ["a URL", /https?:\/\/[^\s"']+/],
    ["a token assignment", /(token|secret|password|api_?key)\s*[=:]\s*\S/i],
    ["an SMTP host", /smtp\.[a-z0-9.-]+/i],
    ["a bot id", /\b\d{6,}:[A-Za-z0-9_-]{20,}/]
  ];
  for (const [label, pattern] of credentialShapes) {
    assert.equal(pattern.test(tpl), false, `template must not contain ${label}`);
  }
  // It is not referenced by any deployment step.
  const deploy = await readFile(path.join(REPO_ROOT, "scripts/deploy-production.sh"), "utf8");
  assert.equal(deploy.includes("backup-scheduler"), false, "deployment must not install a schedule");
});

await test("the storage report has no delete or drop path at all", async () => {
  const raw = await readFile(path.join(REPO_ROOT, "scripts/shadow-storage-report.mts"), "utf8");
  const src = stripComments(raw).toUpperCase();
  for (const term of ["DELETE FROM", "DROP TABLE", "TRUNCATE", "ALTER TABLE", "DROP DATABASE"]) {
    assert.equal(src.includes(term), false, `report must not execute ${term}`);
  }
  // Every statement it does run is a SELECT.
  const statements = raw.match(/sql\.raw\(\s*[`"'][^`"']+/g) ?? [];
  assert.ok(statements.length > 0);
  for (const st of statements) {
    assert.ok(/SELECT/i.test(st), `every statement must be a SELECT: ${st}`);
  }
  assert.ok(raw.includes("RETENTION DRY RUN"));
  assert.ok(raw.includes("SHADOW_RETENTION_REPORT_DAYS"), "the window is the operator's choice");
  // No default retention window is assumed.
  assert.ok(raw.includes("No default window is assumed"));
});

await test("ops tooling contains no notification credential or exchange call", async () => {
  for (const f of [
    "scripts/ops-check.mts",
    "scripts/shadow-storage-report.mts",
    "src/lib/ops/health.ts"
  ]) {
    const src = stripComments(await readFile(path.join(REPO_ROOT, f), "utf8"));
    // Call- and value-shaped patterns, not words that may appear in prose.
    const forbidden: Array<[string, RegExp]> = [
      ["an outbound URL", /https?:\/\/[^\s"'`]+/],
      ["a fetch call", /\bfetch\s*\(/],
      ["a credential value", /(token|secret|password|api_?key)\s*[:=]\s*["'`]\S/i],
      ["a notification send", /\b(sendMessage|sendMail|notify)\s*\(/],
      ["an exchange call", /\b(placeOrder|withdraw|transferFunds)\s*\(/]
    ];
    for (const [label, pattern] of forbidden) {
      assert.equal(pattern.test(src), false, `${f} must not contain ${label}`);
    }
  }
});

await closeDb().catch(() => undefined);
await rm(dir, { recursive: true, force: true });

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
