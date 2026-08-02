# Paper acceptance gates

Two browser gates cover the Paper Execution surface. Both drive a real Chrome
over CDP and click the actual controls, because a structural scan can show that
code exists but never that pressing it does the right thing.

Neither is part of `pnpm test`. They need a running application, they take
minutes, and one of them mutates session status — none of which belongs in the
unit-test command.

## `pnpm test:paper-acceptance` — run this one

Runs both modes below and exits 0 only when the live RC gate has zero genuine
failures, every check it reported as NOT_APPLICABLE carries an explicit verified
reason (and is one of the fourteen drawer checks), and the fixture gate passes
all twenty of its checks with nothing skipped.

PASS, NOT_APPLICABLE and FAIL are counted and printed separately, per mode and
in total. The rule that decides the verdict lives in
`scripts/paperAcceptanceVerdict.mts` and is tested adversarially: twelve shapes
a hidden regression could take are each required to be rejected.

Nothing is swallowed. A crashed child, a missing summary line, a skip without a
reason, a skip of a check that is not skippable, or a non-zero exit with no
recorded failure all fail the acceptance.

## `pnpm test:paper-browser` — mandatory before any release

Drives the **live RC on `http://127.0.0.1:3210`**. Start the RC first; the gate
does not build or boot anything.

Covers pagination, URL state, an out-of-range page, the outcome filter,
pause → resume (both two-step confirmations, restored afterwards), the absence
of any POST on load or refresh, the desktop tables and the true mobile cards,
and the per-venue reasons for AbanTether and Bit24.

It mutates nothing except session status, and compares every ledger, balance and
history count before and after.

**Fourteen of its assertions open the calculation drawer of a filled trade and
therefore require the RC ledger to contain at least one fill.** When there is no
fill they are reported as NOT_APPLICABLE rather than FAIL — but only after the
gate has PROVED why, as an ordinary passing check: the ledger holds no filled
trade AND every current route is blocked solely by `non_positive_net`. A ledger
that is empty because routes are blocked on evidence, certification or an
unknown fee is a defect, and that check goes red instead.

Whenever a fill does exist the fourteen run for real and a broken drawer fails
the gate. Never write a fill into the RC to make them pass.

## `pnpm test:paper-drawer` — the drawer, on its own fixture

Self-contained: it boots a **separate application instance on a separate
throwaway database** on port 3188 and seeds it with
`scripts/seed-paper-fill-fixture.mts`.

The fixture's order books are invented, chosen so exactly one route crosses far
enough to survive fees, the slippage buffer and the risk floor. The fill itself
is not invented — it is produced by `runPaperExecutionForCycle`, the same engine
the collector calls, through the same broker, sizer and ledger. So the drawer
shows the engine's own arithmetic over fixture prices.

**Never describe that fill as a live trade or as a market observation.** It is a
demonstration of the calculation.

The fixture refuses to run against anything but a throwaway PGlite directory and
removes its own scratch when it finishes. It never opens the RC database.

## Related gates

* `pnpm test:fonts` — every Shadow surface resolves to IRANYekan, desktop and
  mobile. Boots its own preview app; delete `.next-preview` if the UI changed
  and the run looks stale, because it reuses an existing build.
* `pnpm test:migration-0013` — builds a genuine pre-0013 database, clones it,
  migrates the clone, restarts, and re-runs the migration. Part of `pnpm test`.
