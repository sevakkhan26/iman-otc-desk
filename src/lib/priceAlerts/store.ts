/**
 * Price Alerts persistence adapter.
 *
 * Backends:
 * - file: Docker production + local (writable PRICE_ALERTS_DATA_DIR). Single writer instance only.
 * - upstash: optional Redis REST (e.g. Vercel)
 * - none: no durable store
 *
 * Do not horizontally scale multiple app replicas against the same JSON file backend.
 */
import { randomUUID } from "node:crypto";
import { access, constants, copyFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { outboundFetch } from "@/lib/http";
import type { PriceAlertNotification, PriceAlertRule } from "@/lib/types";

const MAX_NOTIFICATIONS = 500;
const MAX_ALERTS = 200;
const REDIS_KEY = "otc:price-alerts:v1";

export type StorageBackendType = "file" | "upstash" | "none";

export type StorageDiagnostics = {
  storageType: StorageBackendType;
  storageConfigured: boolean;
  persistent: boolean;
  readable: boolean | null;
  writable: boolean | null;
  isVercel?: boolean;
  vercel: boolean;
  runtime: string;
  commit: string | null;
  region: string | null;
  databaseReachable: boolean | null;
  schemaAvailable: boolean;
  lastErrorCode: string | null;
};

type StoreFile = {
  alerts: PriceAlertRule[];
  notifications: PriceAlertNotification[];
  updatedAt: string | null;
};

export class PriceAlertStorageError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "PriceAlertStorageError";
    this.code = code;
  }
}

let mem: StoreFile | null = null;
let writeChain: Promise<void> = Promise.resolve();
let lastErrorCode: string | null = null;
let migrationAttempted = false;

function emptyStore(): StoreFile {
  return { alerts: [], notifications: [], updatedAt: null };
}

function isVercel(): boolean {
  return process.env.VERCEL === "1";
}

function hasUpstash(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
  return url.length > 0 && token.length > 0;
}

function explicitStorageMode(): StorageBackendType | null {
  const raw = (process.env.PRICE_ALERTS_STORAGE ?? "").trim().toLowerCase();
  if (raw === "file" || raw === "upstash" || raw === "none") return raw;
  return null;
}

/**
 * Storage selection:
 * 1. Explicit PRICE_ALERTS_STORAGE when set
 * 2. Else Upstash if both REST vars set
 * 3. Else Vercel → none (never file)
 * 4. Else local/dev → file
 */
export function resolveStorageBackend(): StorageBackendType {
  const explicit = explicitStorageMode();
  if (explicit === "file") {
    // Never use file on Vercel even if misconfigured — no silent local writes.
    if (isVercel()) return hasUpstash() ? "upstash" : "none";
    return "file";
  }
  if (explicit === "upstash") {
    // Explicit upstash never falls back to file; missing credentials fail at read/write.
    return "upstash";
  }
  if (explicit === "none") return "none";

  // Implicit selection (no PRICE_ALERTS_STORAGE):
  if (hasUpstash()) return "upstash";
  if (isVercel()) return "none";
  if (process.env.PRICE_ALERTS_FORCE_MEMORY === "1") return "none";
  // Local development default — file store under .data/
  return "file";
}

/** Configured data directory for file backend (absolute when possible). */
export function getConfiguredDataDir(): string {
  const fromEnv = process.env.PRICE_ALERTS_DATA_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  // Local default (gitignored)
  return path.resolve(process.cwd(), ".data", "price-alerts");
}

export function getConfiguredDataFile(): string {
  const fromEnv = process.env.PRICE_ALERTS_DATA_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(getConfiguredDataDir(), "price-alerts.json");
}

function legacyCandidatePaths(): string[] {
  const cwd = process.cwd();
  return [
    path.join(cwd, ".data", "price-alerts.json"),
    path.join(cwd, ".data", "price-alerts", "price-alerts.json"),
    "/app/.data/price-alerts.json"
  ];
}

export function getStorageDiagnostics(extra?: {
  readable?: boolean | null;
  writable?: boolean | null;
}): StorageDiagnostics {
  const type = resolveStorageBackend();
  const configured =
    type === "file" || (type === "upstash" && hasUpstash());
  return {
    storageType: type,
    storageConfigured: configured,
    persistent: type === "upstash" || type === "file",
    readable: extra?.readable ?? (type === "none" || !configured ? false : null),
    writable: extra?.writable ?? (type === "none" || !configured ? false : null),
    isVercel: isVercel(),
    vercel: isVercel(),
    runtime: "nodejs",
    commit:
      process.env.GIT_COMMIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
      null,
    region: process.env.VERCEL_REGION ?? null,
    databaseReachable:
      type === "upstash"
        ? hasUpstash() && (lastErrorCode === null || lastErrorCode !== "UPSTASH_UNREACHABLE")
        : type === "file"
          ? true
          : false,
    schemaAvailable: type !== "none",
    lastErrorCode
  };
}

