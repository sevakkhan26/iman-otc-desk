/**
 * Viewer password override + session epoch (invalidates old viewer cookies).
 *
 * Admin password stays env-only. Viewer:
 *   1. Optional override hash in VIEWER_AUTH_DATA_FILE (or under price-alerts dir / .data)
 *   2. Else VIEWER_PASSWORD_HASH from env (bootstrap)
 *
 * Docker: prefer same volume as price alerts so overrides survive recreate.
 * Node-only (fs) — do not import from client components.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashPassword, parsePasswordHash } from "@/lib/passwordHash";

export const VIEWER_PASSWORD_MIN_LEN = 10;
export const VIEWER_PASSWORD_MAX_LEN = 128;

type ViewerAuthFile = {
  passwordHash: string;
  sessionEpoch: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

let mem: ViewerAuthFile | null | undefined;
let writeChain: Promise<void> = Promise.resolve();

function stripEnvQuotes(value: string): string {
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith("\"") && value.endsWith("\""))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function readEnvPasswordHash(): string | null {
  const raw = process.env.VIEWER_PASSWORD_HASH?.trim();
  if (!raw) return null;
  const value = stripEnvQuotes(raw);
  if (!value.startsWith("pbkdf2$") || !parsePasswordHash(value)) return null;
  return value;
}

/** Resolve durable path for viewer override (Docker volume-friendly). */
export function resolveViewerAuthPath(): string {
  const explicit = process.env.VIEWER_AUTH_DATA_FILE?.trim();
  if (explicit) return explicit;

  const alertsDir = process.env.PRICE_ALERTS_DATA_DIR?.trim();
  if (alertsDir) return path.join(alertsDir, "viewer-auth.json");

  return path.join(process.cwd(), ".data", "viewer-auth.json");
}

function emptyOverride(): null {
  return null;
}

async function readOverrideFile(): Promise<ViewerAuthFile | null> {
  if (mem !== undefined) return mem;

  const filePath = resolveViewerAuthPath();
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ViewerAuthFile>;
    if (
      typeof parsed.passwordHash === "string" &&
      parsePasswordHash(parsed.passwordHash) &&
      typeof parsed.sessionEpoch === "number" &&
      Number.isFinite(parsed.sessionEpoch) &&
      parsed.sessionEpoch >= 0
    ) {
      mem = {
        passwordHash: parsed.passwordHash,
        sessionEpoch: Math.floor(parsed.sessionEpoch),
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
        updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null
      };
      return mem;
    }
  } catch {
    /* missing or invalid — use env bootstrap */
  }
  mem = emptyOverride();
  return mem;
}

async function persistOverride(next: ViewerAuthFile): Promise<void> {
  const filePath = resolveViewerAuthPath();
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(next, null, 2);
  await writeFile(tmp, body, "utf8");
  await rename(tmp, filePath);
  mem = next;
}

/** Effective hash for viewer login (file override → env). */
export async function getViewerPasswordHash(): Promise<string | null> {
  const override = await readOverrideFile();
  if (override?.passwordHash) return override.passwordHash;
  return readEnvPasswordHash();
}

/**
 * Session epoch embedded in viewer cookies.
 * Env-only bootstrap uses 0; each panel password change increments.
 */
export async function getViewerSessionEpoch(): Promise<number> {
  const override = await readOverrideFile();
  return override?.sessionEpoch ?? 0;
}

export type ViewerAuthPublicMeta = {
  source: "override" | "env" | "none";
  sessionEpoch: number;
  updatedAt: string | null;
  updatedBy: string | null;
  passwordConfigured: boolean;
};

export async function getViewerAuthPublicMeta(): Promise<ViewerAuthPublicMeta> {
  const override = await readOverrideFile();
  if (override) {
    return {
      source: "override",
      sessionEpoch: override.sessionEpoch,
      updatedAt: override.updatedAt,
      updatedBy: override.updatedBy,
      passwordConfigured: true
    };
  }
  const envHash = readEnvPasswordHash();
  return {
    source: envHash ? "env" : "none",
    sessionEpoch: 0,
    updatedAt: null,
    updatedBy: null,
    passwordConfigured: Boolean(envHash)
  };
}

export function validateViewerPasswordPlain(password: string): string | null {
  if (typeof password !== "string" || !password) {
    return "رمز عبور را وارد کنید";
  }
  if (password.length < VIEWER_PASSWORD_MIN_LEN) {
    return `رمز عبور باید حداقل ${VIEWER_PASSWORD_MIN_LEN} کاراکتر باشد`;
  }
  if (password.length > VIEWER_PASSWORD_MAX_LEN) {
    return `رمز عبور حداکثر ${VIEWER_PASSWORD_MAX_LEN} کاراکتر است`;
  }
  if (/\s/.test(password)) {
    return "رمز عبور نباید فاصله داشته باشد";
  }
  return null;
}

/**
 * Set viewer password from admin panel. Bumps sessionEpoch so old viewer cookies fail.
 */
export async function setViewerPasswordFromAdmin(
  newPassword: string,
  updatedBy: string
): Promise<{ ok: true; sessionEpoch: number } | { ok: false; message: string }> {
  const validationError = validateViewerPasswordPlain(newPassword);
  if (validationError) return { ok: false, message: validationError };

  const passwordHash = hashPassword(newPassword);
  const prev = await readOverrideFile();
  const sessionEpoch = (prev?.sessionEpoch ?? 0) + 1;
  const next: ViewerAuthFile = {
    passwordHash,
    sessionEpoch,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || "admin"
  };

  const run = writeChain.then(() => persistOverride(next));
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  try {
    await run;
    return { ok: true, sessionEpoch };
  } catch {
    return { ok: false, message: "ذخیره رمز viewer ناموفق بود" };
  }
}

/** Test helper: drop in-memory cache (does not delete file). */
export function clearViewerAuthMemCache(): void {
  mem = undefined;
}
