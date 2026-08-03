#!/usr/bin/env npx tsx
/**
 * Two RC checks a screenshot cannot make.
 *
 *   1. PASSIVE READS ONLY. Loading the page, hard-refreshing it and walking
 *      every tab must issue zero POST requests. A read-only surface that
 *      quietly posts is a surface that can change state by being looked at.
 *   2. THE SIX REQUIRED RISK POLICIES. Every policy SMART_CAPITAL_DEPTH refuses
 *      to size without must be visible in the admin UI, named exactly, with a
 *      control to set it — and, while unset, must read as BLOCKED rather than
 *      as a value someone chose.
 *
 * Drives the already-running RC over CDP with the existing session jar. It
 * clicks nothing that mutates, and asserts that it issued nothing that could.
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";

const BASE = process.env.PAPER_BASE ?? "http://127.0.0.1:3210";
const JAR = process.env.PAPER_JAR ?? `${process.env.HOME}/.claude/jobs/c9894598/tmp/rc/jar.txt`;
const PROFILE =
  process.env.PAPER_PROFILE ?? `${process.env.HOME}/.claude/jobs/c9894598/tmp/rc/chrome-passive`;
const CHROME =
  process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

let passed = 0;
let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(ok ? `  PASS  ${name}` : `  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  if (ok) passed += 1;
  else failed += 1;
}

/**
 * The six SMART_CAPITAL_DEPTH cannot proceed without, with the label the admin
 * table actually prints. The table renders the human label, not the key, so a
 * probe that looks for the key alone measures nothing.
 */
const REQUIRED_POLICIES = [
  { key: "max_order_size_usdt", labelFa: "حداکثر حجم هر سفارش" },
  { key: "max_venue_exposure_percent", labelFa: "حداکثر تمرکز روی یک صرافی" },
  { key: "min_risk_adjusted_edge_percent", labelFa: "حداقل سود اقتصادی تعدیل‌شده" },
  { key: "max_quote_age_ms", labelFa: "حداکثر کهنگی قیمت" },
  { key: "max_slippage_bps", labelFa: "حداکثر لغزش مجاز" },
  { key: "max_inventory_deviation_percent", labelFa: "حداکثر انحراف موجودی" }
];
const REQUIRED = REQUIRED_POLICIES.map((p) => p.key);

