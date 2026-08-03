#!/usr/bin/env npx tsx
/**
 * Ramzinex connectivity incident — regression tests for the proxy fallback.
 *
 * The incident: production reported "no order book received this cycle" for
 * Ramzinex while the adapter, the endpoint and the parser were all healthy from
 * elsewhere. The cause was egress, not parsing — and the fix must recover from
 * that WITHOUT ever accepting bad data as good.
 *
 * These tests run against a local HTTP server standing in for the venue and for
 * the proxy, so every branch is exercised for real: a direct 200, a direct
 * 403/429/timeout recovered through the proxy, both paths failing, no proxy
 * configured at all, and malformed data that must never be retried into
 * looking healthy.
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";

let passed = 0;
let failed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e instanceof Error ? (e.stack ?? e.message) : e}`);
    failed += 1;
  }
}

/** A stand-in venue whose behaviour each test sets. */
type Behaviour = "ok" | "403" | "429" | "timeout" | "malformed" | "empty";
let directBehaviour: Behaviour = "ok";
let directHits = 0;

const BOOK = { data: { buys: [[1922000, 0.79]], sells: [[1933452, 64.9]] } };

function handler(req: IncomingMessage, res: ServerResponse) {
  directHits += 1;
  switch (directBehaviour) {
    case "403":
      res.writeHead(403).end("forbidden");
      return;
    case "429":
      res.writeHead(429).end("slow down");
      return;
    case "timeout":
      // Never answers; the client's own timeout must fire.
      return;
    case "malformed":
      res.writeHead(200, { "content-type": "application/json" }).end("{not json");
      return;
    case "empty":
      res.writeHead(200, { "content-type": "application/json" }).end("");
      return;
    default:
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(BOOK));
  }
}

const venue: Server = createServer(handler);
await new Promise<void>((r) => venue.listen(0, "127.0.0.1", r));
const venuePort = (venue.address() as AddressInfo).port;
const VENUE_URL = `http://127.0.0.1:${venuePort}/book`;

/**
 * A stand-in forward proxy. It always serves a good book, so "recovered through
 * the proxy" is distinguishable from "the direct path worked after all".
 */
let proxyHits = 0;
let proxyBehaviour: "ok" | "fail" = "ok";
const PROXY_BOOK = { data: { buys: [[1900000, 1.5]], sells: [[1910000, 2.5]] } };
const proxy: Server = createServer((req, res) => {
  proxyHits += 1;
  if (proxyBehaviour === "fail") {
    res.writeHead(502).end("bad gateway");
    return;
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(PROXY_BOOK));
});
await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", r));
const proxyPort = (proxy.address() as AddressInfo).port;

const reset = (direct: Behaviour, withProxy: boolean, proxyOk: "ok" | "fail" = "ok") => {
  directBehaviour = direct;
  proxyBehaviour = proxyOk;
  directHits = 0;
  proxyHits = 0;
  if (withProxy) process.env.OUTBOUND_HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  else delete process.env.OUTBOUND_HTTPS_PROXY;
  // The proxy agent is cached per process; re-import with a fresh module registry.
  return import(`../src/lib/shadowArbitrage/adapters/base.ts?v=${Math.random()}`);
};

/* ── the healthy path ────────────────────────────────────────────────────── */

await test("a direct HTTP 200 is used as-is, and the proxy is never touched", async () => {
  const { shadowRequest } = await reset("ok", true);
  const res = await shadowRequest<typeof BOOK>(VENUE_URL, { timeoutMs: 2000, maxAttempts: 2 });
  assert.equal(res.httpStatus, 200);
  assert.equal(res.viaProxy, false, "the direct path served it");
  assert.equal(res.directFailure, null, "and nothing failed");
  assert.deepEqual(res.data.data.buys, BOOK.data.buys, "the venue's own book, not the proxy's");
  assert.equal(proxyHits, 0, "the proxy was not contacted");
  assert.equal(directHits, 1, "exactly one direct request — no needless retry");
});

