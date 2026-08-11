#!/usr/bin/env npx tsx
/**
 * v4.2.2 browser proof — venues layout + Persian why-decision at required widths.
 */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.PAPER_BASE ?? "http://127.0.0.1:3210";
const OUT = path.join(process.cwd(), "evidence", "v422-ui");
const PROFILE = path.join(OUT, "chrome-profile");
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9363;
const WIDTHS = [1920, 1440, 1024, 768, 390] as const;

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
  })) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result?.value;
};

await send("Page.enable");
await send("Runtime.enable");
await send("Network.enable");

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

const adminUser = process.env.DESK_ADMIN_USER ?? "otc-iman";
const adminPass = process.env.DESK_ADMIN_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "";
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
    const h = loginRes.headers.get("set-cookie") ?? "";
    const m = h.match(/otc-auth=([^;]+)/);
    authCookie = m?.[1] ?? "";
  }
}
if (!authCookie) {
  chrome.kill();
  throw new Error("no auth cookie");
}

const host = new URL(BASE).hostname;
await send("Network.setCookie", {
  name: "otc-auth",
  value: authCookie,
  domain: host,
  path: "/",
  httpOnly: true
});

const mutatingBefore = mutating.length;
const report: Record<string, unknown> = { widths: {} as Record<number, unknown> };

// Venues tab
await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=venues` });
await sleep(2500);

const venuesCheck = (await evalJs(`
  (() => {
    const cards = [...document.querySelectorAll('.sa-venue-card-compact, .sa-venue-card')];
    const rects = cards.map(el => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, width: r.width, height: r.height };
    });
    // overlap detection among cards
    let overlap = false;
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const oy = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
        if (ox > 4 && oy > 4) overlap = true;
      }
    }
    const minW = rects.length ? Math.min(...rects.map(r => r.width)) : 0;
    const de = document.documentElement;
    return {
      cardCount: cards.length,
      minCardWidth: minW,
      overlap,
      overflow: de.scrollWidth > de.clientWidth + 1,
      scrollWidth: de.scrollWidth,
      clientWidth: de.clientWidth,
      bodyHasDepth: document.body.innerText.includes('عمق'),
      bodyHasFee: document.body.innerText.includes('کارمزد')
    };
  })()
`)) as Record<string, unknown>;
report.venues = venuesCheck;

// Activity tab
await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=activity` });
await sleep(2500);
const activityCheck = (await evalJs(`
  (() => {
    const text = document.body.innerText;
    return {
      hasWhyTitle: text.includes('چرا معامله شد یا نشد'),
      hasDone: text.includes('معامله انجام شد چون'),
      hasNotDone: text.includes('معامله انجام نشد چون'),
      hasUnavailable: /Unavailable/i.test(text),
      hasNull: /\\bnull\\b/.test(text) || /\\bundefined\\b/.test(text),
      hasHeadline: Boolean(document.querySelector('.sa-why-headline')),
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    };
  })()
`)) as Record<string, unknown>;
report.activity = activityCheck;

for (const w of WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: 900,
    deviceScaleFactor: 1,
    mobile: w <= 390
  });
  await sleep(350);
  // venues at width
  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=venues` });
  await sleep(900);
  const v = (await evalJs(`
    (() => {
      const de = document.documentElement;
      const cards = [...document.querySelectorAll('.sa-venue-card-compact, .sa-venue-card')];
      const minW = cards.length ? Math.min(...cards.map(el => el.getBoundingClientRect().width)) : 0;
      let overlap = false;
      const rects = cards.map(el => el.getBoundingClientRect());
      for (let i=0;i<rects.length;i++) for (let j=i+1;j<rects.length;j++) {
        const a=rects[i], b=rects[j];
        if (Math.min(a.right,b.right)-Math.max(a.left,b.left)>4 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>4) overlap=true;
      }
      return { overflow: de.scrollWidth > de.clientWidth + 1, minW, cards: cards.length, overlap };
    })()
  `)) as Record<string, unknown>;
  const shotV = (await send("Page.captureScreenshot", { format: "png", fromSurface: true })) as {
    data?: string;
  };
  if (shotV.data) {
    writeFileSync(path.join(OUT, `venues-w${w}.png`), Buffer.from(shotV.data, "base64"));
  }

  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=activity` });
  await sleep(900);
  const a = (await evalJs(`
    (() => {
      const de = document.documentElement;
      const text = document.body.innerText;
      return {
        overflow: de.scrollWidth > de.clientWidth + 1,
        hasHeadline: Boolean(document.querySelector('.sa-why-headline')) || text.includes('معامله انجام'),
        hasUnavailable: /Unavailable/i.test(text)
      };
    })()
  `)) as Record<string, unknown>;
  const shotA = (await send("Page.captureScreenshot", { format: "png", fromSurface: true })) as {
    data?: string;
  };
  if (shotA.data) {
    writeFileSync(path.join(OUT, `activity-w${w}.png`), Buffer.from(shotA.data, "base64"));
  }
  (report.widths as Record<number, unknown>)[w] = { venues: v, activity: a };
}

const passiveOk = mutating.length === mutatingBefore;
const widthOk = WIDTHS.every((w) => {
  const m = (report.widths as Record<number, { venues: { overflow?: boolean; overlap?: boolean; minW?: number }; activity: { overflow?: boolean; hasUnavailable?: boolean } }>)[w];
  if (!m) return false;
  if (m.venues.overflow || m.activity.overflow) return false;
  if (m.venues.overlap) return false;
  if (m.activity.hasUnavailable) return false;
  // desktop cards should be reasonably wide when multiple exist
  if (w >= 1024 && (m.venues.cards ?? 0) > 1 && (m.venues.minW ?? 0) < 180) return false;
  return true;
});

const summary = {
  venuesCheck,
  activityCheck,
  passiveOk,
  mutating,
  widthOk,
  widths: report.widths
};
writeFileSync(path.join(OUT, "report.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));

ws.close();
chrome.kill();

const gates = [
  passiveOk,
  widthOk,
  activityCheck.hasWhyTitle === true,
  activityCheck.hasUnavailable === false,
  venuesCheck.overflow === false,
  venuesCheck.overlap === false
];
if (!gates.every(Boolean)) {
  console.error("BROWSER_PROOF_FAILED", gates);
  process.exit(1);
}
console.log("BROWSER_PROOF_OK");
process.exit(0);
