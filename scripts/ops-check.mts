#!/usr/bin/env npx tsx
/**
 * Production operational check with structured exit codes.
 *
 *   pnpm ops:check
 *
 * Exit codes (see OPS_EXIT in src/lib/ops/health.ts):
 *   0   healthy
 *   10  database failure
 *   11  stale collector
 *   12  failed cycles above the configured limit
 *   13  duplicate idempotency keys above the configured limit
 *   14  backup failure (missing, unverified or older than the configured age)
 *   15  paper reconciliation mismatch
 *   16  migrations pending
 *
 * It is read-only and sends nothing anywhere: there is no webhook, no e-mail,
 * no bot token and no notification credential in this file. A scheduler reacts
 * to the exit code — the desk decides how it wants to be told.
 *
 * Limits are read from the environment and are NOT defaulted to values that
 * would silently pass. An unset limit is reported as "not checked" rather than
 * quietly treated as zero.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { loadLocalEnv } from "./load-env.mts";

const repoRoot = new URL("..", import.meta.url).pathname;
loadLocalEnv(repoRoot);

const { closeDb } = await import("../src/db/client.ts");
const { checkReadiness, evaluateOpsFindings, opsRunStats, OPS_EXIT } = await import(
  "../src/lib/ops/health.ts"
);
const { getActivePaperSession, loadPaperLedger } = await import(
  "../src/db/repositories/shadowPaper.ts"
);

function envNumber(name: string, fallback: number | null): number | null {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Newest verified backup age, in hours.
 *
 * "Verified" means the artefact carries the checksum sidecar the hardened
 * backup script writes only after `pg_restore --list` succeeded. A bare .dump
 * with no sidecar is not counted as a verified backup.
 */
async function newestVerifiedBackupAgeHours(dir: string): Promise<number | null> {
  try {
    const entries = await readdir(dir);
    const dumps = entries.filter((f) => f.endsWith(".dump"));
    let newest: number | null = null;
    for (const dump of dumps) {
      if (!entries.includes(`${dump}.sha256`)) continue;
      const sidecar = await readFile(path.join(dir, `${dump}.sha256`), "utf8").catch(() => "");
      if (!sidecar.trim()) continue;
      const info = await stat(path.join(dir, dump));
      const ageHours = (Date.now() - info.mtimeMs) / 3_600_000;
      if (newest === null || ageHours < newest) newest = ageHours;
    }
    return newest;
  } catch {
    return null;
  }
}

/** Paper ledger rows whose stored PnL decomposition does not add up. */
async function paperMismatches(): Promise<number | null> {
  try {
    const session = await getActivePaperSession();
    if (!session) return 0; // no session is not a mismatch
    const fills = await loadPaperLedger(session.id, { outcome: "FILLED", limit: 500 });
    return fills.filter((f) => {
      if (f.cashPnlIrtToman === null || f.sellFeeValueToman === null || f.economicNetPnlToman === null) {
        return true;
      }
      if (f.cashPnlIrtToman - f.sellFeeValueToman !== f.economicNetPnlToman) return true;
      return f.balancesAfter.length === 0;
    }).length;
  } catch {
    return null;
  }
}

const backupDir = process.env.OTC_BACKUP_DIR ?? "backups";
const maxBackupAgeHours = envNumber("OPS_MAX_BACKUP_AGE_HOURS", null);
const maxFailedCycles = envNumber("OPS_MAX_FAILED_CYCLES", 0) ?? 0;
const maxDuplicateKeys = envNumber("OPS_MAX_DUPLICATE_KEYS", 0) ?? 0;

const readiness = await checkReadiness();
const runStats = await opsRunStats();
const [newestBackupAgeHours, mismatches] = await Promise.all([
  newestVerifiedBackupAgeHours(backupDir),
  paperMismatches()
]);

const { exitCode, findings } = evaluateOpsFindings(
  readiness,
  {
    maxFailedCycles,
    maxDuplicateKeys,
    maxBackupAgeHours,
    newestBackupAgeHours,
    paperReconciliationMismatches: mismatches
  },
  runStats
);

console.log("\nops-check\n");
for (const f of findings) {
  console.log(`  ${f.ok ? "PASS" : "FAIL"}  ${f.name.padEnd(22)} ${f.detail}`);
}
console.log(
  `\n  verdict: ${exitCode === OPS_EXIT.OK ? "healthy" : `unhealthy (exit ${exitCode})`}\n`
);

await closeDb().catch(() => undefined);
process.exit(exitCode);
