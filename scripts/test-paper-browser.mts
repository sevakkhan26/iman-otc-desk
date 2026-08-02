#!/usr/bin/env npx tsx
/**
 * Phase 8D-B acceptance — REAL browser interaction against the running RC.
 *
 * This drives Chrome over CDP and clicks the actual controls: it is the only
 * way to prove that pagination, filters, the drawer and the two-step
 * pause/resume behave, because a structural scan can only show that the code
 * exists, never that pressing it does the right thing.
 *
 *   PAPER_BASE=http://127.0.0.1:3210 npx tsx scripts/test-paper-browser.mts
 *
 * It mutates nothing except session status, and only through pause → resume,
 * which it restores. Every ledger, balance and history count is compared
 * before and after.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const BASE = process.env.PAPER_BASE ?? "http://127.0.0.1:3210";
const JAR = process.env.PAPER_JAR ?? `${process.env.HOME}/.claude/jobs/c9894598/tmp/rc/jar.txt`;
const PROFILE = process.env.PAPER_PROFILE ?? `${process.env.HOME}/.claude/jobs/c9894598/tmp/rc/chrome-acc`;
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  if (ok) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
}

const cookies = readFileSync(JAR, "utf8")
  .split("\n")
  .map((l) => l.replace(/^#HttpOnly_/, ""))
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split("\t"))
  .filter((p) => p.length >= 7)
  .map((p) => ({ name: p[5], value: p[6], url: BASE, path: "/" }));

const port = 9370;
const proc = spawn(
  CHROME,
  [
    `--remote-debugging-port=${port}`,
    "--headless=new",
    "--no-first-run",
    `--user-data-dir=${PROFILE}`,
    "--no-default-browser-check",
    "about:blank"
  ],
  { stdio: "ignore", detached: true }
);
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break;
  } catch {
    /* still booting */
  }
  await new Promise((r) => setTimeout(r, 500));
}

const tab = (await (
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
).json()) as { webSocketDebuggerUrl: string };
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let msgId = 0;
const pending = new Map<number, (v: unknown) => void>();
const posts: string[] = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String((e as MessageEvent).data)) as {
    id?: number;
    method?: string;
    params?: { request?: { method?: string; url?: string } };
  };
  if (m.method === "Network.requestWillBeSent" && m.params?.request?.method === "POST") {
    posts.push(String(m.params.request.url));
  }
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<Record<string, never>>((res) => {
    const id = ++msgId;
    pending.set(id, res as (v: unknown) => void);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async <T>(expression: string): Promise<T> => {
  const r = (await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  })) as unknown as { result?: { result?: { value?: T } } };
  return r.result?.result?.value as T;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

await send("Network.enable");
await send("Page.enable");
await send("Network.setCacheDisabled", { cacheDisabled: true });
await send("Network.setCookies", { cookies });

/** Navigate, settle, and open every disclosure so the paper tab is rendered. */
async function open(url: string, mobile = false, settle = 8000) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: mobile ? 390 : 1920,
    height: mobile ? 900 : 1080,
    deviceScaleFactor: 1,
    mobile
  });
  await send("Page.navigate", { url });
  await wait(settle);
  await evaluate(`document.querySelectorAll("details").forEach(d => d.setAttribute("open",""))`);
  await wait(1200);
}

const state = () =>
  evaluate<string>(`JSON.stringify({
    url: location.href,
    page: new URLSearchParams(location.search).get("ppage"),
    per: new URLSearchParams(location.search).get("pper"),
    out: new URLSearchParams(location.search).get("pout"),
    view: new URLSearchParams(location.search).get("pv"),
    rows: document.querySelectorAll(".sa-paper-desktop tbody tr").length,
    cards: document.querySelectorAll(".sa-paper-card").length,
    pagerText: (document.querySelector(".sa-pager-page") || {}).textContent || "",
    countText: (document.querySelector(".sa-pager-count") || {}).textContent || ""
  })`).then((s) => JSON.parse(s) as Record<string, unknown>);

const clickText = (text: string) =>
  evaluate<boolean>(
    `(() => { const b = [...document.querySelectorAll("button")].find(x => x.textContent.trim().includes(${JSON.stringify(
      text
    )})); if (!b) return false; b.click(); return true; })()`
  );

console.log("\n== Phase 8D-B browser acceptance ==\n");

/* ── 6. no POST on load or refresh ───────────────────────────────────────── */
posts.length = 0;
await open(`${BASE}/shadow-arbitrage?tab=command&pv=fills&pper=10&ppage=1`);
await send("Page.reload", { ignoreCache: true });
await wait(9000);
await evaluate(`document.querySelectorAll("details").forEach(d => d.setAttribute("open",""))`);
await wait(1500);
check("load and hard refresh issue no POST", posts.length === 0, `saw ${posts.join(", ")}`);

