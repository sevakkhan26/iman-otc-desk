#!/usr/bin/env npx tsx
/**
 * CLOSED candidate ledger rows must carry exact rejectionCode opportunity_left_market
 * (not null / sizing_blocked / unknown).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const src = readFileSync(path.join(root, "src/db/repositories/shadowPaper.ts"), "utf8");
const closedBlock = src.slice(src.indexOf("Candidates that vanished from the market"), src.indexOf("One compact summary per cycle"));
assert.ok(closedBlock.includes('rejectionCode: "opportunity_left_market"'), "CLOSED must set exact rejectionCode");
assert.ok(closedBlock.includes('reasonCodes: ["opportunity_left_market"]'), "CLOSED must set reasonCodes");
assert.equal(/rejectionCode:\s*null/.test(closedBlock), false, "CLOSED must not set rejectionCode null");
console.log("PASS test-paper-closed-exact-reject");
