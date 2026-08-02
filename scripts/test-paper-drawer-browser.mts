#!/usr/bin/env npx tsx
/**
 * Phase 8E-B — the calculation-drawer half of the Paper acceptance.
 *
 *   npx tsx scripts/test-paper-drawer-browser.mts
 *
 * `test-paper-browser.mts` drives the live RC, and fourteen of its assertions
 * open the drawer of a filled trade. Those can only run when a fill exists, and
 * a fill only exists when the market offers a net-positive route. Waiting for
 * one is not a test strategy, and writing one into the RC would be fabricating
 * a trade that never happened.
 *
 * So this boots a SEPARATE application instance on a SEPARATE throwaway
 * database, seeded by `seed-paper-fill-fixture.mts`: invented order books, one
 * of which crosses, and one fill produced by the real engine, broker, sizer and
 * ledger. The drawer then shows the engine's own arithmetic — a demonstration
 * of the calculation over fixture prices, never a live fill.
 *
 * It never opens the RC database, never writes to `.data/`, and removes its own
 * scratch directory when it finishes.
 */
import { startPreviewApp, preparePage } from "./previewRuntime.mts";

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

/** Every label the drawer must carry, exactly as the RC gate lists them. */
const REQUIRED_LABELS = [
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
];

const app = await startPreviewApp({
  seed: true,
  seedScript: "scripts/seed-paper-fill-fixture.mts",
  port: Number(process.env.DRAWER_PORT ?? 3188),
  debugPort: Number(process.env.DRAWER_DEBUG_PORT ?? 9334),
  dist: process.env.DRAWER_DIST ?? ".next-preview"
});

try {
  const cdp = await app.newPage();
  await preparePage(cdp, app, { width: 1440, height: 1000, theme: "light", mobile: false });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await cdp.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true
    })) as { result?: { value?: T } };
    return r.result?.value as T;
  };
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const open = async (url: string) => {
    await cdp.send("Page.navigate", { url });
    await wait(5000);
  };
  const clickText = async (text: string) =>
    evaluate<boolean>(`(() => {
      const el = [...document.querySelectorAll('button')]
        .find(b => (b.textContent || '').trim().includes(${JSON.stringify(text)}));
      if (!el) return false;
      el.click();
      return true;
    })()`);

  const BASE = `http://127.0.0.1:${app.port}`;

  /* ── the fixture really did fill, through the engine ───────────────────── */
  // Same-origin: the page must be loaded before the API is read through it.
  await open(`${BASE}/shadow-arbitrage?tab=command&pv=fills`);
  const api = await evaluate<string>(
    `fetch('/api/shadow-arbitrage/paper', { credentials: 'same-origin' }).then(r => r.text())`
  );
  const paper = JSON.parse(api) as {
    session?: { status?: string };
    trades?: Array<{ outcome?: string; buySourceId?: string; sellSourceId?: string }>;
    realOrders?: boolean;
  };
  check("the fixture database carries exactly one trade", (paper.trades ?? []).length === 1,
    `trades=${(paper.trades ?? []).length}`);
  check("and it is a fill the engine recorded", paper.trades?.[0]?.outcome === "FILLED",
    String(paper.trades?.[0]?.outcome));
  check("the fixture app still executes no real orders", paper.realOrders === false,
    String(paper.realOrders));

  /* ── the drawer ─────────────────────────────────────────────────────────── */
  await open(`${BASE}/shadow-arbitrage?tab=command&pv=fills&pout=FILLED&pper=10&ppage=1`);
  const rows = await evaluate<number>(
    `document.querySelectorAll('.sa-paper-desktop tbody tr').length`
  );
  check("the ledger renders the filled row", rows >= 1, `rows=${rows}`);

  const opened = await clickText("محاسبه");
  await wait(1800);
  const drawer = JSON.parse(
    await evaluate<string>(`JSON.stringify({
      present: Boolean(document.querySelector('[role="dialog"]')),
      labels: [...document.querySelectorAll('[role="dialog"] dt')].map(d => d.textContent.trim()),
      values: [...document.querySelectorAll('[role="dialog"] dd')].map(d => d.textContent.trim())
    })`)
  ) as { present: boolean; labels: string[]; values: string[] };

  check("a real fill opens the calculation drawer", Boolean(opened) && drawer.present);
  for (const need of REQUIRED_LABELS) {
    check(`drawer shows ${need}`, drawer.labels.includes(need), drawer.labels.join(" | "));
  }

  /* ── the figures are present, not blank placeholders ───────────────────── */
  const filled = drawer.values.filter((v) => v && v !== "—").length;
  check(
    "every drawer figure carries a value rather than an em dash",
    filled >= REQUIRED_LABELS.length,
    `${filled} of ${drawer.values.length} values are populated`
  );

  /*
   * The five PnL figures are reported separately, and the risk-adjusted figure
   * must not simply repeat the economic one — that would mean the buffer was
   * never applied.
   */
  const labelled = new Map(drawer.labels.map((l, i) => [l, drawer.values[i]]));
  check(
    "economic and risk-adjusted profit are reported as different figures",
    labelled.get("سود خالص اقتصادی") !== labelled.get("سود تعدیل‌شده"),
    `${labelled.get("سود خالص اقتصادی")} vs ${labelled.get("سود تعدیل‌شده")}`
  );

  cdp.close();
} finally {
  await app.stop();
}

console.log(`\nResult: ${passed} passed, ${failed} failed\n`);
console.log(
  "Every price behind these figures is invented fixture data. The fill was produced by the real engine over that fixture; it is not a market observation and not a live trade.\n"
);
if (failed) process.exit(1);
