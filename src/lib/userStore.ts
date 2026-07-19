/**
 * Managed desk users (admin-created) with password hashes + per-user session epoch.
 *
 * Bootstrap accounts stay in env:
 *   - ADMIN_USERNAME / ADMIN_PASSWORD_HASH (not editable from panel)
 *   - VIEWER_USERNAME / VIEWER_PASSWORD_HASH (+ optional viewer-auth override file)
 *
 * Durable path: same volume family as viewer-auth / price-alerts.
 * Node-only (fs) — do not import from client components.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeskRole } from "@/lib/auth";
import { hashPassword, parsePasswordHash } from "@/lib/passwordHash";
import {
  getViewerAuthPublicMeta,
  setViewerPasswordFromAdmin,
  validateViewerPasswordPlain
} from "@/lib/viewerAuthStore";

export const USERNAME_MIN_LEN = 3;
export const USERNAME_MAX_LEN = 32;
export const MAX_MANAGED_USERS = 50;

export const ENV_ADMIN_ID = "env:admin";
export const ENV_VIEWER_ID = "env:viewer";

type ManagedUserRecord = {
  id: string;
  username: string;
  /** Lowercase username for unique lookup */
  usernameKey: string;
  passwordHash: string;
  role: DeskRole;
  sessionEpoch: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

type UsersFile = {
  version: 1;
  users: ManagedUserRecord[];
};

export type UserAccountPublic = {
  id: string;
  username: string;
  role: DeskRole;
  source: "env" | "managed";
  enabled: boolean;
  canDelete: boolean;
  canResetPassword: boolean;
  passwordConfigured: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type CreateUserInput = {
  username: string;
  password: string;
  confirmPassword: string;
  role?: DeskRole;
};

export type ResetPasswordInput = {
  newPassword: string;
  confirmPassword: string;
};

let mem: UsersFile | null | undefined;
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

function readEnvUsername(envValue: string | undefined): string | null {
  const value = envValue ? stripEnvQuotes(envValue.trim()) : "";
  return value || null;
}

function readEnvPasswordHash(envValue: string | undefined): string | null {
  const value = envValue ? stripEnvQuotes(envValue.trim()) : "";
  if (!value || !value.startsWith("pbkdf2$") || !parsePasswordHash(value)) return null;
  return value;
}

export function resolveUsersDataPath(): string {
  const explicit = process.env.DESK_USERS_DATA_FILE?.trim();
  if (explicit) return explicit;

  const viewerAuth = process.env.VIEWER_AUTH_DATA_FILE?.trim();
  if (viewerAuth) {
    return path.join(path.dirname(viewerAuth), "desk-users.json");
  }

  const alertsDir = process.env.PRICE_ALERTS_DATA_DIR?.trim();
  if (alertsDir) return path.join(alertsDir, "desk-users.json");

  return path.join(process.cwd(), ".data", "desk-users.json");
}

function emptyFile(): UsersFile {
  return { version: 1, users: [] };
}

function isValidRecord(value: unknown): value is ManagedUserRecord {
  if (!value || typeof value !== "object") return false;
  const u = value as ManagedUserRecord;
  return (
    typeof u.id === "string" &&
    u.id.length > 0 &&
    typeof u.username === "string" &&
    u.username.length > 0 &&
    typeof u.usernameKey === "string" &&
    u.usernameKey.length > 0 &&
    typeof u.passwordHash === "string" &&
    Boolean(parsePasswordHash(u.passwordHash)) &&
    (u.role === "admin" || u.role === "viewer") &&
    typeof u.sessionEpoch === "number" &&
    Number.isFinite(u.sessionEpoch) &&
    u.sessionEpoch >= 0 &&
    typeof u.enabled === "boolean" &&
    typeof u.createdAt === "string"
  );
}

async function readFileStore(): Promise<UsersFile> {
  if (mem !== undefined && mem !== null) return mem;

  const filePath = resolveUsersDataPath();
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<UsersFile>;
    if (parsed.version === 1 && Array.isArray(parsed.users)) {
      const users = parsed.users.filter(isValidRecord).map((u) => ({
        ...u,
        sessionEpoch: Math.floor(u.sessionEpoch),
        updatedAt: typeof u.updatedAt === "string" ? u.updatedAt : null,
        updatedBy: typeof u.updatedBy === "string" ? u.updatedBy : null
      }));
      mem = { version: 1, users };
      return mem;
    }
  } catch {
    /* missing or invalid */
  }
  mem = emptyFile();
  return mem;
}

