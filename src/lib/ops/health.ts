/**
 * Phase 7A.2 — shared operational health checks.
 *
 * One implementation, three consumers: the Docker liveness probe, the Docker
 * readiness probe and the `ops:check` CLI. Building a second health system
 * beside the existing admin `/api/shadow-arbitrage/health` would guarantee the
 * two drift apart, so this module only adds the container-level checks the
 * admin endpoint deliberately does not provide.
 *
 * Everything here is read-only. It never writes, never touches the collector,
 * and never returns a hostname, connection string, credential, worker id or any
 * other operational secret — the probes are unauthenticated by necessity.
 */
import { getDbAsync, getDatabaseUrl, isPgliteUrl, pingDatabase } from "@/db/client";
import { migrationStatus } from "@/db/migrate";
import { getWorkerHeartbeat, loadRunStats } from "@/db/repositories/shadowArbitrage";

/** Liveness answers one question: is this process able to run code at all? */
export type LivenessResult = {
  status: "alive";
  uptimeSeconds: number;
};

export function checkLiveness(): LivenessResult {
  return { status: "alive", uptimeSeconds: Math.floor(process.uptime()) };
}

export type ReadinessCheckName = "database" | "migrations" | "collector";

export type ReadinessCheck = {
  name: ReadinessCheckName;
  ok: boolean;
  /** Short, non-sensitive detail. Never a URL, host, credential or worker id. */
  detail: string;
};

export type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: ReadinessCheck[];
};

/** How stale a heartbeat may be before readiness fails, as poll-interval multiples. */
const HEARTBEAT_STALE_MULTIPLIER = 3;

/**
 * Readiness answers: can this container serve correctly right now?
 *
 * Database reachable, every migration on disk applied, and a collector lease
 * held with a heartbeat inside its expected window. A container that cannot
 * satisfy all three should not receive traffic.
 *
 * Fails closed: any thrown error becomes `ok: false` with a generic detail.
 */
export async function checkReadiness(): Promise<ReadinessResult> {
  const checks: ReadinessCheck[] = [];

  // 1 — database
  let dbOk = false;
  try {
    await getDbAsync();
    await pingDatabase();
    dbOk = true;
    checks.push({ name: "database", ok: true, detail: "reachable" });
  } catch {
    checks.push({ name: "database", ok: false, detail: "unreachable" });
  }

  // 2 — migrations. Only meaningful once the database answered.
  if (!dbOk) {
    checks.push({ name: "migrations", ok: false, detail: "unknown (database unreachable)" });
  } else {
    try {
      const status = await migrationStatus();
      const ok = status.pending.length === 0 && status.onDisk.length > 0;
      checks.push({
        name: "migrations",
        ok,
        // Counts only — file names are not sensitive, but counts are enough.
        detail: ok
          ? `${status.applied.length}/${status.onDisk.length} applied`
          : `${status.pending.length} pending`
      });
    } catch {
      checks.push({ name: "migrations", ok: false, detail: "unreadable" });
    }
  }

  // 3 — collector lease and heartbeat
  if (!dbOk) {
    checks.push({ name: "collector", ok: false, detail: "unknown (database unreachable)" });
  } else {
    try {
      const worker = await getWorkerHeartbeat();
      if (!worker) {
        checks.push({ name: "collector", ok: false, detail: "no heartbeat recorded" });
      } else {
        const ageMs = worker.lastHeartbeatAt
          ? Math.max(0, Date.now() - Date.parse(worker.lastHeartbeatAt))
          : Number.POSITIVE_INFINITY;
        const budgetMs = (worker.pollIntervalMs || 30_000) * HEARTBEAT_STALE_MULTIPLIER;
        const fresh = ageMs <= budgetMs;
        const ok = Boolean(worker.leaseHeld) && fresh && !worker.stale;
        checks.push({
          name: "collector",
          ok,
          // Deliberately no worker id: that names a container and a pid.
          detail: ok
            ? "lease held, heartbeat fresh"
            : !worker.leaseHeld
              ? "lease not held"
              : "heartbeat stale"
        });
      }
    } catch {
      checks.push({ name: "collector", ok: false, detail: "unreadable" });
    }
  }

  return {
    status: checks.every((c) => c.ok) ? "ready" : "not_ready",
    checks
  };
}

/* ── ops-check: structured, machine-readable operational verdict ──────────── */

/**
 * Exit codes for `pnpm ops:check`. Distinct codes so a scheduler or a human can
 * react to the specific failure rather than to a generic non-zero.
 */
export const OPS_EXIT = {
  OK: 0,
  DATABASE_FAILURE: 10,
  STALE_COLLECTOR: 11,
  FAILED_CYCLES: 12,
  DUPLICATE_KEYS: 13,
  BACKUP_FAILURE: 14,
  PAPER_RECONCILIATION_MISMATCH: 15,
  MIGRATIONS_PENDING: 16
} as const;

