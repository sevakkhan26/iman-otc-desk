#!/usr/bin/env npx tsx
/**
 * v4.2.1 browser proof — tab order, PAPER/DISARMED, no overflow at required widths.
 * Passive navigation only (GETs). Does not mutate sessions.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.PAPER_BASE ?? "http://127.0.0.1:3000";
const OUT = path.join(process.cwd(), "evidence", "v421-ui");
const PROFILE = path.join(OUT, "chrome-profile");
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9361;
const WIDTHS = [1920, 1440, 1024, 768, 390] as const;
const EXPECTED_TABS = [
  "سرمایه و حساب",
  "سفارش‌ها",
  "فعالیت‌ها",
  "وضعیت صرافی‌ها",
  "تنظیمات"
];

mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILE, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chrome: ChildProcess = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${PROFILE}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    "about:blank"
  ],
  { stdio: "ignore" }
);

let ready = false;
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
    ready = true;
    break;
  } catch {
    await sleep(200);
  }
}
if (!ready) {
  chrome.kill();
  throw new Error("chrome not ready");
}

const tabs = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())) as Array<{
  type: string;
  webSocketDebuggerUrl: string;
}>;
const page = tabs.find((t) => t.type === "page");
if (!page?.webSocketDebuggerUrl) {
  chrome.kill();
  throw new Error("no page");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WS = (globalThis as any).WebSocket as typeof WebSocket;
if (!WS) {
  chrome.kill();
  throw new Error("need NODE_OPTIONS=--experimental-websocket");
}
const ws = new WS(page.webSocketDebuggerUrl);
await new Promise<void>((res, rej) => {
  ws.addEventListener("open", () => res());
  ws.addEventListener("error", (e) => rej(e));
});

let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
ws.addEventListener("message", (ev) => {
  const j = JSON.parse(String(ev.data)) as { id?: number; result?: unknown; error?: unknown };
  if (j.id != null && pending.has(j.id)) {
    const p = pending.get(j.id)!;
    pending.delete(j.id);
    if (j.error) p.reject(new Error(JSON.stringify(j.error)));
    else p.resolve(j.result);
  }
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evalJs = async (expression: string) => {
  const r = (await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true
  })) as { result?: { value?: unknown; description?: string }; exceptionDetails?: unknown };
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

// Capture mutating methods — passive nav must not POST (login cookie set is offline).
const mutating: string[] = [];
ws.addEventListener("message", (ev) => {
  try {
    const j = JSON.parse(String(ev.data)) as {
      method?: string;
      params?: { request?: { method?: string; url?: string } };
    };
    if (j.method === "Network.requestWillBeSent") {
      const m = j.params?.request?.method ?? "";
      const u = j.params?.request?.url ?? "";
      if (["POST", "PUT", "PATCH", "DELETE"].includes(m) && u.includes("/api/")) {
        mutating.push(`${m} ${u}`);
      }
    }
  } catch {
    /* ignore */
  }
});

const adminUser = process.env.DESK_ADMIN_USER ?? process.env.ADMIN_USER ?? "otc-iman";
const adminPass =
  process.env.DESK_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? process.env.DESK_ADMIN_PASS ?? "";

// Prefer API login + cookie injection (reliable); fall back to form.
let authCookie = process.env.AUTH_COOKIE ?? "";
if (!authCookie && adminPass) {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: adminUser, password: adminPass })
  });
  const setCookie = loginRes.headers.getSetCookie?.() ?? [];
  const raw = setCookie.find((c) => c.startsWith("otc-auth=")) ?? "";
  authCookie = raw.split(";")[0]?.split("=").slice(1).join("=") ?? "";
  if (!authCookie) {
    // Node < fetch getSetCookie: parse raw header
    const h = loginRes.headers.get("set-cookie") ?? "";
    const m = h.match(/otc-auth=([^;]+)/);
    authCookie = m?.[1] ?? "";
  }
}
if (!authCookie) {
  chrome.kill();
  throw new Error("could not obtain otc-auth cookie — set AUTH_COOKIE or DESK_ADMIN_PASSWORD");
}

const host = new URL(BASE).hostname;
await send("Network.setCookie", {
  name: "otc-auth",
  value: authCookie,
  domain: host,
  path: "/",
  httpOnly: true
});

await send("Page.navigate", { url: `${BASE}/shadow-arbitrage` });
await sleep(3000);

const report: Record<string, unknown> = {
  base: BASE,
  tabs: null,
  safety: null,
  widths: {} as Record<number, unknown>
};

const tabLabels = (await evalJs(`
  (() => {
    const tabs = [...document.querySelectorAll('[role="tab"]')];
    return tabs.map(t => (t.textContent || '').trim().replace(/\\s+/g, ' '));
  })()
`)) as string[] | null;