const cookies = readFileSync(JAR, "utf8")
  .split("\n")
  .map((l) => l.replace(/^#HttpOnly_/, ""))
  .filter((l) => l && !l.startsWith("#"))
  .map((l) => l.split("\t"))
  .filter((p) => p.length >= 7)
  .map((p) => ({ name: p[5], value: p[6], url: BASE, path: "/" }));

const port = 9372;
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
/** Every non-GET request the page issues, with its method and URL. */
const mutating: string[] = [];
ws.addEventListener("message", (e) => {
  const m = JSON.parse(String((e as MessageEvent).data)) as {
    id?: number;
    method?: string;
    params?: { request?: { method?: string; url?: string } };
  };
  if (m.id !== undefined && pending.has(m.id)) {
    pending.get(m.id)!(m);
    pending.delete(m.id);
    return;
  }
  const req = m.params?.request;
  if (m.method === "Network.requestWillBeSent" && req?.method && req.method !== "GET") {
    mutating.push(`${req.method} ${req.url}`);
  }
});

const send = <T = Record<string, unknown>>(method: string, params: unknown = {}): Promise<T> => {
  const id = (msgId += 1);
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((r) => pending.set(id, r as (v: unknown) => void)) as Promise<T>;
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const evaluate = async <T>(expression: string): Promise<T> => {
  const r = await send<{ result: { result: { value: T } } }>("Runtime.evaluate", {
    expression,
    returnByValue: true
  });
  return r.result.result.value;
};

await send("Network.enable");
await send("Page.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width: 1440,
  height: 1000,
  deviceScaleFactor: 1,
  mobile: false
});
for (const c of cookies) {
  await send("Network.setCookie", {
    name: c.name,
    value: c.value,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax"
  });
}

const open = async (url: string) => {
  await send("Page.navigate", { url });
  await wait(7_000);
};

/* ── 1. passive load, refresh and tab navigation ─────────────────────────── */
/* The real tab ids, from `src/components/shadowArbitrage/tabs.ts`. */
const TABS = ["command", "capital", "trades", "settings"];

mutating.length = 0;
await open(`${BASE}/shadow-arbitrage`);
check("first load issues no non-GET request", mutating.length === 0, mutating.join(" | "));

mutating.length = 0;
await send("Page.reload", { ignoreCache: true });
await wait(8_000);
check("hard refresh issues no non-GET request", mutating.length === 0, mutating.join(" | "));

for (const t of TABS) {
  mutating.length = 0;
  await open(`${BASE}/shadow-arbitrage?tab=${t}`);
  const rendered = await evaluate<boolean>(`Boolean(document.querySelector(".sa-page"))`);
  check(`tab «${t}» renders`, rendered);
  check(`tab «${t}» issues no non-GET request`, mutating.length === 0, mutating.join(" | "));
}

// And walking the tab strip by clicking, not by URL.
mutating.length = 0;
const clicked = await evaluate<number>(
  `(() => {
     const tabs = [...document.querySelectorAll(".sa-tab")];
     tabs.forEach((t) => t.click());
     return tabs.length;
   })()`
);
await wait(5_000);
check("the tab strip has clickable tabs", clicked > 0, `tabs=${clicked}`);
check(
  "clicking through every tab issues no non-GET request",
  mutating.length === 0,
  mutating.join(" | ")
);

/* ── 2. the six required risk policies ───────────────────────────────────── */
/*
 * The policy table lives behind two folds, and only the outer one is a
 * <details>. The readiness panel itself is gated by its own React state and a
 * «باز کردن» button, and it fetches nothing until that button is pressed — so
 * setting `details.open` is not enough, the button has to be clicked.
 *
 * Pressing it is a READ: the counter below asserts that opening the panel still
 * issues no non-GET request.
 */
await open(`${BASE}/shadow-arbitrage?tab=settings`);
await evaluate(`document.querySelectorAll("details").forEach((d) => { d.open = true; }), "ok"`);
await wait(3_000);
mutating.length = 0;
const openedPanel = await evaluate<boolean>(
  `(() => {
     const b = [...document.querySelectorAll("button")].find(
       (x) => (x.textContent || "").trim() === "باز کردن"
     );
     if (!b) return false;
     b.click();
     return true;
   })()`
);
check("the readiness panel has an open control", openedPanel);
await wait(8_000);
await evaluate(`document.querySelectorAll("details").forEach((d) => { d.open = true; }), "ok"`);
await wait(3_000);
check(
  "opening the readiness panel issues no non-GET request",
  mutating.length === 0,
  mutating.join(" | ")
);

const policyState = await evaluate<string>(
  `JSON.stringify(
     ${JSON.stringify(REQUIRED_POLICIES)}.map((p) => {
       const cell = [...document.querySelectorAll("td[data-label]")].find(
         (td) => (td.querySelector("strong")?.textContent || "").trim() === p.labelFa
       );
       const row = cell ? cell.closest("tr") : null;
       return {
         key: p.key,
         labelFa: p.labelFa,
         visible: Boolean(row),
         text: row ? row.innerText.replace(/\\s+/g, " ").slice(0, 300) : "",
         numberInputs: row ? row.querySelectorAll('input[type="number"]').length : 0,
         setButtons: row
           ? [...row.querySelectorAll("button")].filter((b) => /ثبت/.test(b.textContent || "")).length
           : 0
       };
     })
   )`
);
const rows = JSON.parse(policyState) as Array<{
  key: string;
  labelFa: string;
  visible: boolean;
  text: string;
  numberInputs: number;
  setButtons: number;
}>;

for (const r of rows) {
  check(`«${r.key}» has a row in the admin policy table`, r.visible, r.labelFa);
  check(
    `«${r.key}» is configurable there (value + validity + ثبت)`,
    r.numberInputs >= 2 && r.setButtons >= 1,
    `inputs=${r.numberInputs} buttons=${r.setButtons}`
  );
  check(
    `«${r.key}» reads as unconfigured, not as a value`,
    r.text.includes("پیکربندی نشده"),
    r.text.slice(0, 140)
  );
}

const pageText = await evaluate<string>(`document.body.innerText`);
check(
  "the screen states that no default is substituted",
  pageText.includes("هیچ مقدار پیش‌فرضی"),
  "expected the explicit no-default statement"
);
check(
  "reading the whole policy screen issued no non-GET request",
  mutating.length === 0,
  mutating.join(" | ")
);

/* ── 3. and the sizing surface says exactly why it is blocked ────────────── */
await open(`${BASE}/shadow-arbitrage?tab=command`);
const ccText = await evaluate<string>(`document.querySelector(".sa-cc")?.innerText ?? ""`);
check(
  "the Command Center names every missing policy",
  REQUIRED.every((k) => ccText.includes(k)),
  REQUIRED.filter((k) => !ccText.includes(k)).join(", ")
);
check(
  "and states that nothing will be sized until they are set",
  ccText.includes("هیچ حجمی انتخاب نمی‌شود"),
  ccText.slice(0, 200)
);

ws.close();
try {
  process.kill(-proc.pid!);
} catch {
  /* already gone */
}

console.log(`\nResult: ${passed} PASS, ${failed} FAIL\n`);
if (failed) process.exit(1);
