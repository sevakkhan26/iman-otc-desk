/**
 * Shared runtime for the tools that drive the REAL application in a browser.
 *
 * It boots the production standalone build against a throwaway database and
 * opens Chrome over the DevTools Protocol. There is no reconstructed markup
 * anywhere: whatever these tools observe is what `Shell.tsx`, `DeskPageHeader`
 * and the Shadow components actually render.
 *
 * Isolation, so a preview can never touch real data or real credentials:
 *   * a throwaway PGlite directory under the OS temp dir — never `.data/`;
 *   * a randomly generated `AUTH_TOKEN_SECRET` that exists only in this
 *     process's environment and is never written to disk;
 *   * a test-only admin session minted with that throwaway secret. No password
 *     is requested, read or stored, and the token is worthless anywhere else.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

/** Test-only identity; it has no password and cannot log in. */
export const PREVIEW_ADMIN = "preview-admin";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function log(message: string) {
  console.log(`[preview] ${message}`);
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/* ── minimal Chrome DevTools Protocol client (no new dependency) ──────────── */

type CdpMessage = { id?: number; method?: string; params?: unknown; result?: unknown; error?: unknown };

export class Cdp {
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

export type PreviewApp = {
  port: number;
  /** A signed, test-only admin session for the throwaway secret. */
  mintAdminSession(): string;
  /** A fresh browser tab already speaking CDP. */
  newPage(): Promise<Cdp>;
  stop(): Promise<void>;
};

/**
 * Boot the production build plus Chrome.
 *
 * `seed: true` fills the throwaway database through the production
 * repositories and the real engines. The order books it feeds in are invented,
 * so every figure derived from them is a demonstration, never market data.
 */
/**
 * A digest of everything that ends up in the production bundle.
 *
 * Content, not mtimes: a `git checkout` that restores identical bytes should
 * not force a rebuild, and touching a file without changing it should not
 * either. Directories that never reach the bundle are skipped so an unrelated
 * edit does not invalidate a good build.
 */
async function sourceFingerprint(root: string): Promise<string> {
  const roots = ["app", "src", "public"];
  const files = ["version.json", "next.config.ts", "package.json", "tsconfig.json"];
  const hash = createHash("sha256");
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...(await walk(full)));
      else out.push(full);
    }
    return out;
  };
  const all: string[] = [];
  for (const r of roots) all.push(...(await walk(path.join(root, r))));
  for (const f of files) all.push(path.join(root, f));
  for (const f of all.sort()) {
    hash.update(f.slice(root.length));
    hash.update(await readFile(f).catch(() => Buffer.alloc(0)));
  }
  return hash.digest("hex");
}