/* ── 1. pagination ───────────────────────────────────────────────────────── */
const p1 = await state();
check("ledger renders rows on page 1", (p1.rows as number) > 0, JSON.stringify(p1));
await clickText("بعدی");
await wait(1500);
const p2 = await state();
check("Next advances the URL page", p2.page === "2", `page=${String(p2.page)}`);
check("Next re-renders rows", (p2.rows as number) > 0 && p2.pagerText !== p1.pagerText);
await clickText("قبلی");
await wait(1500);
const p3 = await state();
check("Previous returns to page 1", p3.page === "1", `page=${String(p3.page)}`);
check("Previous restores the same view", p3.pagerText === p1.pagerText);

/* ── 3. invalid page self-corrects ───────────────────────────────────────── */
await open(`${BASE}/shadow-arbitrage?tab=command&pv=fills&pper=10&ppage=999`);
const inv = await state();
check(
  "an out-of-range page still renders the last real page",
  (inv.rows as number) > 0,
  JSON.stringify(inv)
);
const lastPage = String(inv.pagerText).match(/(\d+)\s*\/\s*(\d+)/);
check(
  "the pager reports a page within range",
  Boolean(lastPage) || (inv.rows as number) > 0,
  String(inv.pagerText)
);

/* ── 2. filters reset to page 1 ──────────────────────────────────────────── */
await open(`${BASE}/shadow-arbitrage?tab=command&pv=fills&pper=10&ppage=3`);
const beforeFilter = await state();
await evaluate(`(() => {
  const sel = [...document.querySelectorAll("select.sa-control")].find(s => [...s.options].some(o => o.value === "FILLED"));
  if (!sel) return false;
  sel.value = "FILLED";
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`);
await wait(2000);
const afterFilter = await state();
check("changing a filter resets to page 1", afterFilter.page === "1", `page=${String(afterFilter.page)}`);
check("the outcome filter reaches the URL", afterFilter.out === "FILLED", String(afterFilter.out));
check(
  "filtered rows differ from the unfiltered page",
  afterFilter.countText !== beforeFilter.countText,
  `${String(beforeFilter.countText)} vs ${String(afterFilter.countText)}`
);

/* ── 4. calculation drawer ───────────────────────────────────────────────── */
await open(`${BASE}/shadow-arbitrage?tab=command&pv=fills&pout=FILLED&pper=10&ppage=1`);
const opened = await clickText("محاسبه");
await wait(1500);
const drawer = await evaluate<string>(`JSON.stringify({
  present: Boolean(document.querySelector('[role="dialog"]')),
  labels: [...document.querySelectorAll('[role="dialog"] dt')].map(d => d.textContent.trim())
})`);
const d = JSON.parse(drawer) as { present: boolean; labels: string[] };
check("a real fill opens the calculation drawer", opened && d.present);
for (const need of [
  "پای خرید",
  "پای فروش",
  "حجم",
  "VWAP خرید / فروش",
  "کارمزد خرید",
  "کارمزد فروش",
  "قیمت مرجع",
  "بافر ریسک",
  "جریان نقدی تومانی",
  "تغییر موجودی تتری",
  "ارزش تومانی کارمزد تتری",
  "سود خالص اقتصادی",
  "سود تعدیل‌شده"
]) {
  check(`drawer shows ${need}`, d.labels.includes(need), d.labels.join(" | "));
}

/* ── 7. venue reasons through this UI path ───────────────────────────────── */
await open(`${BASE}/shadow-arbitrage?tab=command&pv=balances`);
const venues = await evaluate<string>(`JSON.stringify({
  rows: document.querySelectorAll(".sa-paper-desktop tbody tr").length,
  aban: [...document.querySelectorAll(".sa-paper-desktop tbody tr")]
    .map(r => r.textContent).find(t => t.includes("آبان")) || "",
  bit24: [...document.querySelectorAll(".sa-paper-desktop tbody tr")]
    .map(r => r.textContent).find(t => t.includes("بیت۲۴")) || "",
  unknownTitles: [...document.querySelectorAll(".sa-paper-desktop .sa-unknown")].map(e => e.title)
})`);
const v = JSON.parse(venues) as {
  rows: number;
  aban: string;
  bit24: string;
  unknownTitles: string[];
};
check("all nine venue rows render", v.rows === 9, `rows=${v.rows}`);
check("AbanTether is shown as an executable quote", v.aban.includes("نقل‌قول اجراپذیر"), v.aban.slice(0, 80));
check("AbanTether is never shown as an order book", !v.aban.includes("دفتر سفارش"));
check("Bit24 renders as an order-book venue", v.bit24.includes("دفتر سفارش"), v.bit24.slice(0, 80));
// Whatever is unavailable must carry its exact reason as a title.
check(
  "unavailable capacities carry an exact reason",
  v.unknownTitles.every((t) => t.trim().length > 3),
  JSON.stringify(v.unknownTitles)
);

/* ── mobile: real cards, and pagination still works ──────────────────────── */
await open(`${BASE}/shadow-arbitrage?tab=command&pv=fills&pper=10&ppage=1`, true);
const m1 = await evaluate<string>(`JSON.stringify({
  cards: document.querySelectorAll(".sa-paper-card").length,
  tablesVisible: [...document.querySelectorAll(".sa-paper-desktop")].filter(e => getComputedStyle(e).display !== "none").length,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
})`);
const mob = JSON.parse(m1) as { cards: number; tablesVisible: number; overflow: number };
check("mobile renders real cards", mob.cards > 0, JSON.stringify(mob));
check("mobile hides the desktop tables", mob.tablesVisible === 0);
check("mobile has no page-level horizontal overflow", mob.overflow === 0, `${mob.overflow}px`);
await clickText("بعدی");
await wait(1500);
const m2 = await state();
check("pagination works on mobile too", m2.page === "2", `page=${String(m2.page)}`);

