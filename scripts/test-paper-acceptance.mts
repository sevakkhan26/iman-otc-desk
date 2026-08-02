#!/usr/bin/env npx tsx
/**
 * Phase 8E-B — the whole Paper acceptance, in one command.
 *
 *   pnpm test:paper-acceptance          (needs the live RC on 127.0.0.1:3210)
 *
 * Runs both modes and exits 0 only when all three hold:
 *
 *   1. the live RC gate reports zero genuine failures;
 *   2. every check it reported as NOT_APPLICABLE carries an explicit reason,
 *      and only the fourteen drawer checks are allowed to be skipped at all;
 *   3. the deterministic fixture gate passes all twenty of its checks, with
 *      nothing skipped.
 *
 * What this deliberately does NOT do: swallow an exit code, wrap a run in
 * `|| true`, catch broadly, or treat a missing summary as success. A crashed
 * child, an unparsable summary, or a skip without a reason all fail here — the
 * only thing that is tolerated is a drawer check the RC ledger genuinely cannot
 * exercise, and only when the live gate has already proved why.
 */
import { spawn } from "node:child_process";

import { acceptanceProblems, parseAcceptanceSummary } from "./paperAcceptanceVerdict.mts";

function run(label: string, script: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    console.log(`\n────────  ${label}  ────────\n`);
    const child = spawn("npx", ["--yes", "tsx", script], {
      env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --experimental-websocket`.trim() },
      stdio: ["ignore", "pipe", "inherit"]
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString();
      process.stdout.write(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

const problems: string[] = [];

/* ── mode 1: the live RC ─────────────────────────────────────────────────── */

const live = await run("live RC — 127.0.0.1:3210", "scripts/test-paper-browser.mts");
const liveSummary = parseAcceptanceSummary(live.out);

/* ── mode 2: the deterministic fixture ───────────────────────────────────── */

const fixture = await run(
  "deterministic fixture — isolated temporary database",
  "scripts/test-paper-drawer-browser.mts"
);
const fixtureSummary = parseAcceptanceSummary(fixture.out);

problems.push(
  ...acceptanceProblems({
    live: liveSummary,
    liveExitCode: live.code,
    fixture: fixtureSummary,
    fixtureExitCode: fixture.code
  })
);

/* ── verdict ─────────────────────────────────────────────────────────────── */

const totalPass = (liveSummary?.pass ?? 0) + (fixtureSummary?.pass ?? 0);
const totalNa = (liveSummary?.notApplicable ?? 0) + (fixtureSummary?.notApplicable ?? 0);
const totalFail = (liveSummary?.fail ?? 0) + (fixtureSummary?.fail ?? 0);

console.log("\n════════  Paper acceptance  ════════\n");
console.log(
  `  live RC   ${String(liveSummary?.pass ?? "?").padStart(3)} PASS  ` +
    `${String(liveSummary?.notApplicable ?? "?").padStart(3)} NOT_APPLICABLE  ` +
    `${String(liveSummary?.fail ?? "?").padStart(3)} FAIL`
);
console.log(
  `  fixture   ${String(fixtureSummary?.pass ?? "?").padStart(3)} PASS  ` +
    `${String(fixtureSummary?.notApplicable ?? "?").padStart(3)} NOT_APPLICABLE  ` +
    `${String(fixtureSummary?.fail ?? "?").padStart(3)} FAIL`
);
console.log(
  `  TOTAL     ${String(totalPass).padStart(3)} PASS  ` +
    `${String(totalNa).padStart(3)} NOT_APPLICABLE  ` +
    `${String(totalFail).padStart(3)} FAIL`
);

if (liveSummary?.skipped.length) {
  console.log("\n  Not applicable on the live RC, with the verified reason:");
  for (const s of liveSummary.skipped) console.log(`    · ${s.name}\n        ${s.reason}`);
  console.log(
    "\n  These fourteen executed for real in the fixture mode above, against a fill\n" +
      "  the paper engine produced over invented order books."
  );
}

if (problems.length) {
  console.log("\n  ACCEPTANCE FAILED:");
  for (const p of problems) console.log(`    ✗ ${p}`);
  console.log("");
  process.exit(1);
}

console.log("\n  ACCEPTANCE PASSED\n");
