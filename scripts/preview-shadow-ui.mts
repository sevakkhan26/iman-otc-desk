#!/usr/bin/env npx tsx
/**
 * Shadow UI preview — screenshots of the REAL application.
 *
 *   pnpm preview:shadow
 *
 * It boots the production standalone build and photographs `/shadow-arbitrage`
 * through a real browser. There is no reconstructed shell here: the sidebar,
 * the header, the navigation items and the icons are whatever `Shell.tsx`,
 * `DeskPageHeader.tsx` and `sidebarNav.ts` actually render. This file adds no
 * markup and no CSS of its own — if the shell looks wrong in a screenshot, the
 * application looks wrong.
 *
 * Isolation, so a preview can never touch real data or real credentials:
 *   * a throwaway PGlite directory under the OS temp dir — never `.data/`;
 *   * a randomly generated `AUTH_TOKEN_SECRET` that exists only in this
 *     process's environment and is never written to disk;
 *   * a test-only admin session minted with that throwaway secret. No password
 *     is requested, read or stored, and the token is worthless anywhere else.
 *
 * The preview therefore shows real components with empty/fixture data states.
 */
import { execFile, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);
const DIST = process.env.PREVIEW_DIST ?? ".next-preview";
const PORT = Number(process.env.PREVIEW_PORT ?? 3187);
const OUT_DIR = process.env.PREVIEW_OUT ?? path.join(repoRoot, "preview-out");
const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** Shots to take: the production breakpoints this preview is judged at. */
const VIEWPORTS = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light", mobile: false },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark", mobile: false },
  { name: "mobile-light", width: 390, height: 1200, theme: "light", mobile: true },
  { name: "mobile-dark", width: 390, height: 1200, theme: "dark", mobile: true }
] as const;

/**
 * Tabs to photograph. `PREVIEW_TABS` narrows the list; the default is the tab
 * shell's own default so an unchanged run keeps producing the same four files.
 */
const TABS = (process.env.PREVIEW_TABS ?? "overview").split(",").map((t) => t.trim()).filter(Boolean);

const SHOTS = TABS.flatMap((tab) =>
  VIEWPORTS.map((v) => ({
    ...v,
    tab,
    // A single-tab run keeps the historical file names.
    file: TABS.length === 1 && tab === "overview" ? v.name : `${tab}-${v.name}`
  }))
);

/** Test-only identity; it has no password and cannot log in. */
const PREVIEW_ADMIN = "preview-admin";

function log(message: string) {
  console.log(`[preview] ${message}`);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Mint a test-only admin session with the throwaway secret this process just
 * generated. Same format the application verifies: base64url(payload).signature.
 */
function mintAdminSession(secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = b64url(
    JSON.stringify({ u: PREVIEW_ADMIN, r: "admin", iat: now, exp: now + 3600, pv: 0 })
  );
  const signature = b64url(createHmac("sha256", secret).update(payload).digest());
  return `${payload}.${signature}`;
}

/* ── minimal Chrome DevTools Protocol client (no new dependency) ──────────── */

type CdpMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };

class Cdp {
  private socket: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String((event as MessageEvent).data)) as CdpMessage;
      if (message.id === undefined) return;
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
    });
  }

  static async connect(wsUrl: string): Promise<Cdp> {
    const socket = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
    });
    return new Cdp(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, label: string) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function main() {
  const secret = randomBytes(48).toString("hex");
  const dataDir = await mkdtemp(path.join(tmpdir(), "otc-preview-db-"));
  const profileDir = await mkdtemp(path.join(tmpdir(), "otc-preview-chrome-"));
  await mkdir(OUT_DIR, { recursive: true });

  const env = {
    ...process.env,
    NODE_ENV: "production",
    // Never the live local database.
    DATABASE_URL: `pglite:${path.join(dataDir, "pglite")}`,
    AUTH_TOKEN_SECRET: secret,
    /*
     * Test-only admin identity. Only the username is set: that is enough for
     * the session-epoch check to accept the minted token, and deliberately NOT
     * enough to log in, because no password hash exists. Nothing is stored.
     */
    ADMIN_USERNAME: PREVIEW_ADMIN,
    ADMIN_PASSWORD_HASH: "",
    // The collector must not run in a screenshot tool.
    SHADOW_COLLECTOR_ENABLED: "false",
    PORT: String(PORT),
    HOSTNAME: "127.0.0.1"
  };

  // Apply the real migrations to the throwaway database so the page renders
  // its normal empty states rather than a schema error.
  log("migrating the throwaway database");
  await execFileAsync("npx", ["--yes", "tsx", "src/db/migrate.ts"], {
    cwd: repoRoot,
    env,
    maxBuffer: 16 * 1024 * 1024
  });

  /*
   * Optional demo data. `PREVIEW_SEED=1` populates the throwaway database
   * through the production repositories and the real engines; the raw order
   * books it feeds in are invented, so the resulting figures are a
   * demonstration and never observed market data.
   */
  if (process.env.PREVIEW_SEED === "1") {
    log("seeding the throwaway database with demonstration data (not market data)");
    const seeded = await execFileAsync("npx", ["--yes", "tsx", "scripts/preview-seed-shadow.mts"], {
      cwd: repoRoot,
      env,
      maxBuffer: 16 * 1024 * 1024
    });
    process.stdout.write(seeded.stdout);
  }

  const serverEntry = path.join(repoRoot, DIST, "standalone", "server.js");
  if (!existsSync(serverEntry)) {
    log(`building the production bundle into ${DIST} (first run)`);
    await execFileAsync("npx", ["--yes", "next", "build"], {
      cwd: repoRoot,
      env: { ...env, OTC_NEXT_DIST: DIST },
      maxBuffer: 64 * 1024 * 1024
    });
  }

  // The standalone server expects static assets beside it.
  await execFileAsync("bash", [
    "-c",
    `mkdir -p "${DIST}/standalone/${DIST}" && cp -R "${DIST}/static" "${DIST}/standalone/${DIST}/static" 2>/dev/null || true`
  ], { cwd: repoRoot });

  log(`starting the real application on 127.0.0.1:${PORT}`);
  const server = spawn("node", [serverEntry], { cwd: path.join(repoRoot, DIST, "standalone"), env });
  server.stdout.on("data", () => undefined);
  server.stderr.on("data", (d) => process.stderr.write(`[server] ${d}`));

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--remote-debugging-port=9333",
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ]);
  chrome.stderr.on("data", () => undefined);

  try {
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${PORT}/login`)).status < 500,
      60_000,
      "the application to answer"
    );
    log("application is up");

    await waitFor(
      async () => (await fetch("http://127.0.0.1:9333/json/version")).ok,
      30_000,
      "chrome devtools"
    );

    const token = mintAdminSession(secret);

    for (const shot of SHOTS) {
      const target = (await (
        await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" })
      ).json()) as { webSocketDebuggerUrl: string };
      const cdp = await Cdp.connect(target.webSocketDebuggerUrl);

      await cdp.send("Network.enable");
      await cdp.send("Page.enable");
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: shot.width,
        height: shot.height,
        deviceScaleFactor: 2,
        mobile: shot.mobile
      });
      await cdp.send("Emulation.setEmulatedMedia", {
        features: [{ name: "prefers-color-scheme", value: shot.theme }]
      });
      // The test-only admin session and the theme the app persists itself.
      await cdp.send("Network.setCookie", {
        name: "otc-auth",
        value: token,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax"
      });
      await cdp.send("Network.setCookie", {
        name: "otc-theme",
        value: shot.theme,
        domain: "127.0.0.1",
        path: "/"
      });

      await cdp.send("Page.navigate", {
        url: `http://127.0.0.1:${PORT}/shadow-arbitrage?tab=${shot.tab}`
      });
      // Let the client mount, resolve the role and settle its first paint.
      await new Promise((r) => setTimeout(r, 6_000));
      await cdp.send("Runtime.evaluate", {
        expression: `document.documentElement.setAttribute("data-theme", ${JSON.stringify(shot.theme)})`
      });
      await new Promise((r) => setTimeout(r, 1_200));

      const { data } = await cdp.send<{ data: string }>("Page.captureScreenshot", {
        format: "png",
        // PREVIEW_FULLPAGE=1 captures the whole tab, not just the first screen.
        captureBeyondViewport: process.env.PREVIEW_FULLPAGE === "1"
      });
      const file = path.join(OUT_DIR, `${shot.file}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      log(`captured ${shot.file} → ${file}`);
      cdp.close();
    }
    /*
     * Objective layout check: the page itself must never scroll sideways at any
     * supported width. Only an inner table or rail may. Reported, not asserted,
     * so a preview run never silently "passes" a broken layout.
     */
    if (process.env.PREVIEW_MEASURE === "1") {
      for (const tab of TABS) {
        for (const width of [1920, 1440, 1024, 768, 390]) {
          const target = (await (
            await fetch("http://127.0.0.1:9333/json/new?about:blank", { method: "PUT" })
          ).json()) as { webSocketDebuggerUrl: string };
          const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
          await cdp.send("Network.enable");
          await cdp.send("Page.enable");
          await cdp.send("Emulation.setDeviceMetricsOverride", {
            width,
            height: 900,
            deviceScaleFactor: 1,
            mobile: width <= 430
          });
          await cdp.send("Network.setCookie", {
            name: "otc-auth",
            value: mintAdminSession(secret),
            domain: "127.0.0.1",
            path: "/",
            httpOnly: true,
            sameSite: "Lax"
          });
          await cdp.send("Page.navigate", {
            url: `http://127.0.0.1:${PORT}/shadow-arbitrage?tab=${tab}`
          });
          await new Promise((r) => setTimeout(r, 5_000));
          const measured = await cdp.send<{ result: { value: string } }>("Runtime.evaluate", {
            expression: `JSON.stringify({
              client: document.documentElement.clientWidth,
              scroll: document.documentElement.scrollWidth,
              bodyScroll: document.body.scrollWidth,
              cards: document.querySelectorAll(".sa-op-card").length,
              tableVisible: [...document.querySelectorAll(".sa-op-table-wrap")]
                .filter((el) => getComputedStyle(el).display !== "none").length
            })`,
            returnByValue: true
          });
          log(`measure ${tab} @${width}px → ${measured.result.value}`);
          cdp.close();
        }
      }
    }
  } finally {
    server.kill("SIGTERM");
    chrome.kill("SIGTERM");
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
    await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
  }

  log("done — every pixel above came from the real Shell, header and navigation");
}

await main();