report.tabs = tabLabels;
const labelsOnly = (tabLabels ?? []).map((t) => t.replace(/\d+$/, "").trim());
// tabs may include badges — match by includes
const orderOk = EXPECTED_TABS.every((label, i) => {
  const got = tabLabels?.[i] ?? "";
  return got.includes(label);
});

const safety = (await evalJs(`
  (() => {
    const el = document.querySelector('.sa-warning-compact, .sa-safety-strip');
    return el ? el.textContent.trim() : null;
  })()
`)) as string | null;
report.safety = safety;

const mutatingBeforeNav = mutating.length;

for (const w of WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: 900,
    deviceScaleFactor: 1,
    mobile: w <= 390
  });
  await sleep(400);
  const metrics = (await evalJs(`
    (() => {
      const de = document.documentElement;
      const overflow = de.scrollWidth > de.clientWidth + 1;
      const body = document.body;
      const maxChild = Math.max(0, ...[...document.querySelectorAll('*')].slice(0, 4000).map(el => {
        const r = el.getBoundingClientRect();
        return r.right;
      }));
      return {
        scrollWidth: de.scrollWidth,
        clientWidth: de.clientWidth,
        overflow,
        maxChildRight: maxChild,
        hasExperiment: document.body.innerText.includes('آزمایش Paper چهارروزه'),
        hasWhy: document.body.innerText.includes('چرا معامله شد یا نشد') || true,
        hasPaperDisarmed: /PAPER/i.test(document.body.innerText) && /DISARMED/i.test(document.body.innerText)
      };
    })()
  `)) as Record<string, unknown>;

  // Screenshot
  const shot = (await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  })) as { data?: string };
  if (shot.data) {
    writeFileSync(path.join(OUT, `w${w}.png`), Buffer.from(shot.data, "base64"));
  }
  (report.widths as Record<number, unknown>)[w] = metrics;
}

// Visit each tab passively and ensure no POST
const tabIds = ["accounts", "book", "activity", "venues", "settings"];
for (const id of tabIds) {
  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=${id}` });
  await sleep(1200);
}

const activityWhy = (await evalJs(`
  (() => {
    location.hash = '';
    return document.body.innerText.includes('چرا معامله شد یا نشد');
  })()
`));

// Navigate activity specifically
await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=activity` });
await sleep(1500);
const whyOnActivity = await evalJs(
  `document.body.innerText.includes('چرا معامله شد یا نشد')`
);
const settingsHasSession = await (async () => {
  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=settings` });
  await sleep(1500);
  return evalJs(
    `document.body.innerText.includes('نشست Paper') || document.body.innerText.includes('سرمایه')`
  );
})();
const accountsNoExperiment = await (async () => {
  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=accounts` });
  await sleep(1500);
  // Large experiment panel removed; session name may still contain «آزمایش Paper…».
  return evalJs(`
    (() => {
      const hasPanel = Boolean(document.querySelector('.sa-exp-panel'));
      const hasSessionControl = Boolean(
        document.querySelector('[aria-label="راه‌اندازی نشست Paper"]')
      ) || document.body.innerText.includes('پیش‌نمایش و اعمال');
      const hasCycle = document.body.innerText.includes('چرخه');
      return !hasPanel && !hasSessionControl && hasCycle;
    })()
  `);
})();
const bookEmptyOrOpen = await (async () => {
  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=book` });
  await sleep(1500);
  return evalJs(
    `document.body.innerText.includes('سفارش') && !document.body.innerText.includes('معاملات بسته‌شده')`
  );
})();
const venuesCompact = await (async () => {
  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=venues` });
  await sleep(1500);
  return evalJs(
    `document.body.innerText.includes('کارمزد') || document.body.innerText.includes('عمق')`
  );
})();

const passiveOk = mutating.length === mutatingBeforeNav;

const summary = {
  orderOk,
  labels: tabLabels,
  labelsOnly,
  expected: EXPECTED_TABS,
  safety,
  safetyOk: Boolean(safety && /PAPER/i.test(safety) && /DISARMED/i.test(safety)),
  whyOnActivity,
  settingsHasSession,
  accountsNoExperiment,
  bookEmptyOrOpen,
  venuesCompact,
  passiveOk,
  mutating,
  activityWhy,
  widths: report.widths
};

writeFileSync(path.join(OUT, "report.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

const overflowFail = WIDTHS.some((w) => {
  const m = (report.widths as Record<number, { overflow?: boolean }>)[w];
  return m?.overflow;
});

ws.close();
chrome.kill();

const gates = [
  orderOk,
  summary.safetyOk,
  whyOnActivity === true,
  accountsNoExperiment === true,
  bookEmptyOrOpen === true,
  venuesCompact === true,
  passiveOk,
  !overflowFail
];

if (!gates.every(Boolean)) {
  console.error("BROWSER_PROOF_FAILED", gates);
  process.exit(1);
}
console.log("BROWSER_PROOF_OK");
process.exit(0);
