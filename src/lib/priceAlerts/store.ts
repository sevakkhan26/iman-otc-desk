/**
 * Price Alerts persistence — PostgreSQL only (single source of truth).
 * Fail closed when DATABASE_URL is unavailable.
 */
import { randomUUID } from "node:crypto";
import { DatabaseUnavailableError, getDatabaseUrl, pingDatabase } from "@/db/client";
import {
  pgDeleteAlert,
  pgLoadAlertsBundle,
  pgSaveAlertsBundle,
  pgUpsertAlert
} from "@/db/repositories/alerts";
import type { PriceAlertNotification, PriceAlertRule } from "@/lib/types";

const MAX_NOTIFICATIONS = 500;
const MAX_ALERTS = 200;

export type StorageBackendType = "postgres";

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

function emptyStore(): StoreFile {
  return { alerts: [], notifications: [], updatedAt: null };
}

function isVercel(): boolean {
  return process.env.VERCEL === "1";
}

export function resolveStorageBackend(): StorageBackendType {
  return "postgres";
}

export function getStorageDiagnostics(extra?: {
  readable?: boolean | null;
  writable?: boolean | null;
}): StorageDiagnostics {
  let configured = false;
  try {
    getDatabaseUrl();
    configured = true;
  } catch {
    configured = false;
  }
  return {
    storageType: "postgres",
    storageConfigured: configured,
    persistent: configured,
    readable: extra?.readable ?? (configured ? null : false),
    writable: extra?.writable ?? (configured ? null : false),
    isVercel: isVercel(),
    vercel: isVercel(),
    runtime: "nodejs",
    commit:
      process.env.GIT_COMMIT_SHA ??
      process.env.VERCEL_GIT_COMMIT_SHA ??
      process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA ??
      null,
    region: process.env.VERCEL_REGION ?? null,
    databaseReachable: configured && (lastErrorCode === null || lastErrorCode !== "DATABASE_UNAVAILABLE"),
    schemaAvailable: configured,
    lastErrorCode
  };
}

export async function probeFileStorageHealth(): Promise<{
  readable: boolean;
  writable: boolean;
  ok: boolean;
  code: string | null;
}> {
  try {
    getDatabaseUrl();
    await pingDatabase();
    lastErrorCode = null;
    return { readable: true, writable: true, ok: true, code: null };
  } catch (error) {
    const code =
      error instanceof DatabaseUnavailableError ? "DATABASE_UNAVAILABLE" : "DATABASE_HEALTH_FAILED";
    lastErrorCode = code;
    return { readable: false, writable: false, ok: false, code };
  }
}

async function readBackend(): Promise<StoreFile> {
  try {
    getDatabaseUrl();
    const bundle = await pgLoadAlertsBundle();
    lastErrorCode = null;
    return {
      alerts: bundle.alerts as PriceAlertRule[],
      notifications: bundle.notifications as PriceAlertNotification[],
      updatedAt: new Date().toISOString()
    };
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      lastErrorCode = "DATABASE_UNAVAILABLE";
      throw new PriceAlertStorageError("DATABASE_UNAVAILABLE", error.message);
    }
    lastErrorCode = "STORAGE_READ_FAILED";
    throw new PriceAlertStorageError(
      "STORAGE_READ_FAILED",
      error instanceof Error ? error.message : "خواندن هشدارها از PostgreSQL ناموفق بود"
    );
  }
}

async function writeBackend(file: StoreFile): Promise<void> {
  try {
    getDatabaseUrl();
    await pgSaveAlertsBundle({
      alerts: file.alerts as unknown as Array<{ id: string } & Record<string, unknown>>,
      notifications: file.notifications as unknown as Array<
        { id: string; alertId?: string; triggeredAt?: string } & Record<string, unknown>
      >
    });
    lastErrorCode = null;
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      lastErrorCode = "DATABASE_UNAVAILABLE";
      throw new PriceAlertStorageError("DATABASE_UNAVAILABLE", error.message);
    }
    lastErrorCode = "STORAGE_WRITE_FAILED";
    throw new PriceAlertStorageError(
      "STORAGE_WRITE_FAILED",
      error instanceof Error ? error.message : "نوشتن هشدارها در PostgreSQL ناموفق بود"
    );
  }
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
    mem = await readBackend();
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
  await writeBackend(mem);
}

export async function __tryWriteFileStoreForTests(file: StoreFile): Promise<void> {
  await writeBackend(file);
}

export async function __resetStoreMemoryForTests(): Promise<void> {
  mem = null;
  lastErrorCode = null;
}

// re-export for optional direct upserts
export { pgUpsertAlert, pgDeleteAlert };
