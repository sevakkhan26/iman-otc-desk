# Backup, restore-drill and scheduling runbook

> **Deferred, not done.** As of v4.11.0 the following are explicitly DEFERRED by
> the desk owner and are **not** release blockers. They require shell access to
> the production host, which the build tooling does not have:
>
> * running the real backup and the isolated restore drill against production;
> * installing the backup scheduler (daily 03:00 Asia/Tehran was the intended
>   cadence);
> * switching the running Compose healthcheck to `/api/health/ready`;
> * setting `OPS_MAX_BACKUP_AGE_HOURS=36` and wiring `ops:check` exit codes into
>   the desk's existing internal admin alerting.
>
> The application-level code for all four is complete, tested and shipped. Only
> the host-side activation remains.

Everything in this runbook is **manual and disabled by default**. This
repository schedules nothing, and no deployment step installs a timer or a cron
entry. Enabling automation requires shell access to the production host, which
this project's tooling does not have and does not attempt to obtain.

## 1. Which script to use

| Purpose | Script | Notes |
| --- | --- | --- |
| Canonical verified backup | `scripts/backup-production-db.sh` | Atomic, checksummed, integrity-verified, never overwrites |
| Rehearse a restore | `scripts/restore-drill.sh <dump>` | Isolated throwaway database; never touches the live one |
| Simple copy-to-another-PC dump | `scripts/pg-backup.sh` | Legacy convenience path; not scheduled |
| Restore into a real database | `scripts/pg-restore.sh` | Destructive by nature — read it before running it |
| Operational verdict | `pnpm ops:check` | Structured exit codes, no notifications |
| Storage growth | `pnpm ops:storage` | Read-only; `--retention` is dry-run only |

Do not add a fourth backup script. If something is missing, harden the
canonical one.

## 2. Taking a backup

```bash
cd /path/to/repo
OTC_BACKUP_DIR=/path/to/backups bash scripts/backup-production-db.sh
```

What the hardened script guarantees:

* the dump is written to `*.dump.partial` and renamed to `*.dump` **only after**
  `pg_restore --list` has read it successfully — an interrupted run leaves
  nothing that looks like a finished backup;
* a `*.dump.sha256` sidecar and a `*.meta.json` are written after publication,
  so "verified" is a property you can check later, not a claim;
* the run aborts rather than overwrite any existing artefact with the same
  timestamp;
* tracing is off and `umask 077` is set, so no credential is echoed and the
  artefacts are not world-readable.

## 3. Rehearsing the restore

A backup you have never restored is a hypothesis, not a backup.

```bash
bash scripts/restore-drill.sh backups/otc_desk-<stamp>.dump
```

The drill creates a throwaway database named `otc_restore_drill_<timestamp>_<pid>`,
re-validates that name against a strict pattern **before every statement**,
refuses to proceed if it does not carry the drill prefix or if it matches the
live or a system database, restores into it, verifies, and drops only that
database — including on interrupt, via a trap.

It verifies: applied migrations vs. files on disk, per-table row counts, the
observation id, the Paper session and its status, non-negative virtual balances,
ledger idempotency (no duplicate keys survived) and paper PnL reconciliation.

Exit code 0 means the backup is restorable and internally consistent.

## 4. Scheduling (requires production-host access)

`scripts/backup-scheduler.template` contains a **commented, inactive** systemd
timer and a cron alternative. Nothing installs it. To enable:

1. Read the template end to end and replace every `REPLACE_WITH_*` placeholder.
2. Decide the cadence yourself — the template proposes none.
3. Install the units, then `systemctl enable --now otc-backup.timer`.
4. Confirm with `systemctl list-timers otc-backup.timer`.
5. Verify the first automated run produced a `.dump`, a `.sha256` and a
   `.meta.json`, then run the restore drill against it.

To disable: `sudo systemctl disable --now otc-backup.timer`.

## 5. Retention

`pnpm ops:storage --retention` with `SHADOW_RETENTION_REPORT_DAYS` set prints
what **would** be in scope. It has no `DELETE` or `DROP` path at all. Before
acting on it:

1. take a verified backup;
2. rehearse the restore;
3. delete deliberately, table by table.

Immutable ledgers (`shadow_paper_ledger`) and readiness audit trails
(`shadow_live_*`) should normally be archived rather than deleted — they are the
evidence trail the readiness gates depend on.

## 6. Monitoring

`pnpm ops:check` exits with a specific code per failure class:

| Code | Meaning |
| --- | --- |
| 0 | healthy |
| 10 | database failure |
| 11 | stale collector |
| 12 | failed cycles above `OPS_MAX_FAILED_CYCLES` |
| 13 | duplicate keys above `OPS_MAX_DUPLICATE_KEYS` |
| 14 | backup missing, unverified, or older than `OPS_MAX_BACKUP_AGE_HOURS` |
| 15 | paper reconciliation mismatch |
| 16 | migrations pending |

`OPS_MAX_BACKUP_AGE_HOURS` is unset by default and the backup check then reports
"not checked" rather than passing silently. There is no notification credential
anywhere in this repository; wire the exit code into the desk's existing
alerting on the host.

## 7. Container probes

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `/api/health/live` | none | Process is running |
| `/api/health/ready` | none | Database reachable, migrations applied, collector lease held with a fresh heartbeat |
| `/api/shadow-arbitrage/health` | admin | Full diagnostics |

The two probes are unauthenticated because Docker cannot log in. They return
only check names and short non-sensitive details — no connection string,
hostname, worker id, version or business figure. Everything operationally
interesting stays behind the admin gate.

Suggested Compose healthcheck (not applied automatically):

```yaml
healthcheck:
  test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
  interval: 30s
  timeout: 5s
  retries: 3
  start_period: 60s
```

Applying it changes container restart behaviour on the production host, so it is
documented here rather than committed into the running Compose file.
