# Shadow Arbitrage — Phase 7A: Guarded Live-Execution Readiness

**Live execution is not implemented in this codebase.** `LIVE_EXECUTION_IMPLEMENTED`
is a compile-time `false` literal in `src/lib/shadowArbitrage/live/capability.ts`.
That file contains no `process.env` read, no configuration lookup and no branch,
and a test asserts it never grows one. There is no authenticated exchange client,
no credential storage, no order-placement function, no balance reader and no
deposit, withdrawal or transfer path anywhere in the repository.

Enabling live trading would require writing an exchange client that does not
exist, implementing the `ExecutionSurfacePort` with `canPlaceRealOrders: false`
(which the type forbids from being anything else), flipping a source constant and
shipping a new build. **No environment variable, header, database row, request
parameter or admin action can do it.**

---

## 1. Threat model

| # | Threat | Why it matters | Control in this build |
| --- | --- | --- | --- |
| T1 | Accidental live enablement via configuration | The classic "someone set a flag in prod" incident | Capability is a source literal with no env override; a test scans the file for `process.env` |
| T2 | Credential leakage through the readiness surface | A stored key is a permanent liability | The API refuses `apiKey`, `secret`, `token`, `password`, `passphrase`, `privateKey`, `mnemonic`, `credential`, `authorization` — as body keys **and** as attestation claim names. Only statements *about* keys are stored |
| T3 | Withdrawal abuse if keys ever exist | A key with withdrawal rights turns a bug into theft | `key_permissions` gate requires explicit attestation that keys are trading-only, withdrawal is disabled and IPs are whitelisted. Missing claim = BLOCKED |
| T4 | Leg risk — one leg fills, the other does not | Leaves an unhedged position that looks like a failure | `runTwoLegPlan` never reports this as FAILED; it returns `HEDGE_REQUIRED` with the exact open exposure |
| T5 | Duplicate submission after a timeout | Double execution of the same intent | Deterministic `clientOrderId(planId, side, attempt)`; the surface port is idempotent on it and flags repeats |
| T6 | Restart mid-flight | Silent retry of an order that may already exist | `RESTART_RECOVERY` maps every in-flight state to `RECONCILE`, never to `RESUME` |
| T7 | Stale evidence treated as current | Readiness that passed months ago is not readiness | Attestations expire after `ATTESTATION_VALID_DAYS = 90` and expire the gate with them |
| T8 | Invented risk or evidence thresholds | A default limit is an unreviewed limit | Every policy — risk **and** evidence — is required and starts unset; there is no `default` field and no numeric fallback in the definitions, asserted by a source scan |
| T13 | Evidence that silently ages | A limit approved a year ago is not a current decision | The approver states the validity period; an expired policy is treated exactly like an unset one |
| T14 | Unreadable readiness UI hiding a blocker | An overlapped blocker is an unread blocker | Fixed table layout, `overflow-wrap: anywhere`, RTL-safe `text-align: start`, optional columns dropped on tablet, full row stacking with labels on mobile — asserted structurally |
| T9 | Rate-limit driven account lockout | Losing API access mid-position | `api_rate_limit_per_minute` policy is required; unset blocks |
| T10 | Runaway loss | No automatic stop | `max_daily_loss_toman`, `global_kill_switch`, `per_venue_circuit_breaker_errors` are all required policies |
| T11 | Viewer or unauthenticated access | Readiness data reveals operational posture | Every route is behind `requireAdminSession`; viewers and anonymous requests get 401/403 |
| T12 | Collector or paper failure masked as readiness | Broken evidence must not read as good evidence | `collector_health` and `paper_evidence` gates fail closed on missing, stale or duplicate-cycle data |

---

## 2. Readiness gates

All twelve must pass. Each fails closed with an exact, non-generic reason.

**No threshold is chosen in code.** Every numeric requirement below comes from an
admin-approved policy with a null default. An unset — or expired — policy is a
blocker, and so is an unmeasured input. The engine contains no minimum constants
at all; a test asserts the source has none.

1. `observation_window` — elapsed time ≥ the admin-set `min_observation_duration_days`,
   **and** ≥80% success coverage (the Phase 2 observation rule).
2. `collector_health` — running, fresh heartbeat, duplicate idempotency keys within
   the admin-set `max_duplicate_idempotency_keys`, successful cycles ≥
   `min_successful_cycles`.
3. `capital_plan_approved` — Phase 5 recommendation currently `APPROVED_SIMULATION_PLAN`.
4. `paper_evidence` — a paper session meeting the admin-set `min_successful_cycles`,
   `min_paper_fills` and `max_paper_failures`.
5. `account_fee_readiness` — at least one executable venue, no stale fees.
6. `fee_settlement` — buy **and** sell settlement admin-confirmed per venue.
7. `api_capability` — public data verified, private API documented, least privilege documented.
8. `key_permissions` — trading-only keys, withdrawal disabled, IP whitelist confirmed.
9. `transfer_costs` — transfer and rebalancing costs actually known.
10. `risk_policies` — every required policy explicitly configured.
11. `reconciliation_integrity` — measured ledger mismatches within the admin-set
    `max_reconciliation_mismatches`. An unmeasured ledger is not a reconciled one.