/** Probe file storage health without mutating user data. */
export async function probeFileStorageHealth(): Promise<{
  readable: boolean;
  writable: boolean;
  ok: boolean;
  code: string | null;
}> {
  if (resolveStorageBackend() !== "file") {
    return { readable: false, writable: false, ok: false, code: "NOT_FILE_BACKEND" };
  }
  if (isVercel()) {
    return { readable: false, writable: false, ok: false, code: "FILE_STORAGE_FORBIDDEN_ON_VERCEL" };
  }
  const dir = getConfiguredDataDir();
  const file = getConfiguredDataFile();
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.R_OK | constants.W_OK);
    // Write probe in same dir, then remove
    const probe = path.join(dir, `.write-probe-${process.pid}`);
    await writeFile(probe, "ok", "utf8");
    await access(probe, constants.R_OK);
    const { unlink } = await import("node:fs/promises");
    await unlink(probe).catch(() => {});
    // Ensure data file path is accessible
    try {
      await access(file, constants.R_OK);
    } catch {
      // missing file is OK — will be created on first write
    }
    lastErrorCode = null;
    return { readable: true, writable: true, ok: true, code: null };
  } catch (error) {
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "FILE_HEALTH_FAILED";
    lastErrorCode = code;
    return { readable: false, writable: false, ok: false, code };
  }
}

function assertFileStoreAllowed(): void {
  if (isVercel()) {
    lastErrorCode = "FILE_STORAGE_FORBIDDEN_ON_VERCEL";
    throw new PriceAlertStorageError(
      "FILE_STORAGE_FORBIDDEN_ON_VERCEL",
      "ذخیره‌سازی فایل روی Vercel مجاز نیست"
    );
  }
}

function parseStoreJson(raw: string): StoreFile {
  const trimmed = raw.trim();
  if (!trimmed) return emptyStore();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new PriceAlertStorageError("INVALID_JSON", "فایل ذخیره‌سازی هشدارها نامعتبر است");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new PriceAlertStorageError("INVALID_JSON", "فایل ذخیره‌سازی هشدارها نامعتبر است");
  }
  const obj = parsed as StoreFile;
  if (!Array.isArray(obj.alerts) || !Array.isArray(obj.notifications)) {
    throw new PriceAlertStorageError("INVALID_JSON", "ساختار فایل ذخیره‌سازی هشدارها نامعتبر است");
  }
  return {
    alerts: obj.alerts,
    notifications: obj.notifications,
    updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : null
  };
}

async function migrateLegacyIfNeeded(targetFile: string): Promise<void> {
  if (migrationAttempted) return;
  migrationAttempted = true;
  // Tests / explicit empty volumes may opt out of one-time legacy import.
  if (process.env.PRICE_ALERTS_SKIP_LEGACY_MIGRATION === "1") return;
  try {
    await access(targetFile, constants.F_OK);
    // target exists — never overwrite
    return;
  } catch {
    // continue
  }
  for (const legacy of legacyCandidatePaths()) {
    if (path.resolve(legacy) === path.resolve(targetFile)) continue;
    try {
      const raw = await readFile(legacy, "utf8");
      parseStoreJson(raw); // validate
      await mkdir(path.dirname(targetFile), { recursive: true });
      await copyFile(legacy, targetFile);
      console.info("[priceAlerts] migrated legacy store to persistent data file");
      return;
    } catch {
      // try next legacy path
    }
  }
}

async function ensureStoreFile(): Promise<string> {
  assertFileStoreAllowed();
  const dir = getConfiguredDataDir();
  const file = getConfiguredDataFile();
  await mkdir(dir, { recursive: true });
  await migrateLegacyIfNeeded(file);
  try {
    await access(file, constants.F_OK);
  } catch {
    const empty = JSON.stringify(emptyStore());
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, empty, "utf8");
    await rename(tmp, file);
  }
  return file;
}

