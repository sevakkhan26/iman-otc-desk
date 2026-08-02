/**
 * Phase 8E-B — the rule that decides whether the Paper acceptance passed.
 *
 * Separated from the runner so it can be tested adversarially: a gate that
 * decides its own verdict inline can only be checked by breaking the RC, which
 * is not something a test may do. Here the decision is a pure function over the
 * two summaries, and `test-navigation.mts` feeds it the shapes a regression
 * would produce and requires each one to be rejected.
 */

export type AcceptanceSummary = {
  mode: string;
  pass: number;
  notApplicable: number;
  fail: number;
  skipped: Array<{ name: string; reason: string }>;
};

/**
 * The ONLY checks that may ever be reported as not applicable, and only on the
 * live RC. Everything else skipping is itself a failure.
 */
export const SKIPPABLE_CHECKS = new Set([
  "a real fill opens the calculation drawer",
  "drawer shows پای خرید",
  "drawer shows پای فروش",
  "drawer shows حجم",
  "drawer shows VWAP خرید / فروش",
  "drawer shows کارمزد خرید",
  "drawer shows کارمزد فروش",
  "drawer shows قیمت مرجع",
  "drawer shows بافر ریسک",
  "drawer shows جریان نقدی تومانی",
  "drawer shows تغییر موجودی تتری",
  "drawer shows ارزش تومانی کارمزد تتری",
  "drawer shows سود خالص اقتصادی",
  "drawer shows سود تعدیل‌شده"
]);

/** Every check the fixture mode must actually execute. */
export const FIXTURE_MIN_PASS = 20;

/** A skip reason has to say something; a blank or a shrug is not a reason. */
const MIN_REASON_LENGTH = 20;

export type VerdictInput = {
  live: AcceptanceSummary | null;
  liveExitCode: number;
  fixture: AcceptanceSummary | null;
  fixtureExitCode: number;
};

/**
 * Everything wrong with this run. Empty means the acceptance passed.
 *
 * The asymmetry is deliberate: a missing summary, an unexpected exit code and a
 * skip without a reason are all failures, because each of them is a way for a
 * broken run to look quiet.
 */
export function acceptanceProblems(input: VerdictInput): string[] {
  const problems: string[] = [];

  if (!input.live) {
    problems.push("the live RC gate printed no ACCEPTANCE_SUMMARY — it did not finish");
  } else {
    if (input.live.fail > 0) {
      problems.push(`the live RC gate reported ${input.live.fail} genuine failure(s)`);
    }
    for (const s of input.live.skipped) {
      if (!SKIPPABLE_CHECKS.has(s.name)) {
        problems.push(`«${s.name}» is not a check that may be skipped`);
      }
      if (!s.reason || s.reason.trim().length < MIN_REASON_LENGTH) {
        problems.push(`«${s.name}» was skipped without an explicit reason`);
      }
    }
    if (input.live.notApplicable !== input.live.skipped.length) {
      problems.push("the live RC gate's skip count and skip list disagree");
    }
  }
  // A non-zero exit with no recorded failure means it died rather than failed.
  if (input.liveExitCode !== 0 && (input.live?.fail ?? 0) === 0) {
    problems.push(`the live RC gate exited ${input.liveExitCode} without recording a failure`);
  }

  if (!input.fixture) {
    problems.push("the fixture gate printed no ACCEPTANCE_SUMMARY — it did not finish");
  } else {
    if (input.fixture.fail > 0) {
      problems.push(`the fixture gate reported ${input.fixture.fail} failure(s)`);
    }
    if (input.fixture.notApplicable > 0) {
      problems.push("the fixture gate skipped a check — it guarantees its own fill and may not");
    }
    if (input.fixture.pass < FIXTURE_MIN_PASS) {
      problems.push(
        `the fixture gate ran only ${input.fixture.pass} checks; ${FIXTURE_MIN_PASS} must execute`
      );
    }
  }
  if (input.fixtureExitCode !== 0 && (input.fixture?.fail ?? 0) === 0) {
    problems.push(`the fixture gate exited ${input.fixtureExitCode} without recording a failure`);
  }

  return problems;
}

/** Pull the last summary line out of a gate's stdout, or null if it never came. */
export function parseAcceptanceSummary(out: string): AcceptanceSummary | null {
  const line = out
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("ACCEPTANCE_SUMMARY "));
  if (!line) return null;
  return JSON.parse(line.slice("ACCEPTANCE_SUMMARY ".length)) as AcceptanceSummary;
}