async function persistFileStore(next: UsersFile): Promise<void> {
  const filePath = resolveUsersDataPath();
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await rename(tmp, filePath);
  mem = next;
}

function queueWrite(next: UsersFile): Promise<void> {
  const run = writeChain.then(() => persistFileStore(next));
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function normalizeUsernameKey(username: string): string {
  return username.trim().toLowerCase();
}

export function validateUsernamePlain(username: string): string | null {
  const value = username.trim();
  if (!value) return "نام کاربری را وارد کنید";
  if (value.length < USERNAME_MIN_LEN) {
    return `نام کاربری باید حداقل ${USERNAME_MIN_LEN} کاراکتر باشد`;
  }
  if (value.length > USERNAME_MAX_LEN) {
    return `نام کاربری حداکثر ${USERNAME_MAX_LEN} کاراکتر است`;
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    return "نام کاربری فقط حروف، عدد، نقطه، خط تیره و زیرخط";
  }
  return null;
}

export function getEnvAdminUsername(): string | null {
  return readEnvUsername(process.env.ADMIN_USERNAME);
}

export function getEnvViewerUsername(): string | null {
  return readEnvUsername(process.env.VIEWER_USERNAME);
}

function toPublicManaged(user: ManagedUserRecord): UserAccountPublic {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    source: "managed",
    enabled: user.enabled,
    canDelete: true,
    canResetPassword: true,
    passwordConfigured: true,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    updatedBy: user.updatedBy
  };
}

export async function listUserAccounts(): Promise<UserAccountPublic[]> {
  const store = await readFileStore();
  const accounts: UserAccountPublic[] = [];

  const adminUser = getEnvAdminUsername();
  if (adminUser) {
    accounts.push({
      id: ENV_ADMIN_ID,
      username: adminUser,
      role: "admin",
      source: "env",
      enabled: true,
      canDelete: false,
      canResetPassword: false,
      passwordConfigured: Boolean(readEnvPasswordHash(process.env.ADMIN_PASSWORD_HASH)),
      createdAt: null,
      updatedAt: null,
      updatedBy: null
    });
  }

  const viewerUser = getEnvViewerUsername();
  if (viewerUser) {
    const meta = await getViewerAuthPublicMeta();
    accounts.push({
      id: ENV_VIEWER_ID,
      username: viewerUser,
      role: "viewer",
      source: "env",
      enabled: true,
      canDelete: false,
      canResetPassword: true,
      passwordConfigured: meta.passwordConfigured,
      createdAt: null,
      updatedAt: meta.updatedAt,
      updatedBy: meta.updatedBy
    });
  }

  for (const user of store.users) {
    accounts.push(toPublicManaged(user));
  }

  return accounts;
}

export async function findManagedUserByUsername(username: string): Promise<ManagedUserRecord | null> {
  const key = normalizeUsernameKey(username);
  if (!key) return null;
  const store = await readFileStore();
  return store.users.find((u) => u.usernameKey === key) ?? null;
}

export async function findManagedUserById(id: string): Promise<ManagedUserRecord | null> {
  if (!id || id.startsWith("env:")) return null;
  const store = await readFileStore();
  return store.users.find((u) => u.id === id) ?? null;
}

/**
 * Session epoch for a login identity (invalidates cookies after password rotate).
 * Env admin → 0. Env viewer → viewer-auth epoch. Managed → per-user epoch.
 */