async function readFileStore(): Promise<StoreFile> {
  assertFileStoreAllowed();
  try {
    const file = await ensureStoreFile();
    const raw = await readFile(file, "utf8");
    try {
      return parseStoreJson(raw);
    } catch (error) {
      if (error instanceof PriceAlertStorageError && error.code === "INVALID_JSON") {
        // Backup corrupt file once and re-init empty
        try {
          const backup = `${file}.corrupt.${Date.now()}.bak`;
          await copyFile(file, backup);
          console.error("[priceAlerts] corrupt store backed up; reinitializing empty store");
        } catch {
          console.error("[priceAlerts] corrupt store; could not create backup");
        }
        const empty = emptyStore();
        await atomicWriteFileStore(empty);
        lastErrorCode = "INVALID_JSON_RECOVERED";
        return empty;
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof PriceAlertStorageError) throw error;
    lastErrorCode = "FILE_READ_FAILED";
    throw new PriceAlertStorageError("FILE_READ_FAILED", "خواندن ذخیره‌سازی فایل ناموفق بود");
  }
}

async function atomicWriteFileStore(fileData: StoreFile): Promise<void> {
  assertFileStoreAllowed();
  const dir = getConfiguredDataDir();
  const file = getConfiguredDataFile();
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.price-alerts.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(fileData);
  try {
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(payload, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    lastErrorCode = null;
  } catch (error) {
    if (error instanceof PriceAlertStorageError) throw error;
    try {
      const { unlink } = await import("node:fs/promises");
      await unlink(tmp).catch(() => {});
    } catch {
      /* ignore */
    }
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "FILE_WRITE_FAILED";
    lastErrorCode =
      code === "EROFS" || code === "EACCES" ? "FILESYSTEM_READONLY" : "FILE_WRITE_FAILED";
    throw new PriceAlertStorageError(
      lastErrorCode,
      "ذخیره‌سازی فایل برای هشدارها در این محیط در دسترس نیست"
    );
  }
}

async function writeFileStore(file: StoreFile): Promise<void> {
  await atomicWriteFileStore(file);
}

async function upstashCommand(command: unknown[]): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!base || !token) {
    lastErrorCode = "UPSTASH_NOT_CONFIGURED";
    throw new PriceAlertStorageError("UPSTASH_NOT_CONFIGURED", "ذخیره‌سازی Upstash پیکربندی نشده است");
  }

  const res = await outboundFetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(command),
    cache: "no-store"
  });

  if (!res.ok) {
    lastErrorCode = "UPSTASH_HTTP_" + res.status;
    throw new PriceAlertStorageError(lastErrorCode, "اتصال به ذخیره‌سازی Upstash ناموفق بود");
  }

  const payload = (await res.json()) as { result?: unknown; error?: string };
  if (payload.error) {
    lastErrorCode = "UPSTASH_CMD_ERROR";
    throw new PriceAlertStorageError("UPSTASH_CMD_ERROR", "دستور ذخیره‌سازی Upstash ناموفق بود");
  }
  lastErrorCode = null;
  return payload.result;
}

async function readUpstashStore(): Promise<StoreFile> {
  try {
    const result = await upstashCommand(["GET", REDIS_KEY]);
    if (result == null || result === "") return emptyStore();
    const raw = typeof result === "string" ? result : JSON.stringify(result);
    return parseStoreJson(raw);
  } catch (error) {
    if (error instanceof PriceAlertStorageError) throw error;
    lastErrorCode = "UPSTASH_UNREACHABLE";
    throw new PriceAlertStorageError("UPSTASH_UNREACHABLE", "ذخیره‌سازی Upstash در دسترس نیست");
  }
}

async function writeUpstashStore(file: StoreFile): Promise<void> {
  await upstashCommand(["SET", REDIS_KEY, JSON.stringify(file)]);
}

async function readBackend(): Promise<StoreFile> {
  const backend = resolveStorageBackend();
  if (backend === "upstash") return readUpstashStore();
  if (backend === "file") return readFileStore();
  lastErrorCode = isVercel() ? "STORAGE_NOT_CONFIGURED" : "STORAGE_DISABLED";
  return emptyStore();
}

async function writeBackend(file: StoreFile): Promise<void> {
  const backend = resolveStorageBackend();
  if (backend === "upstash") {
    await writeUpstashStore(file);
    return;
  }
  if (backend === "file") {
    await writeFileStore(file);
    return;
  }
  lastErrorCode = isVercel() ? "STORAGE_NOT_CONFIGURED" : "STORAGE_DISABLED";
  throw new PriceAlertStorageError(
    lastErrorCode,
    isVercel()
      ? "ذخیره‌سازی هشدارها در محیط اصلی تنظیم نشده است."
      : "ذخیره‌سازی هشدارها غیرفعال است"
  );
}

export async function loadPriceAlertStore(): Promise<StoreFile> {
  if (mem) return mem;
  mem = await readBackend();
  return mem;
}

export async function reloadPriceAlertStore(): Promise<StoreFile> {
  mem = null;
  return loadPriceAlertStore();
}

