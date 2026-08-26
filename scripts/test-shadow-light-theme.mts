#!/usr/bin/env npx tsx
/**
 * Structural Light-theme desk-surface tests for Shadow Arbitrage.
 * File reads only — no browser, network, database, or engine.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

const read = (rel: string) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

await test("Shadow Light theme uses paper desk tokens; Dark keeps the cool navy", () => {
  const css = read("app/globals.css");
  const desk = css.slice(css.indexOf("SHADOW-TASK-005 desk remediaiton"));
  assert.ok(desk.includes(':root[data-theme="dark"] .sa-page {'), "dark desk tokens must be scoped");
  assert.ok(
    desk.includes(':root[data-theme="dark"] .sa-page.sa-page-tabbed'),
    "the navy page canvas is dark-only"
  );
  assert.ok(desk.includes("--sa-desk-bg: #07090d"), "dark canvas value is preserved");
  assert.ok(desk.includes("--sa-desk-panel: #10141c"), "dark panel value is preserved");

  const lightTokens = desk.slice(
    desk.indexOf(".sa-page {"),
    desk.indexOf(':root[data-theme="dark"] .sa-page {')
  );
  assert.ok(lightTokens.includes("--sa-desk-bg: var(--bg)"), "Light canvas aliases --bg");
  assert.ok(lightTokens.includes("--sa-desk-panel: var(--card)"), "Light panel aliases --card");
  assert.ok(lightTokens.includes("--sa-desk-line: var(--line-soft)"), "Light line aliases --line-soft");
  assert.equal(lightTokens.includes("#07090d"), false, "Light must not hardcode the navy canvas");
  assert.equal(lightTokens.includes("#10141c"), false, "Light must not hardcode the navy panel");

  assert.ok(desk.includes("var(--sa-desk-mix"), "waterfall mix uses a theme token");
  assert.equal(
    /color-mix\(in srgb, var\(--card\) 88%, #0b1018\)/.test(desk),
    false,
    "waterfall must not mix toward a hardcoded dark hex"
  );
  assert.ok(desk.includes(':root[data-theme="light"] .sa-page .sa-exp-strip'), "session strip has a Light surface");
  assert.ok(desk.includes(':root[data-theme="light"] .sa-page .sa-pill-indicator'), "selected tab is visible on paper");
});

await test("LIVE_EXECUTION_IMPLEMENTED remains a compile-time false", () => {
  const capability = read("src/lib/shadowArbitrage/live/capability.ts");
  assert.ok(capability.includes("export const LIVE_EXECUTION_IMPLEMENTED = false as const"));
  assert.equal(/process\.env/.test(capability), false);
});

await test("theme toggle still writes data-theme light|dark", () => {
  const hook = read("src/hooks/useTheme.ts");
  assert.ok(hook.includes('document.documentElement.setAttribute("data-theme", mode)'));
  assert.ok(hook.includes('"dark" | "light"') || hook.includes("ThemeMode"));
  const toggle = read("src/components/ThemeToggleButton.tsx");
  assert.ok(toggle.includes('setTheme(isDark ? "light" : "dark")'));
});

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