/* ── recovery ────────────────────────────────────────────────────────────── */

for (const [label, behaviour, expectFailure] of [
  ["403", "403", "HTTP 403"],
  ["429", "429", "HTTP 429"],
  ["a timeout", "timeout", "timeout"]
] as Array<[string, Behaviour, string]>) {
  await test(`a direct ${label} recovers through the configured proxy`, async () => {
    const { shadowRequest } = await reset(behaviour, true);
    const res = await shadowRequest<typeof BOOK>(VENUE_URL, { timeoutMs: 1200, maxAttempts: 2 });
    assert.equal(res.viaProxy, true, "the proxy served it");
    assert.ok(
      String(res.directFailure).includes(expectFailure),
      `the direct failure is recorded exactly: ${res.directFailure}`
    );
    assert.deepEqual(res.data.data.buys, PROXY_BOOK.data.buys, "the payload came from the proxy");
    assert.ok(proxyHits >= 1, "the proxy really was contacted");
  });
}

/* ── fail closed ─────────────────────────────────────────────────────────── */

await test("both paths failing stays blocked, with both reasons kept", async () => {
  const { shadowRequest } = await reset("403", true, "fail");
  await assert.rejects(
    () => shadowRequest(VENUE_URL, { timeoutMs: 1200, maxAttempts: 2 }),
    (e: Error) => {
      assert.match(e.message, /مستقیم/, "it names the direct attempt");
      assert.match(e.message, /HTTP 403/, "with the direct status");
      assert.match(e.message, /پراکسی/, "and the proxy attempt");
      return true;
    }
  );
  assert.ok(proxyHits >= 1, "the proxy was tried before giving up");
});

await test("a direct failure with no proxy configured does not crash — it fails closed", async () => {
  const { shadowRequest } = await reset("403", false);
  await assert.rejects(
    () => shadowRequest(VENUE_URL, { timeoutMs: 1200, maxAttempts: 2 }),
    /403/,
    "the original status survives"
  );
  assert.equal(proxyHits, 0, "no proxy was contacted");
});

await test("a missing proxy does not crash startup or the health of other calls", async () => {
  const { shadowRequest } = await reset("ok", false);
  const res = await shadowRequest<typeof BOOK>(VENUE_URL, { timeoutMs: 2000, maxAttempts: 2 });
  assert.equal(res.httpStatus, 200, "a healthy venue is unaffected by proxy absence");
  assert.equal(res.viaProxy, false);
});

/* ── never retry bad data into looking good ──────────────────────────────── */

for (const [label, behaviour] of [
  ["malformed JSON", "malformed"],
  ["an empty body", "empty"]
] as Array<[string, Behaviour]>) {
  await test(`${label} is never retried through the proxy`, async () => {
    const { shadowRequest } = await reset(behaviour, true);
    await assert.rejects(() => shadowRequest(VENUE_URL, { timeoutMs: 1500, maxAttempts: 1 }));
    assert.equal(
      proxyHits,
      0,
      "another network path cannot fix a bad payload, so it must not be tried"
    );
  });
}

/* ── the reason reaches the operator ─────────────────────────────────────── */

await test("the exact reason survives into the capacity surface, not a generic message", async () => {
  const { validateBook, venueCapacity, BOOK_PROBLEM_FA } = await import(
    "../src/lib/shadowArbitrage/paper/liquidity.ts"
  );

  const generic = validateBook(null, null, "ORDER_BOOK");
  assert.equal(generic.ok, false);
  if (!generic.ok) assert.equal(generic.detailFa, BOOK_PROBLEM_FA.book_missing);

  const specific = validateBook(null, null, "ORDER_BOOK", "مستقیم HTTP 403؛ پراکسی HTTP 502");
  assert.equal(specific.ok, false);
  if (!specific.ok) {
    assert.match(specific.detailFa, /HTTP 403/, "the upstream status is visible");
    assert.match(specific.detailFa, /پراکسی/, "and which path also failed");
    assert.notEqual(specific.detailFa, BOOK_PROBLEM_FA.book_missing, "not the generic text");
  }

  const cap = venueCapacity({
    sourceId: "ramzinex",
    marketModel: "ORDER_BOOK",
    bookBids: null,
    bookAsks: null,
    irtToman: 1_000_000,
    usdtMicros: 1_000_000,
    feeBps: 25,
    buyFeeAsset: "IRT",
    sellFeeAsset: "USDT",
    capitalShareToman: null,
    policyOrderSizeMicros: null,
    policyExposureMicros: null,
    sourceFailureFa: "مستقیم timeout؛ پراکسی HTTP 502"
  });
  const text = JSON.stringify(cap);
  assert.match(text, /timeout/, "the capacity row carries the real reason");
  assert.equal(cap.buy.capacityUsdtMicros, null, "and still refuses to invent capacity");
  assert.equal(cap.sell.capacityUsdtMicros, null);
});