async function mutate(mutator: (store: StoreFile) => void): Promise<StoreFile> {
  const run = writeChain.then(async () => {
    const backend = resolveStorageBackend();
    // Always re-read file/upstash before write so concurrent mutate chain is consistent.
    if (backend === "upstash" || backend === "file" || !mem) {
      mem = await readBackend();
    }
    const store = mem ?? emptyStore();
    const next: StoreFile = {
      alerts: [...store.alerts],
      notifications: [...store.notifications],
      updatedAt: store.updatedAt
    };
    mutator(next);
    next.updatedAt = new Date().toISOString();
    if (next.alerts.length > MAX_ALERTS) {
      next.alerts = next.alerts.slice(0, MAX_ALERTS);
    }
    if (next.notifications.length > MAX_NOTIFICATIONS) {
      next.notifications = next.notifications.slice(0, MAX_NOTIFICATIONS);
    }
    await writeBackend(next);
    mem = next;
    return next;
  });
  writeChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export async function listAlerts(): Promise<PriceAlertRule[]> {
  const store = await loadPriceAlertStore();
  return store.alerts;
}

export async function listNotifications(): Promise<PriceAlertNotification[]> {
  const store = await loadPriceAlertStore();
  return store.notifications;
}

export async function getAlert(id: string): Promise<PriceAlertRule | null> {
  const store = await loadPriceAlertStore();
  return store.alerts.find((a) => a.id === id) ?? null;
}

export async function createAlert(rule: PriceAlertRule): Promise<PriceAlertRule> {
  await mutate((store) => {
    store.alerts.unshift(rule);
  });
  return rule;
}

export async function updateAlert(
  id: string,
  patch: Partial<PriceAlertRule>
): Promise<PriceAlertRule | null> {
  let updated: PriceAlertRule | null = null;
  await mutate((store) => {
    const idx = store.alerts.findIndex((a) => a.id === id);
    if (idx < 0) return;
    updated = {
      ...store.alerts[idx]!,
      ...patch,
      id,
      updatedAt: new Date().toISOString()
    };
    store.alerts[idx] = updated;
  });
  return updated;
}

export async function deleteAlert(id: string): Promise<boolean> {
  let ok = false;
  await mutate((store) => {
    const before = store.alerts.length;
    store.alerts = store.alerts.filter((a) => a.id !== id);
    ok = store.alerts.length < before;
  });
  return ok;
}

export async function appendNotification(n: PriceAlertNotification): Promise<void> {
  await mutate((store) => {
    store.notifications.unshift(n);
  });
}

export async function markNotificationRead(id: string): Promise<PriceAlertNotification | null> {
  let updated: PriceAlertNotification | null = null;
  await mutate((store) => {
    const row = store.notifications.find((n) => n.id === id);
    if (!row) return;
    row.readAt = row.readAt ?? new Date().toISOString();
    updated = row;
  });
  return updated;
}

export async function markAllNotificationsRead(): Promise<number> {
  let count = 0;
  const now = new Date().toISOString();
  await mutate((store) => {
    for (const n of store.notifications) {
      if (!n.readAt) {
        n.readAt = now;
        count += 1;
      }
    }
  });
  return count;
}

export async function deleteNotification(id: string): Promise<boolean> {
  let ok = false;
  await mutate((store) => {
    const before = store.notifications.length;
    store.notifications = store.notifications.filter((n) => n.id !== id);
    ok = store.notifications.length < before;
  });
  return ok;
}

export async function clearNotifications(): Promise<number> {
  let count = 0;
  await mutate((store) => {
    count = store.notifications.length;
    store.notifications = [];
  });
  return count;
}

export async function unreadCount(): Promise<number> {
  const store = await loadPriceAlertStore();
  return store.notifications.filter((n) => !n.readAt).length;
}

export async function updateAlertSoft(
  id: string,
  patch: Partial<PriceAlertRule>
): Promise<PriceAlertRule | null> {
  try {
    return await updateAlert(id, patch);
  } catch (error) {
    if (error instanceof PriceAlertStorageError) return null;
    lastErrorCode = "SOFT_UPDATE_FAILED";
    return null;
  }
}

export async function appendNotificationSoft(n: PriceAlertNotification): Promise<boolean> {
  try {
    await appendNotification(n);
    return true;
  } catch {
    return false;
  }
}

export async function __setStoreForTests(file: StoreFile): Promise<void> {
  mem = {
    alerts: [...file.alerts],
    notifications: [...file.notifications],
    updatedAt: file.updatedAt
  };
  if (!isVercel() && resolveStorageBackend() === "file") {
    await writeFileStore(mem);
  }
}

export async function __tryWriteFileStoreForTests(file: StoreFile): Promise<void> {
  await writeFileStore(file);
}

export async function __resetStoreMemoryForTests(): Promise<void> {
  mem = null;
  lastErrorCode = null;
  migrationAttempted = false;
}