12. `reconciliation_runbook` — reconciliation, incident runbook and rollback all approved.

Gates 7–9 and 11 rest on **attestations**: dated, attributed human statements
with structured claims. A missing claim blocks; it never defaults to true. An
attestation older than 90 days expires and re-blocks its gate.

Even with all twelve passing, `effectiveState` is `DISARMED`. `gateState` is
reported separately so the readiness work is visible and auditable.

---

## 3. Key-permission checklist

Complete this against the exchange's own account panel **before** attesting.
The desk never pastes a key into this system; only the answers are recorded.

- [ ] The key is scoped to **trading only** — no withdrawal, no transfer, no sub-account movement.
- [ ] **Withdrawal permission is explicitly disabled** on the key, verified in the venue UI.
- [ ] **IP whitelist** is enabled and lists only the production egress addresses.
- [ ] The key is **not** shared with any other system, script or person.
- [ ] Key creation, rotation and revocation owners are named.
- [ ] Rotation interval is agreed and diarised (≤90 days, matching attestation expiry).
- [ ] A revocation drill has been performed at least once.
- [ ] The venue's own audit log for the key has been reviewed and is clean.
- [ ] The key is stored only in the operator's secure credential store — **never** in this repository, this database, an environment file, a ticket or a chat message.

---

## 4. Incident runbook

**Detection.** Any of: an execution plan stuck outside `RECONCILED`, a
`HEDGE_REQUIRED` plan, consecutive errors reaching the configured limit, a venue
circuit breaker opening, daily loss reaching its limit, or collector health
degrading.

**Immediate actions, in order:**

1. Engage the **global kill switch**. Nothing new is planned while it is on.
2. Freeze the paper/live session — pause, do not stop, so the ledger stays intact.
3. Record the incident time, the plan ids affected and the observed state.
4. For each affected plan, read its last recorded state. Do **not** re-submit:
   in-flight states map to `RECONCILE`, not `RESUME`.
5. Reconcile each plan against the venue's own record of the client order id.
6. Quantify open exposure from `hedgeRequiredUsdtMicros`. Decide to hedge or
   unwind **manually**; the system will not do it.
7. Only after every affected plan reaches `RECONCILED`, review whether the
   trigger has been fixed.
8. Re-attest any gate whose evidence the incident invalidated.

**Escalation.** If open exposure exceeds `max_venue_exposure_percent` or the
venue is unreachable, stop reconciling and escalate to the desk owner. An
unreachable venue is not evidence that an order did not execute.

---

## 5. Rollback procedure

1. **Immediate** — engage the kill switch and pause the session. This changes no
   balances and loses no history.
2. **Application** — redeploy the previous release tag. Every migration in this
   project is additive, so an older build runs against a newer schema: it simply
   ignores columns and tables it does not know.
3. **Data** — never delete readiness, ledger or observation rows. All three
   audit trails are append-only; a wrong entry is corrected by adding a
   superseding entry, not by editing or removing one.
4. **Evidence** — after any rollback, re-run the readiness review and record it.
   A rollback invalidates nothing automatically; a human states what still holds.
5. **Verification** — confirm `observation.id` is unchanged, the collector is
   running with a fresh heartbeat, `duplicateIdempotencyKeys = 0` and the paper
   session is in the state it was left in.

---

## 6. Execution design (interfaces only)

**Pipeline.** opportunity → pre-trade validation → balance reservation →
approval → two-leg execution plan → reconciliation.

**Arming states.** `DISARMED` → `READY_FOR_REVIEW` → `MANUAL_CANARY_ELIGIBLE`.
There is no `ARMED` state; the type has no such member.

**Order-plan states.** `PLANNED` → `APPROVED` → `SENT` →
{`PARTIAL`, `FILLED`, `FAILED`, `HEDGE_REQUIRED`} → `RECONCILED`. Transitions
are whitelisted, so a plan cannot skip approval and every terminal path ends at
`RECONCILED`.

**Idempotency.** `clientOrderId(planId, side, attempt)` is deterministic. A
retry with the same attempt number is the same request; a genuine re-submission
must be an explicit new attempt.

**The only executable implementation** of `ExecutionSurfacePort` is
`createPaperSurface()`, which delegates to the Phase 6 paper broker. Tests use
fakes. `canPlaceRealOrders` is typed as the literal `false`.

---

## 7. What Phase 7A deliberately does **not** contain

- No exchange API client, authenticated request, signing code or HTTP call.
- No order placement, amendment or cancellation function.
- No account balance reader.
- No deposit, withdrawal or transfer path.
- No API-key or secret input field, storage column or environment variable.
- No arming action — the API returns `501 Not Implemented` for `arm`,
  `enable_live`, `execute` and `go_live`.
- No OMPFinex anywhere in Shadow.