export type OpsExitCode = (typeof OPS_EXIT)[keyof typeof OPS_EXIT];

export type OpsFinding = {
  code: OpsExitCode;
  name: string;
  ok: boolean;
  detail: string;
};

export type OpsCheckInput = {
  /** Failed cycles tolerated in the window. Explicit — never assumed. */
  maxFailedCycles: number;
  maxDuplicateKeys: number;
  /** Newest backup must be no older than this. Explicit. */
  maxBackupAgeHours: number | null;
  /** Age of the newest verified backup, or null when none was found. */
  newestBackupAgeHours: number | null;
  /** Paper ledger rows whose stored PnL decomposition does not add up. */
  paperReconciliationMismatches: number | null;
};

/**
 * Evaluate the operational findings. Pure: the caller gathers the numbers, so
 * this stays testable without a database or a filesystem.
 *
 * The first failing finding decides the exit code, in severity order.
 */
export function evaluateOpsFindings(
  readiness: ReadinessResult,
  input: OpsCheckInput,
  runStats: { failedRuns: number; duplicateIdempotencyKeys: number }
): { exitCode: OpsExitCode; findings: OpsFinding[] } {
  const findings: OpsFinding[] = [];

  const db = readiness.checks.find((c) => c.name === "database");
  findings.push({
    code: OPS_EXIT.DATABASE_FAILURE,
    name: "database",
    ok: Boolean(db?.ok),
    detail: db?.detail ?? "unknown"
  });

  const migrations = readiness.checks.find((c) => c.name === "migrations");
  findings.push({
    code: OPS_EXIT.MIGRATIONS_PENDING,
    name: "migrations",
    ok: Boolean(migrations?.ok),
    detail: migrations?.detail ?? "unknown"
  });

  const collector = readiness.checks.find((c) => c.name === "collector");
  findings.push({
    code: OPS_EXIT.STALE_COLLECTOR,
    name: "collector",
    ok: Boolean(collector?.ok),
    detail: collector?.detail ?? "unknown"
  });

  findings.push({
    code: OPS_EXIT.FAILED_CYCLES,
    name: "failed_cycles",
    ok: runStats.failedRuns <= input.maxFailedCycles,
    detail: `${runStats.failedRuns} failed (limit ${input.maxFailedCycles})`
  });

  findings.push({
    code: OPS_EXIT.DUPLICATE_KEYS,
    name: "duplicate_keys",
    ok: runStats.duplicateIdempotencyKeys <= input.maxDuplicateKeys,
    detail: `${runStats.duplicateIdempotencyKeys} duplicates (limit ${input.maxDuplicateKeys})`
  });

  // A backup age limit is only enforced when the operator stated one.
  const backupOk =
    input.maxBackupAgeHours === null
      ? true
      : input.newestBackupAgeHours !== null && input.newestBackupAgeHours <= input.maxBackupAgeHours;
  findings.push({
    code: OPS_EXIT.BACKUP_FAILURE,
    name: "backup",
    ok: backupOk,
    detail:
      input.maxBackupAgeHours === null
        ? "no maximum age configured — not checked"
        : input.newestBackupAgeHours === null
          ? "no verified backup found"
          : `newest backup ${input.newestBackupAgeHours.toFixed(1)}h old (limit ${input.maxBackupAgeHours}h)`
  });

  findings.push({
    code: OPS_EXIT.PAPER_RECONCILIATION_MISMATCH,
    name: "paper_reconciliation",
    // Unmeasured is not a pass: an unmeasured ledger is not a reconciled one.
    ok: input.paperReconciliationMismatches === 0,
    detail:
      input.paperReconciliationMismatches === null
        ? "not measured"
        : `${input.paperReconciliationMismatches} mismatched ledger rows`
  });

  const firstFailure = findings.find((f) => !f.ok);
  return { exitCode: firstFailure ? firstFailure.code : OPS_EXIT.OK, findings };
}

/** Gather the run statistics the ops check needs. Read-only. */
export async function opsRunStats(): Promise<{
  failedRuns: number;
  duplicateIdempotencyKeys: number;
}> {
  try {
    const stats = await loadRunStats();
    return {
      failedRuns: stats.failedRuns,
      duplicateIdempotencyKeys: stats.duplicateIdempotencyKeys
    };
  } catch {
    // Fail closed: unreadable statistics are not healthy statistics.
    return { failedRuns: Number.MAX_SAFE_INTEGER, duplicateIdempotencyKeys: Number.MAX_SAFE_INTEGER };
  }
}

/** True when the configured database is the local single-writer PGlite file. */
export function usingPglite(): boolean {
  try {
    return isPgliteUrl(getDatabaseUrl());
  } catch {
    return false;
  }
}
