#!/usr/bin/env npx tsx
/** v4.2.4 browser: visible book volume labels, no overflow, passive. */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BASE = process.env.PAPER_BASE ?? "http://127.0.0.1:3210";
const OUT = path.join(process.cwd(), "evidence", "v424-visible-volume");
const PROFILE = path.join(OUT, "chrome-profile");
const CHROME =
  process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9366;
const WIDTHS = [1920, 1440, 1024, 768, 390] as const;
mkdirSync(OUT, { recursive: true });
mkdirSync(PROFILE, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
  CHROME,
  [`--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run", "about:blank"],
  { stdio: "ignore" }
);
for (let i = 0; i < 40; i++) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/json/version`);
    break;
  } catch {
    await sleep(200);
  }
}
const tabs = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())) as Array<{
  type: string;
  webSocketDebuggerUrl: string;
}>;
const page = tabs.find((t) => t.type === "page");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WS = (globalThis as any).WebSocket as typeof WebSocket;
const ws = new WS(page!.webSocketDebuggerUrl!);
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

const adminUser = process.env.DESK_ADMIN_USER ?? "otc-iman";
const adminPass = process.env.DESK_ADMIN_PASSWORD ?? "";
let authCookie = process.env.AUTH_COOKIE ?? "";
if (!authCookie && adminPass) {
  const loginRes = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: adminUser, password: adminPass })
  });
  for (const c of loginRes.headers.getSetCookie?.() ?? []) {
    if (c.startsWith("otc-auth=")) authCookie = c.split(";")[0].slice("otc-auth=".length);
  }
  if (!authCookie) {
    const h = loginRes.headers.get("set-cookie") ?? "";
    const m = h.match(/otc-auth=([^;]+)/);
    authCookie = m?.[1] ?? "";
  }
}
if (!authCookie) {
  chrome.kill();
  throw new Error("no cookie");
}

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
await send("Network.setCookie", {
  name: "otc-auth",
  value: authCookie,
  domain: "127.0.0.1",
  path: "/",
  httpOnly: true
});

const before = mutating.length;
const report: Record<number, unknown> = {};

// Capture API totals for one card comparison
const paperRes = await fetch(`${BASE}/api/shadow-arbitrage/paper`, {
  headers: { cookie: `otc-auth=${authCookie}` }
});
const paper = (await paperRes.json()) as {
  venueDepthCards?: Array<{
    sourceId: string;
    buy?: { rawDepthUsdt?: number | null; rawDepthToman?: number | null };
    sell?: { rawDepthUsdt?: number | null; rawDepthToman?: number | null };
  }>;
};
const apiCard = paper.venueDepthCards?.[0] ?? null;

for (const w of WIDTHS) {
  await send("Emulation.setDeviceMetricsOverride", {
    width: w,
    height: 900,
    deviceScaleFactor: 1,
    mobile: w <= 390
  });
  await send("Page.navigate", { url: `${BASE}/shadow-arbitrage?tab=venues` });
  await sleep(1600);
  const m = await evalJs(`(() => {
    const t = document.body.innerText;
    const de = document.documentElement;
    return {
      overflow: de.scrollWidth > de.clientWidth + 1,
      hasLabel: t.includes("حجم قابل‌مشاهده در دفتر سفارش دریافتی"),
      hasBid: t.includes("حجم خرید (Bid)"),
      hasAsk: t.includes("حجم فروش (Ask)"),
      hasAge: t.includes("سن اسنپ‌شات") || t.includes("ثانیه"),
      cards: document.querySelectorAll(".sa-venue-card").length
    };
  })()`);
  const shot = (await send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true
  })) as { data?: string };
  if (shot.data) {
    writeFileSync(path.join(OUT, `venues-w${w}.png`), Buffer.from(shot.data, "base64"));
  }
  report[w] = m;
}

const passiveOk = mutating.length === before;
const ok = WIDTHS.every((w) => {
  const m = report[w] as {
    overflow?: boolean;
    hasLabel?: boolean;
    hasBid?: boolean;
    hasAsk?: boolean;
  };
  return m && !m.overflow && m.hasLabel && m.hasBid && m.hasAsk;
});

const summary = {
  report,
  passiveOk,
  ok,
  apiSample: apiCard
    ? {
        sourceId: apiCard.sourceId,
        askUsdt: apiCard.buy?.rawDepthUsdt,
        bidUsdt: apiCard.sell?.rawDepthUsdt
      }
    : null
};
writeFileSync(path.join(OUT, "browser-report.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
ws.close();
chrome.kill();
if (!ok || !passiveOk) process.exit(1);
console.log("BROWSER_PROOF_OK");