export async function getIdentitySessionEpoch(username: string, role: DeskRole): Promise<number | null> {
  const key = normalizeUsernameKey(username);
  const adminUser = getEnvAdminUsername();
  if (adminUser && normalizeUsernameKey(adminUser) === key && role === "admin") {
    return 0;
  }

  const viewerUser = getEnvViewerUsername();
  if (viewerUser && normalizeUsernameKey(viewerUser) === key && role === "viewer") {
    const meta = await getViewerAuthPublicMeta();
    return meta.sessionEpoch;
  }

  const managed = await findManagedUserByUsername(username);
  if (!managed || !managed.enabled) return null;
  if (managed.role !== role) return null;
  return managed.sessionEpoch;
}

/** Whether this session username is still a valid, enabled account. */
export async function isIdentityStillValid(
  username: string,
  role: DeskRole,
  passwordVersion: number
): Promise<boolean> {
  const epoch = await getIdentitySessionEpoch(username, role);
  if (epoch === null) return false;
  const pv = Number.isFinite(passwordVersion) ? Math.floor(passwordVersion) : 0;
  return pv === epoch;
}

async function usernameTaken(username: string): Promise<boolean> {
  const key = normalizeUsernameKey(username);
  const adminUser = getEnvAdminUsername();
  if (adminUser && normalizeUsernameKey(adminUser) === key) return true;
  const viewerUser = getEnvViewerUsername();
  if (viewerUser && normalizeUsernameKey(viewerUser) === key) return true;
  return Boolean(await findManagedUserByUsername(username));
}

export async function createManagedUser(
  input: CreateUserInput,
  updatedBy: string
): Promise<{ ok: true; user: UserAccountPublic } | { ok: false; message: string }> {
  const usernameError = validateUsernamePlain(input.username);
  if (usernameError) return { ok: false, message: usernameError };

  const password = typeof input.password === "string" ? input.password : "";
  const confirm = typeof input.confirmPassword === "string" ? input.confirmPassword : "";
  if (!password || !confirm) {
    return { ok: false, message: "رمز عبور و تکرار آن را وارد کنید" };
  }
  if (password !== confirm) {
    return { ok: false, message: "رمز عبور و تکرار آن یکسان نیستند" };
  }
  const passwordError = validateViewerPasswordPlain(password);
  if (passwordError) return { ok: false, message: passwordError };

  const role: DeskRole = input.role === "admin" ? "admin" : "viewer";

  if (await usernameTaken(input.username)) {
    return { ok: false, message: "این نام کاربری از قبل وجود دارد" };
  }

  const store = await readFileStore();
  if (store.users.length >= MAX_MANAGED_USERS) {
    return { ok: false, message: `حداکثر ${MAX_MANAGED_USERS} کاربر قابل ایجاد است` };
  }

  const now = new Date().toISOString();
  const username = input.username.trim();
  const record: ManagedUserRecord = {
    id: randomUUID(),
    username,
    usernameKey: normalizeUsernameKey(username),
    passwordHash: hashPassword(password),
    role,
    sessionEpoch: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
    updatedBy: updatedBy || "admin"
  };

  const next: UsersFile = { version: 1, users: [...store.users, record] };
  try {
    await queueWrite(next);
    return { ok: true, user: toPublicManaged(record) };
  } catch {
    return { ok: false, message: "ذخیره کاربر ناموفق بود" };
  }
}