export async function startPreviewApp(
  options: {
    seed?: boolean;
    port?: number;
    dist?: string;
    debugPort?: number;
    /**
     * Which seeder to run when `seed` is set. Defaults to the screenshot
     * fixture; the Paper drawer acceptance passes its own, because it needs a
     * market that actually crosses and one fill produced by the real engine.
     */
    seedScript?: string;
    /** Run the release reconciliation at startup, as production does. */
    releaseBootstrap?: boolean;
  } = {}
): Promise<PreviewApp> {
  const port = options.port ?? Number(process.env.PREVIEW_PORT ?? 3187);
  const debugPort = options.debugPort ?? Number(process.env.PREVIEW_DEBUG_PORT ?? 9333);
  const dist = options.dist ?? process.env.PREVIEW_DIST ?? ".next-preview";

  const secret = randomBytes(48).toString("hex");
  const dataDir = await mkdtemp(path.join(tmpdir(), "otc-preview-db-"));
  const profileDir = await mkdtemp(path.join(tmpdir(), "otc-preview-chrome-"));

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
    /*
     * The release reconciliation is off by default here: these harnesses seed
     * their own sessions, and a bootstrap session would displace the one the
     * fixture just created. The acceptance test that exercises the real startup
     * path turns it back on explicitly.
     */
    SHADOW_RELEASE_BOOTSTRAP: options.releaseBootstrap ? "true" : "false",
    PORT: String(port),
    HOSTNAME: "127.0.0.1"
  };

  log("migrating the throwaway database");
  await execFileAsync("npx", ["--yes", "tsx", "src/db/migrate.ts"], {
    cwd: repoRoot,
    env,
    maxBuffer: 16 * 1024 * 1024
  });

  if (options.seed) {
    const seedScript = options.seedScript ?? "scripts/preview-seed-shadow.mts";
    log(`seeding the throwaway database with ${seedScript} (demonstration data, not market data)`);
    const seeded = await execFileAsync("npx", ["--yes", "tsx", seedScript], {
      cwd: repoRoot,
      env,
      maxBuffer: 16 * 1024 * 1024
    });
    process.stdout.write(seeded.stdout);
  }

  const serverEntry = path.join(repoRoot, dist, "standalone", "server.js");
  /*
   * Rebuild when the build is missing OR stale.
   *
   * "Missing only" looks cheap and is the reason this tool once served a
   * months-old UI: the bundle existed, so it was reused, and the font and
   * screenshot checks measured a build that predated the redesign. The habit
   * that grew around it — deleting the whole dist before every run — cost a
   * full four-minute rebuild every time instead.
   *
   * A fingerprint of the sources that actually reach the bundle settles it:
   * unchanged sources reuse the build in seconds, changed sources rebuild
   * exactly once. Deleting the directory by hand is never necessary again.
   */
  const stampFile = path.join(repoRoot, dist, ".source-stamp");
  const stamp = await sourceFingerprint(repoRoot);
  const cached = existsSync(serverEntry) && existsSync(stampFile)
    ? await readFile(stampFile, "utf8").catch(() => "")
    : "";
  if (cached !== stamp) {
    log(
      existsSync(serverEntry)
        ? `sources changed since the last build — rebuilding into ${dist}`
        : `building the production bundle into ${dist} (first run)`
    );
    await execFileAsync("npx", ["--yes", "next", "build"], {
      cwd: repoRoot,
      env: { ...env, OTC_NEXT_DIST: dist },
      maxBuffer: 64 * 1024 * 1024
    });
    await writeFile(stampFile, stamp, "utf8");
  } else {
    log(`reusing the existing ${dist} build — sources unchanged`);
  }

  /*
   * The standalone server expects the build's static chunks AND the public
   * directory beside it — Next does not copy `public/` into the standalone
   * output. Without it the self-hosted IRANYekan woff2 files 404 and the
   * browser silently falls back to a system face, which would make every
   * screenshot and every typography check meaningless.
   */
  await execFileAsync(
    "bash",
    [
      "-c",
      `mkdir -p "${dist}/standalone/${dist}" && cp -R "${dist}/static" "${dist}/standalone/${dist}/static" 2>/dev/null; ` +
        `cp -R public "${dist}/standalone/public" 2>/dev/null; true`
    ],
    { cwd: repoRoot }
  );

  log(`starting the real application on 127.0.0.1:${port}`);
  const server: ChildProcess = spawn("node", [serverEntry], {
    cwd: path.join(repoRoot, dist, "standalone"),
    env
  });
  server.stdout?.on("data", () => undefined);
  server.stderr?.on("data", (d) => process.stderr.write(`[server] ${d}`));

  const chrome = spawn(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    "about:blank"
  ]);
  chrome.stderr.on("data", () => undefined);

  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${port}/login`)).status < 500,
    60_000,
    "the application to answer"
  );
  log("application is up");
  await waitFor(
    async () => (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok,
    30_000,
    "chrome devtools"
  );

  return {
    port,
    mintAdminSession() {
      const now = Math.floor(Date.now() / 1000);
      const payload = b64url(
        JSON.stringify({ u: PREVIEW_ADMIN, r: "admin", iat: now, exp: now + 3600, pv: 0 })
      );
      const signature = b64url(createHmac("sha256", secret).update(payload).digest());
      return `${payload}.${signature}`;
    },
    async newPage() {
      const target = (await (
        await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: "PUT" })
      ).json()) as { webSocketDebuggerUrl: string };
      return Cdp.connect(target.webSocketDebuggerUrl);
    },
    async stop() {
      server.kill("SIGTERM");
      chrome.kill("SIGTERM");
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

/** Attach the test-only session and the theme a page should render in. */
export async function preparePage(
  cdp: Cdp,
  app: PreviewApp,
  shot: { width: number; height: number; theme: string; mobile: boolean }
) {
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
  await cdp.send("Network.setCookie", {
    name: "otc-auth",
    value: app.mintAdminSession(),
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
}
