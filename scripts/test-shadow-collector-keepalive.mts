#!/usr/bin/env npx tsx
/**
 * Regression: collector poll sleep must keep the Node event loop alive when
 * there are no WebSocket (or other) ref'd handles — otherwise the worker
 * silently exits after cycle 1 in REST-only mode.
 *
 * LIVE=false. No network. No economics/policy changes.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const tmpDir = path.join(repoRoot, ".data", "keepalive-regression-tmp");
mkdirSync(tmpDir, { recursive: true });

const childScript = path.join(tmpDir, "keepalive-child.mjs");

// Child reproduces the runner sleep pattern (ref'd vs unref'd) with no other handles.
writeFileSync(
  childScript,
  `
import { setTimeout as sleepRaw } from "node:timers/promises";

const mode = process.argv[2]; // "unref" | "ref"
const cycles = Number(process.argv[3] || 3);
const pollMs = Number(process.argv[4] || 80);

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (mode === "unref" && typeof timer === "object" && "unref" in timer) timer.unref();
  });
}

let completed = 0;
for (let i = 1; i <= cycles; i++) {
  completed = i;
  process.stdout.write("cycle " + i + "\\n");
  if (i < cycles) await sleep(pollMs);
}
process.stdout.write("done cycles=" + completed + "\\n");
process.exit(0);
`
);

function runMode(mode: string): Promise<{ code: number | null; out: string; ms: number }> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [childScript, mode, "3", "100"], {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let out = "";
    child.stdout.on("data", (b) => (out += b.toString()));
    child.stderr.on("data", (b) => (out += b.toString()));
    const killer = setTimeout(() => {
      child.kill("SIGKILL");
    }, 3000);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, out, ms: Date.now() - t0 });
    });
  });
}

const unrefResult = await runMode("unref");
const refResult = await runMode("ref");

const unrefCycles = (unrefResult.out.match(/^cycle /gm) || []).length;
const refCycles = (refResult.out.match(/^cycle /gm) || []).length;
const refDone = /done cycles=3/.test(refResult.out);

console.log(
  JSON.stringify(
    {
      unref: { cyclesLogged: unrefCycles, code: unrefResult.code, ms: unrefResult.ms, out: unrefResult.out.trim() },
      ref: { cyclesLogged: refCycles, code: refResult.code, ms: refResult.ms, done: refDone, out: refResult.out.trim() }
    },
    null,
    2
  )
);

// Unref mode exits early (often after cycle 1) because nothing keeps the loop alive.
assert.ok(
  unrefCycles < 3 || unrefResult.code !== 0,
  "expected unref mode to fail completing 3 cycles (bug reproduction)"
);
assert.equal(unrefCycles, 1, "unref reproduction should stop after first cycle when no other handles exist");

// Ref mode must complete all 3 cycles cleanly.
assert.equal(refCycles, 3, "ref mode must complete 3 cycles");
assert.ok(refDone, "ref mode must print done");
assert.equal(refResult.code, 0, "ref mode exit 0");

// Source guard: runner.ts must not unref the poll sleep.
import { readFileSync } from "node:fs";
const runner = readFileSync(path.join(repoRoot, "src/lib/shadowArbitrage/runner.ts"), "utf8");
const sleepBlock = runner.slice(runner.indexOf("const sleep = (ms: number)"), runner.indexOf("const unsubscribeEvents"));
assert.ok(sleepBlock.includes("Keep the poll sleep referenced"), "runner sleep must document keepalive");
assert.equal(
  /timer\.unref\(\)/.test(sleepBlock),
  false,
  "runner poll sleep must NOT call timer.unref()"
);

rmSync(tmpDir, { recursive: true, force: true });
console.log("PASS test-shadow-collector-keepalive");