export async function resetUserPassword(
  id: string,
  input: ResetPasswordInput,
  updatedBy: string
): Promise<{ ok: true; user: UserAccountPublic } | { ok: false; message: string; status?: number }> {
  const newPassword = typeof input.newPassword === "string" ? input.newPassword : "";
  const confirmPassword = typeof input.confirmPassword === "string" ? input.confirmPassword : "";

  if (!newPassword || !confirmPassword) {
    return { ok: false, message: "رمز جدید و تکرار آن را وارد کنید", status: 400 };
  }
  if (newPassword !== confirmPassword) {
    return { ok: false, message: "رمز جدید و تکرار آن یکسان نیستند", status: 400 };
  }

  if (id === ENV_ADMIN_ID) {
    return {
      ok: false,
      message: "رمز admin سیستم فقط از طریق سرور (.env) قابل تغییر است",
      status: 400
    };
  }

  if (id === ENV_VIEWER_ID) {
    const result = await setViewerPasswordFromAdmin(newPassword, updatedBy);
    if (!result.ok) return { ok: false, message: result.message, status: 400 };
    const accounts = await listUserAccounts();
    const viewer = accounts.find((a) => a.id === ENV_VIEWER_ID);
    if (!viewer) return { ok: false, message: "کاربر viewer سیستم یافت نشد", status: 404 };
    return { ok: true, user: viewer };
  }

  const store = await readFileStore();
  const index = store.users.findIndex((u) => u.id === id);
  if (index < 0) return { ok: false, message: "کاربر یافت نشد", status: 404 };

  const passwordError = validateViewerPasswordPlain(newPassword);
  if (passwordError) return { ok: false, message: passwordError, status: 400 };

  const prev = store.users[index];
  const now = new Date().toISOString();
  const updated: ManagedUserRecord = {
    ...prev,
    passwordHash: hashPassword(newPassword),
    sessionEpoch: prev.sessionEpoch + 1,
    updatedAt: now,
    updatedBy: updatedBy || "admin"
  };
  const users = [...store.users];
  users[index] = updated;

  try {
    await queueWrite({ version: 1, users });
    return { ok: true, user: toPublicManaged(updated) };
  } catch {
    return { ok: false, message: "ذخیره رمز ناموفق بود", status: 500 };
  }
}

export async function deleteManagedUser(
  id: string
): Promise<{ ok: true } | { ok: false; message: string; status?: number }> {
  if (id === ENV_ADMIN_ID || id === ENV_VIEWER_ID) {
    return { ok: false, message: "کاربر سیستمی قابل حذف نیست", status: 400 };
  }

  const store = await readFileStore();
  const nextUsers = store.users.filter((u) => u.id !== id);
  if (nextUsers.length === store.users.length) {
    return { ok: false, message: "کاربر یافت نشد", status: 404 };
  }

  try {
    await queueWrite({ version: 1, users: nextUsers });
    return { ok: true };
  } catch {
    return { ok: false, message: "حذف کاربر ناموفق بود", status: 500 };
  }
}

export async function setManagedUserEnabled(
  id: string,
  enabled: boolean,
  updatedBy: string
): Promise<{ ok: true; user: UserAccountPublic } | { ok: false; message: string; status?: number }> {
  if (id.startsWith("env:")) {
    return { ok: false, message: "وضعیت کاربر سیستمی از پنل تغییر نمی‌کند", status: 400 };
  }

  const store = await readFileStore();
  const index = store.users.findIndex((u) => u.id === id);
  if (index < 0) return { ok: false, message: "کاربر یافت نشد", status: 404 };

  const prev = store.users[index];
  const now = new Date().toISOString();
  const updated: ManagedUserRecord = {
    ...prev,
    enabled: Boolean(enabled),
    // Bump epoch when disabling so open sessions die immediately
    sessionEpoch: enabled ? prev.sessionEpoch : prev.sessionEpoch + 1,
    updatedAt: now,
    updatedBy: updatedBy || "admin"
  };
  const users = [...store.users];
  users[index] = updated;

  try {
    await queueWrite({ version: 1, users });
    return { ok: true, user: toPublicManaged(updated) };
  } catch {
    return { ok: false, message: "به‌روزرسانی کاربر ناموفق بود", status: 500 };
  }
}

/** Test helper: drop in-memory cache (does not delete file). */
export function clearUserStoreMemCache(): void {
  mem = undefined;
}