await test("an OTC dealer is still described structurally, never as a failure", async () => {
  const { validateBook } = await import("../src/lib/shadowArbitrage/paper/liquidity.ts");
  const r = validateBook(null, null, "OTC_QUOTE", "مستقیم HTTP 403");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.problem, "quote_only_no_order_book", "structural, not an outage");
    assert.equal(/HTTP 403/.test(r.detailFa), false, "a dealer's missing ladder is not a failure");
  }
});

/* ── the routing config ──────────────────────────────────────────────────── */

await test("Ramzinex is covered by the proxy host list, and the override pins it", async () => {
  const { readFileSync } = await import("node:fs");
  const http = readFileSync(new URL("../src/lib/http.ts", import.meta.url), "utf8");
  assert.match(http, /"ramzinex\.com"/, "the built-in list still covers the venue");

  const { shouldUseOutboundProxy } = await import(`../src/lib/http.ts?v=${Math.random()}`);
  process.env.OUTBOUND_HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`;
  delete process.env.PROXY_HOSTS;
  assert.equal(
    shouldUseOutboundProxy("publicapi.ramzinex.com"),
    true,
    "the subdomain matches the built-in entry"
  );

  /*
   * PROXY_HOSTS REPLACES the built-in list rather than extending it, which is
   * how this host came to be excluded. The production override pins a list that
   * includes it, so a narrow value cannot drift back in.
   */
  const compose = readFileSync(new URL("../docker-compose.production.yml", import.meta.url), "utf8");
  assert.match(compose, /PROXY_HOSTS:/, "the override sets the list");
  assert.match(compose, /ramzinex\.com/, "and includes Ramzinex");
  assert.equal(
    /OUTBOUND_HTTPS_PROXY\s*:/.test(compose),
    false,
    "the proxy URL carries credentials and is never committed"
  );
});

await test("no proxy credential is ever logged", async () => {
  const { readFileSync } = await import("node:fs");
  for (const f of ["../src/lib/http.ts", "../src/lib/shadowArbitrage/adapters/base.ts"]) {
    const src = readFileSync(new URL(f, import.meta.url), "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(
      /console\.(log|warn|error)[\s\S]{0,80}(proxyUrl|OUTBOUND_HTTPS_PROXY|readOutboundProxyUrl)/.test(code),
      false,
      `${f} never logs the proxy URL`
    );
  }
});

/* ── other venues are untouched ──────────────────────────────────────────── */

await test("other adapters keep their own endpoints and parsing", async () => {
  const { readFileSync } = await import("node:fs");
  const dir = new URL("../src/lib/shadowArbitrage/adapters/", import.meta.url);
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "base.ts" && f !== "index.ts");
  assert.ok(files.length >= 8, `all venue adapters present: ${files.length}`);
  for (const f of files) {
    const src = readFileSync(new URL(f, dir), "utf8");
    // No adapter reaches around the shared request path to fetch on its own.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.equal(
      /\bfetch\s*\(/.test(code),
      false,
      `${f} goes through shadowRequest, so it inherits the fallback unchanged`
    );
  }
});

venue.close();
proxy.close();

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
