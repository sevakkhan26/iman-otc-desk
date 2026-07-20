/**
 * Managed desk users — PostgreSQL users table (single source of truth).
 * Bootstrap accounts stay in env (admin) / env+PG override (viewer).
 * Fail closed when DATABASE_URL is unavailable for managed-user operations.
 */
import { randomUUID } from "node:crypto";
import {
  pgBumpCredentialVersion,
  pgDeleteUser,
  pgFindUserByUsernameKey,
  pgListUsers,
  pgSetUserActive,
  pgUpsertUser,
  type PgUserRow
} from "@/db/repositories/users";
import { DatabaseUnavailableError, getDatabaseUrl } from "@/db/client";
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
  usernameKey: string;
  passwordHash: string;
  role: DeskRole;
  sessionEpoch: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string | null;
  updatedBy: string | null;
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

function rowToManaged(r: PgUserRow): ManagedUserRecord {
  return {
    id: r.id,
    username: r.username,
    usernameKey: r.usernameKey,
    passwordHash: r.passwordHash,
    role: r.role,
    sessionEpoch: r.credentialVersion,
    enabled: r.isActive,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    updatedBy: r.updatedBy
  };
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

export async function listUserAccounts(): Promise<UserAccountPublic[]> {
  getDatabaseUrl();
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

  const rows = await pgListUsers();
  for (const r of rows) {
    if (r.source === "env") continue; // env accounts listed above
    accounts.push(toPublicManaged(rowToManaged(r)));
  }

  return accounts;
}

export async function findManagedUserByUsername(username: string): Promise<ManagedUserRecord | null> {
  const key = normalizeUsernameKey(username);
  if (!key) return null;
  getDatabaseUrl();
  const row = await pgFindUserByUsernameKey(key);
  if (!row || row.source === "env") return null;
  return rowToManaged(row);
}

export async function findManagedUserById(id: string): Promise<ManagedUserRecord | null> {
  if (!id || id.startsWith("env:")) return null;
  getDatabaseUrl();
  const rows = await pgListUsers();
  const row = rows.find((r) => r.id === id && r.source !== "env");
  return row ? rowToManaged(row) : null;
}

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
  try {
    getDatabaseUrl();
  } catch {
    return { ok: false, message: "DATABASE_URL is required" };
  }

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

  const managed = (await pgListUsers()).filter((u) => u.source !== "env");
  if (managed.length >= MAX_MANAGED_USERS) {
    return { ok: false, message: `حداکثر ${MAX_MANAGED_USERS} کاربر قابل ایجاد است` };
  }

  const now = new Date().toISOString();
  const username = input.username.trim();
  const id = randomUUID();
  try {
    await pgUpsertUser({
      id,
      username,
      usernameKey: normalizeUsernameKey(username),
      passwordHash: hashPassword(password),
      role,
      isActive: true,
      credentialVersion: 0,
      source: "managed",
      updatedBy: updatedBy || "admin"
    });
    return {
      ok: true,
      user: {
        id,
        username,
        role,
        source: "managed",
        enabled: true,
        canDelete: true,
        canResetPassword: true,
        passwordConfigured: true,
        createdAt: now,
        updatedAt: now,
        updatedBy: updatedBy || "admin"
      }
    };
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return { ok: false, message: error.message };
    }
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
      message: "رمز admin سیستم فقط از طریق سرور قابل تغییر است",
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

  const prev = await findManagedUserById(id);
  if (!prev) return { ok: false, message: "کاربر یافت نشد", status: 404 };

  const passwordError = validateViewerPasswordPlain(newPassword);
  if (passwordError) return { ok: false, message: passwordError, status: 400 };

  try {
    await pgUpsertUser({
      id: prev.id,
      username: prev.username,
      usernameKey: prev.usernameKey,
      passwordHash: hashPassword(newPassword),
      role: prev.role,
      isActive: prev.enabled,
      credentialVersion: prev.sessionEpoch + 1,
      source: "managed",
      updatedBy: updatedBy || "admin"
    });
    const updated = await findManagedUserById(id);
    if (!updated) return { ok: false, message: "کاربر یافت نشد", status: 404 };
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

  const prev = await findManagedUserById(id);
  if (!prev) return { ok: false, message: "کاربر یافت نشد", status: 404 };

  try {
    await pgDeleteUser(id);
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

  const prev = await findManagedUserById(id);
  if (!prev) return { ok: false, message: "کاربر یافت نشد", status: 404 };

  try {
    await pgSetUserActive(id, Boolean(enabled));
    if (!enabled) {
      await pgBumpCredentialVersion(id);
    }
    await pgUpsertUser({
      id: prev.id,
      username: prev.username,
      usernameKey: prev.usernameKey,
      passwordHash: prev.passwordHash,
      role: prev.role,
      isActive: Boolean(enabled),
      credentialVersion: enabled ? prev.sessionEpoch : prev.sessionEpoch + 1,
      source: "managed",
      updatedBy: updatedBy || "admin"
    });
    const updated = await findManagedUserById(id);
    if (!updated) return { ok: false, message: "کاربر یافت نشد", status: 404 };
    return { ok: true, user: toPublicManaged(updated) };
  } catch {
    return { ok: false, message: "به‌روزرسانی کاربر ناموفق بود", status: 500 };
  }
}

export function clearUserStoreMemCache(): void {
  // no process-level user cache
}
