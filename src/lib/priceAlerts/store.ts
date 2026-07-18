import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PriceAlertNotification, PriceAlertRule } from "@/lib/types";

const MAX_NOTIFICATIONS = 500;
const MAX_ALERTS = 200;
const REDIS_KEY = "otc:price-alerts:v1";

export type StorageBackendType = "file" | "upstash" | "none";

export type StorageDiagnostics = {
  storageType: StorageBackendType;
  storageConfigured: boolean;
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

function emptyStore(): StoreFile {
  return { alerts: [], notifications: [], updatedAt: null };
}

function isVercel(): boolean {
  // Explicit Vercel marker (do not use NODE_ENV alone).
  return process.env.VERCEL === "1";
}

function hasUpstash(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
  return url.length > 0 && token.length > 0;
}

/**
 * Storage selection (strict order):
 * 1. Upstash REST configured → upstash
 * 2. Vercel without Upstash → none (never file)
 * 3. Non-Vercel local → file
 */
export function resolveStorageBackend(): StorageBackendType {
  if (hasUpstash()) return "upstash";
  if (isVercel()) return "none";
  if (process.env.PRICE_ALERTS_FORCE_MEMORY === "1") return "none";
  return "file";
}

export function getStorageDiagnostics(): StorageDiagnostics {
  const type = resolveStorageBackend();
  return {
    storageType: type,
    storageConfigured: type === "upstash" || type === "file",
    vercel: isVercel(),
    runtime: "nodejs",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ?? null,
    region: process.env.VERCEL_REGION ?? null,
    databaseReachable:
      type === "upstash"
        ? lastErrorCode === null || lastErrorCode !== "UPSTASH_UNREACHABLE"
        : type === "file"
          ? true
          : false,
    schemaAvailable: type !== "none",
    lastErrorCode
  };
}

/** Hard guard: never touch the project filesystem on Vercel. */
function assertFileStoreAllowed(): void {
  if (isVercel()) {
    lastErrorCode = "FILE_STORAGE_FORBIDDEN_ON_VERCEL";
    throw new PriceAlertStorageError(
      "FILE_STORAGE_FORBIDDEN_ON_VERCEL",
      "ذخیره‌سازی فایل روی Vercel مجاز نیست"
    );
  }
}

function dataDir(): string {
  assertFileStoreAllowed();
  return path.join(process.cwd(), ".data");
}

function storePath(): string {
  return path.join(dataDir(), "price-alerts.json");
}

async function readFileStore(): Promise<StoreFile> {
  assertFileStoreAllowed();
  try {
    const raw = await readFile(storePath(), "utf8");
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || !Array.isArray(parsed.alerts) || !Array.isArray(parsed.notifications)) {
      return emptyStore();
    }
    return {
      alerts: parsed.alerts,
      notifications: parsed.notifications,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
    };
  } catch {
    return emptyStore();
  }
}

async function writeFileStore(file: StoreFile): Promise<void> {
  // Must throw before any mkdir/writeFile on Vercel.
  assertFileStoreAllowed();
  try {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(storePath(), JSON.stringify(file, null, 0), "utf8");
    lastErrorCode = null;
  } catch (error) {
    if (error instanceof PriceAlertStorageError) throw error;
    const code =
      error instanceof Error && "code" in error
        ? String((error as NodeJS.ErrnoException).code)
        : "FILE_WRITE_FAILED";
    lastErrorCode = code === "EROFS" || code === "EACCES" ? "FILESYSTEM_READONLY" : "FILE_WRITE_FAILED";
    throw new PriceAlertStorageError(
      lastErrorCode,
      "ذخیره‌سازی فایل برای هشدارها در این محیط در دسترس نیست"
    );
  }
}

async function upstashCommand(command: unknown[]): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL?.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim();
  if (!base || !token) {
    lastErrorCode = "UPSTASH_NOT_CONFIGURED";
    throw new PriceAlertStorageError("UPSTASH_NOT_CONFIGURED", "ذخیره‌سازی Upstash پیکربندی نشده است");
  }

  const res = await fetch(base, {
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
    const parsed = JSON.parse(raw) as StoreFile;
    if (!parsed || !Array.isArray(parsed.alerts) || !Array.isArray(parsed.notifications)) {
      return emptyStore();
    }
    return {
      alerts: parsed.alerts,
      notifications: parsed.notifications,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
    };
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
  // none — empty durable store (no silent tmp persistence)
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
      ? "در Vercel باید UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN تنظیم شود"
      : "ذخیره‌سازی هشدارها غیرفعال است"
  );
}

export async function loadPriceAlertStore(): Promise<StoreFile> {
  if (mem) return mem;
  mem = await readBackend();
  return mem;
}

/** Force re-read from durable backend (clears process memory). */
export async function reloadPriceAlertStore(): Promise<StoreFile> {
  mem = null;
  return loadPriceAlertStore();
}

async function mutate(mutator: (store: StoreFile) => void): Promise<StoreFile> {
  const run = writeChain.then(async () => {
    // Always reload from durable store before write on serverless (fresh instance memory is empty,
    // but also avoids stale cross-request memory when backend is shared).
    const backend = resolveStorageBackend();
    if (backend === "upstash" || !mem) {
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

/** Soft update used during evaluation: never throws on storage failure (logs via lastErrorCode). */
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

/** Test helper: replace store contents (used by unit tests). */
export async function __setStoreForTests(file: StoreFile): Promise<void> {
  mem = {
    alerts: [...file.alerts],
    notifications: [...file.notifications],
    updatedAt: file.updatedAt
  };
  // Never write files on Vercel; only persist to disk for local file-backend tests.
  if (!isVercel() && resolveStorageBackend() === "file") {
    await writeFileStore(mem);
  }
}

/** Exported for regression tests — must throw on Vercel before mkdir. */
export async function __tryWriteFileStoreForTests(file: StoreFile): Promise<void> {
  await writeFileStore(file);
}

export async function __resetStoreMemoryForTests(): Promise<void> {
  mem = null;
  lastErrorCode = null;
}
