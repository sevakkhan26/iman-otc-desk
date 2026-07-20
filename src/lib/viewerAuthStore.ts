/**
 * Viewer password override + session epoch — PostgreSQL app_settings.
 * Fail closed when DATABASE_URL is unavailable (override path).
 * Env VIEWER_PASSWORD_HASH remains bootstrap when no override row exists.
 */
import { eq } from "drizzle-orm";
import { DatabaseUnavailableError, getDatabaseUrl, getDb } from "@/db/client";
import { appSettings } from "@/db/schema";
import { hashPassword, parsePasswordHash } from "@/lib/passwordHash";

export const VIEWER_PASSWORD_MIN_LEN = 10;
export const VIEWER_PASSWORD_MAX_LEN = 128;

const VIEWER_AUTH_KEY = "viewer_auth_override";

type ViewerAuthFile = {
  passwordHash: string;
  sessionEpoch: number;
  updatedAt: string | null;
  updatedBy: string | null;
};

let mem: ViewerAuthFile | null | undefined;

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

function parseOverride(value: unknown): ViewerAuthFile | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<ViewerAuthFile>;
  if (
    typeof parsed.passwordHash === "string" &&
    parsePasswordHash(parsed.passwordHash) &&
    typeof parsed.sessionEpoch === "number" &&
    Number.isFinite(parsed.sessionEpoch) &&
    parsed.sessionEpoch >= 0
  ) {
    return {
      passwordHash: parsed.passwordHash,
      sessionEpoch: Math.floor(parsed.sessionEpoch),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null
    };
  }
  return null;
}

async function readOverride(): Promise<ViewerAuthFile | null> {
  if (mem !== undefined) return mem;
  try {
    getDatabaseUrl();
    const db = getDb();
    const rows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, VIEWER_AUTH_KEY))
      .limit(1);
    const parsed = rows[0] ? parseOverride(rows[0].value) : null;
    mem = parsed;
    return mem;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) throw error;
    throw new DatabaseUnavailableError(
      error instanceof Error ? error.message : "PostgreSQL viewer-auth read failed"
    );
  }
}

async function persistOverride(next: ViewerAuthFile): Promise<void> {
  getDatabaseUrl();
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(appSettings)
    .values({
      key: VIEWER_AUTH_KEY,
      value: next as unknown as Record<string, unknown>,
      updatedBy: next.updatedBy,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: {
        value: next as unknown as Record<string, unknown>,
        updatedBy: next.updatedBy,
        updatedAt: now
      }
    });
  mem = next;
}

/** Effective hash for viewer login (PG override → env). */
export async function getViewerPasswordHash(): Promise<string | null> {
  const override = await readOverride();
  if (override?.passwordHash) return override.passwordHash;
  return readEnvPasswordHash();
}

export async function getViewerSessionEpoch(): Promise<number> {
  const override = await readOverride();
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
  const override = await readOverride();
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

export async function setViewerPasswordFromAdmin(
  newPassword: string,
  updatedBy: string
): Promise<{ ok: true; sessionEpoch: number } | { ok: false; message: string }> {
  const validationError = validateViewerPasswordPlain(newPassword);
  if (validationError) return { ok: false, message: validationError };

  const passwordHash = hashPassword(newPassword);
  const prev = await readOverride();
  const sessionEpoch = (prev?.sessionEpoch ?? 0) + 1;
  const next: ViewerAuthFile = {
    passwordHash,
    sessionEpoch,
    updatedAt: new Date().toISOString(),
    updatedBy: updatedBy || "admin"
  };

  try {
    await persistOverride(next);
    return { ok: true, sessionEpoch };
  } catch {
    return { ok: false, message: "ذخیره رمز viewer ناموفق بود" };
  }
}

/** Importer / test: write override payload directly */
export async function __importViewerAuthOverride(payload: ViewerAuthFile): Promise<void> {
  await persistOverride(payload);
}

export function clearViewerAuthMemCache(): void {
  mem = undefined;
}