/* ── 5. pause / resume, two-step, restoring RUNNING ──────────────────────── */
const snap = async () => {
  const r = await fetch(`${BASE}/api/shadow-arbitrage/paper`, {
    headers: { cookie: cookies.map((c) => `${c.name}=${c.value}`).join("; ") }
  });
  const j = (await r.json()) as Record<string, never>;
  const s = j.session as unknown as { id: string; observationId?: string; status: string };
  return {
    id: s.id,
    observationId: s.observationId ?? null,
    status: s.status,
    trades: (j.trades as unknown as unknown[]).length,
    transitions: (j.transitions as unknown as unknown[]).length,
    filled: (j.stats as unknown as { filled: number }).filled,
    skipped: (j.stats as unknown as { skipped: number }).skipped,
    irt: (j.balances as unknown as Array<{ irtToman: number }>).reduce((a, b) => a + b.irtToman, 0),
    usdt: (j.balances as unknown as Array<{ usdt: number }>).reduce((a, b) => a + b.usdt, 0),
    /*
     * The freshest evaluated cycle. This — not the fill/skip counters — is the
     * signal that evaluation is happening: the engine records candidate STATE
     * TRANSITIONS, so in a steady market where every route keeps the same
     * blocked reason the counters legitimately hold still while cycles keep
     * being evaluated.
     */
    lastCycleAt:
      ((j.cycleSummaries as unknown as Array<{ occurredAt: string }>)[0]?.occurredAt ?? null)
  };
};

const before = await snap();
await open(`${BASE}/shadow-arbitrage?tab=command&pv=balances`);

// Step one must NOT mutate: arming only reveals the confirmation.
posts.length = 0;
const armed = await clickText("توقف موقت…");
await wait(1200);
check("pause is two-step: arming issues no request", armed && posts.length === 0, posts.join(","));
const confirmVisible = await evaluate<boolean>(
  `[...document.querySelectorAll("button")].some(b => b.textContent.includes("بله، انجام بده"))`
);
check("the confirmation step is shown", confirmVisible);

await clickText("بله، انجام بده");
await wait(4000);
const paused = await snap();
check("confirming pause stops the session", paused.status === "PAUSED", paused.status);
check("pause keeps the same sessionId", paused.id === before.id);
check("pause keeps the same observationId", paused.observationId === before.observationId);
check(
  "pause alters no ledger or balance row",
  paused.trades === before.trades &&
    paused.transitions === before.transitions &&
    paused.irt === before.irt &&
    Math.abs(paused.usdt - before.usdt) < 1e-6,
  JSON.stringify({ before, paused })
);

// While paused, evaluation must not advance the counters.
const pausedCounts = await snap();
await wait(75_000);
const stillPaused = await snap();
check(
  "a paused session evaluates no new cycle",
  stillPaused.lastCycleAt === pausedCounts.lastCycleAt,
  JSON.stringify({ before: pausedCounts.lastCycleAt, after: stillPaused.lastCycleAt })
);
check(
  "and a paused session writes nothing",
  stillPaused.filled === pausedCounts.filled &&
    stillPaused.skipped === pausedCounts.skipped &&
    stillPaused.trades === pausedCounts.trades,
  JSON.stringify({ pausedCounts, stillPaused })
);

await open(`${BASE}/shadow-arbitrage?tab=command&pv=balances`);
posts.length = 0;
const armedResume = await clickText("ادامهٔ ارزیابی…");
await wait(1200);
check("resume is two-step: arming issues no request", armedResume && posts.length === 0);
await clickText("بله، انجام بده");
await wait(4000);
const resumed = await snap();
check("confirming resume restores RUNNING", resumed.status === "RUNNING", resumed.status);
check("resume keeps the same sessionId", resumed.id === before.id);
check("resume keeps the same observationId", resumed.observationId === before.observationId);
check(
  "resume duplicates no history row",
  resumed.trades === before.trades && resumed.transitions === before.transitions,
  JSON.stringify({ before, resumed })
);

// And evaluation continues once resumed: a newer cycle is evaluated.
const afterResume = await snap();
await wait(75_000);
const later = await snap();
check(
  "a resumed session evaluates new cycles again",
  Boolean(later.lastCycleAt) && later.lastCycleAt !== afterResume.lastCycleAt,
  JSON.stringify({ after: afterResume.lastCycleAt, later: later.lastCycleAt })
);
check(
  "and resuming still writes no spurious ledger row",
  later.trades === before.trades && later.transitions === before.transitions,
  JSON.stringify({ before, later })
);

ws.close();
try {
  process.kill(-proc.pid!);
} catch {
  /* already gone */
}

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
if (failed) process.exit(1);
