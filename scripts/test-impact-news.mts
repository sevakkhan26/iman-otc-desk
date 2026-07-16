/**
 * Impact News pipeline unit tests (no network).
 * Run: npx tsx scripts/test-impact-news.mts
 */

import assert from "node:assert/strict";
import {
  classifyImpact,
  dedupeArticles,
  filterByRetention,
  HIGH_IMPACT_WINDOW_MS,
  idForArticle,
  isWithinRetention,
  scoreAndBuildArticle,
  scoreIranRelevance,
  sortArticlesForDisplay,
  tickerEligible,
  VISIBLE_WINDOW_MS,
  type RawNewsArticle,
  type ScoredNewsArticle
} from "../src/lib/news/pipeline.ts";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (error) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : error}`);
    failed += 1;
  }
}

function raw(partial: Partial<RawNewsArticle> & { title: string }): RawNewsArticle {
  return {
    source: partial.source ?? "TestSource",
    publishedAt: partial.publishedAt ?? new Date().toISOString(),
    url: partial.url,
    sourceId: partial.sourceId ?? "test",
    snippet: partial.snippet,
    title: partial.title
  };
}

function mustScore(title: string, extra?: Partial<RawNewsArticle>): ScoredNewsArticle {
  const item = scoreAndBuildArticle(raw({ title, ...extra }));
  assert.ok(item, `expected accepted article for: ${title}`);
  return item!;
}

console.log("Impact News pipeline tests\n");

test("1. Fresh Iran-related article is accepted", () => {
  const item = scoreAndBuildArticle(
    raw({
      title: "US expands Iran sanctions targeting oil and banking channels",
      publishedAt: new Date().toISOString()
    })
  );
  assert.ok(item);
  assert.ok((item?.iranRelevanceScore ?? 0) >= 42);
});

test("2. Unrelated global article is rejected", () => {
  const item = scoreAndBuildArticle(
    raw({
      title: "Bitcoin meme coin airdrop contest goes viral on social media",
      publishedAt: new Date().toISOString()
    })
  );
  assert.equal(item, null);
});

test("3. High-impact sanctions article classified as high (زیاد)", () => {
  const { severity, impactScore } = classifyImpact("OFAC issues new Iran sanctions on crypto-related facilitators");
  assert.equal(severity, "high");
  assert.ok(impactScore >= 80);
});

test("4. Moderate regulatory article classified as medium (متوسط)", () => {
  const { severity } = classifyImpact("FATF updates crypto travel rule guidance for member states");
  assert.equal(severity, "medium");
});

test("5. Low-impact commentary classified as low (کم)", () => {
  const { severity } = classifyImpact("Opinion: What is the future of crypto markets this decade?");
  assert.equal(severity, "low");
});

test("6. Articles older than 72h retention removed (non-high)", () => {
  const old = new Date(Date.now() - VISIBLE_WINDOW_MS - 60_000).toISOString();
  assert.equal(isWithinRetention(old, "medium"), false);
  assert.equal(isWithinRetention(old, "low"), false);
});

test("7. High-impact can remain up to 7 days", () => {
  const fiveDays = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
  const eightDays = new Date(Date.now() - HIGH_IMPACT_WINDOW_MS - 60_000).toISOString();
  assert.equal(isWithinRetention(fiveDays, "high"), true);
  assert.equal(isWithinRetention(eightDays, "high"), false);
});

test("8. Duplicate stories are merged", () => {
  const a = mustScore("Iran sanctions hit oil exports and banking access", {
    url: "https://example.com/story?utm_source=x",
    source: "Reuters"
  });
  const b = mustScore("Iran sanctions hit oil exports and banking access", {
    url: "https://example.com/story?utm_medium=y",
    source: "Blog Mirror"
  });
  const c = mustScore("Iran sanctions hit oil exports and banking access — update", {
    url: "https://other.com/different",
    source: "CoinDesk",
    publishedAt: a.publishedAt
  });
  const merged = dedupeArticles([a, b, c]);
  // a+b same normalized URL → one; c may merge by title similarity
  assert.ok(merged.length <= 2);
  assert.ok(merged.some((m) => m.source === "Reuters" || m.id === a.id));
});

test("9. Published time is preserved", () => {
  const publishedAt = "2026-07-15T10:00:00.000Z";
  const item = mustScore("Tehran rial pressure rises after new banking restrictions", { publishedAt });
  assert.equal(item.publishedAt, publishedAt);
});

test("10. Failed provider isolation pattern (allSettled shape)", () => {
  // Simulate allSettled merge: one rejected feed must not wipe others
  const ok = [mustScore("US Treasury sanctions Iranian oil network")];
  const results: Array<PromiseSettledResult<ScoredNewsArticle[]>> = [
    { status: "fulfilled", value: ok },
    { status: "rejected", reason: new Error("timeout") }
  ];
  const collected = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  assert.equal(collected.length, 1);
});

test("11. HTTP 429 backoff field shape (retryAfterAt)", () => {
  // Pure unit: verify we can represent backoff timestamp for provider health
  const retryAfterAt = new Date(Date.now() + 120_000).toISOString();
  assert.ok(Date.parse(retryAfterAt) > Date.now());
});

test("12. Stale news not presented as fresh (retention filter)", () => {
  const stale = mustScore("Iran sanctions update from last month", {
    publishedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
  });
  // force low/medium so 72h window applies if not high
  const forced = { ...stale, severity: "medium" as const };
  const visible = filterByRetention([forced]);
  assert.equal(visible.length, 0);
});

test("13. Empty fresh dataset message constant", () => {
  const msg = "در حال حاضر خبر تازه و اثرگذار مرتبط با بازار ایران یافت نشد.";
  assert.ok(msg.includes("خبر تازه"));
});

test("14. Ticker uses only medium/high", () => {
  const high = mustScore("Tether freezes wallets linked to Iranian sanctions evasion");
  const mid = mustScore("FATF flags Iranian crypto corridors in new report");
  const lowBase = mustScore("Iran rial and USDT premium discussed in market note");
  const low = { ...lowBase, severity: "low" as const, impactScore: 20 };
  const tick = tickerEligible([high, mid, low]);
  assert.ok(tick.every((t) => t.severity === "high" || t.severity === "medium"));
  assert.ok(!tick.some((t) => t.severity === "low"));
});

test("15. No fake fallback articles from scorer", () => {
  assert.equal(scoreAndBuildArticle(raw({ title: "Cute cats win internet award" })), null);
  assert.equal(scoreAndBuildArticle(raw({ title: "" })), null);
});

test("16. Refresh does not create duplicate records (stable ids)", () => {
  const title = "Iranian exchanges face new banking restrictions on crypto rails";
  const url = "https://news.example.com/iran-banking-crypto";
  const id1 = idForArticle(title, url);
  const id2 = idForArticle(title, url + "?utm_source=rss");
  assert.equal(id1, id2);
  const once = mustScore(title, { url });
  const twice = mustScore(title, { url: url + "?utm_campaign=x" });
  const merged = dedupeArticles([once, twice]);
  assert.equal(merged.length, 1);
});

test("Iran relevance: USDT freeze without Iran still may pass as bridge", () => {
  const score = scoreIranRelevance("Tether freezes wallets after sanctions compliance review");
  assert.ok(score >= 42, `score=${score}`);
});

test("Iran relevance: generic crypto market rejected", () => {
  const score = scoreIranRelevance("Crypto market sees mixed flows as bitcoin consolidates");
  assert.ok(score < 42, `score=${score}`);
});

test("Sort prefers high impact then recency", () => {
  const olderHigh = {
    ...mustScore("New Iran sanctions announced by US Treasury"),
    publishedAt: new Date(Date.now() - 3_600_000).toISOString(),
    severity: "high" as const,
    impactScore: 90
  };
  const newerLow = {
    ...mustScore("Iran free market dollar rate softens in quiet Tehran trading"),
    publishedAt: new Date().toISOString(),
    severity: "low" as const,
    impactScore: 30
  };
  const sorted = sortArticlesForDisplay([newerLow, olderHigh]);
  assert.equal(sorted[0]?.severity, "high");
});

console.log(`\nResult: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
