/**
 * Unit tests for server-authoritative market snapshot meta and client time extractors.
 */
import assert from "node:assert/strict";
import { extractServerTimes } from "../src/hooks/useApi.ts";
import { serverTimeToEpochMs } from "../src/hooks/useServerClock.ts";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}

async function main() {
  console.log("Market snapshot / server-time tests\n");

  await test("1. serverTimeToEpochMs parses ISO without browser clock", () => {
    const ms = serverTimeToEpochMs("2026-07-20T09:30:00.000Z");
    assert.equal(ms, Date.parse("2026-07-20T09:30:00.000Z"));
    assert.equal(serverTimeToEpochMs(null), null);
    assert.equal(serverTimeToEpochMs("not-a-date"), null);
  });

  await test("2. extractServerTimes prefers serverNow over nested fields", () => {
    const { serverNowIso, lastUpdatedMs } = extractServerTimes({
      serverNow: "2026-07-20T10:00:00.000Z",
      generatedAt: "2026-07-20T09:55:00.000Z",
      summary: { lastUpdated: "2026-07-20T09:50:00.000Z" }
    });
    assert.equal(serverNowIso, "2026-07-20T10:00:00.000Z");
    // last update prefers summary.lastUpdated when present
    assert.equal(lastUpdatedMs, Date.parse("2026-07-20T09:50:00.000Z"));
  });

  await test("3. extractServerTimes from dashboard nested tetherMarket", () => {
    const { serverNowIso, lastUpdatedMs } = extractServerTimes({
      serverNow: "2026-07-20T11:00:00.000Z",
      tetherMarket: {
        summary: { lastUpdated: "2026-07-20T10:59:00.000Z" }
      }
    });
    assert.equal(serverNowIso, "2026-07-20T11:00:00.000Z");
    assert.equal(lastUpdatedMs, Date.parse("2026-07-20T10:59:00.000Z"));
  });

  await test("4. extractServerTimes does not invent client wall-clock", () => {
    const { serverNowIso, lastUpdatedMs } = extractServerTimes({ foo: 1 });
    assert.equal(serverNowIso, null);
    assert.equal(lastUpdatedMs, null);
  });

  await test("5. two payloads with same serverNow yield identical epoch", () => {
    const iso = "2026-07-20T12:00:00.000Z";
    const a = extractServerTimes({ serverNow: iso, summary: { lastUpdated: iso } });
    const b = extractServerTimes({ serverNow: iso, summary: { lastUpdated: iso } });
    assert.equal(a.serverNowIso, b.serverNowIso);
    assert.equal(a.lastUpdatedMs, b.lastUpdatedMs);
  });

  console.log(`\nResult: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main();
