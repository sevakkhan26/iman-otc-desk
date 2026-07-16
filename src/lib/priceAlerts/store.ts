import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PriceAlertNotification, PriceAlertRule } from "@/lib/types";

const dataDir = path.join(process.cwd(), ".data");
const storePath = path.join(dataDir, "price-alerts.json");

const MAX_NOTIFICATIONS = 500;
const MAX_ALERTS = 200;

type StoreFile = {
  alerts: PriceAlertRule[];
  notifications: PriceAlertNotification[];
  updatedAt: string | null;
};

let mem: StoreFile | null = null;
let writeChain: Promise<void> = Promise.resolve();

function emptyStore(): StoreFile {
  return { alerts: [], notifications: [], updatedAt: null };
}

async function readDisk(): Promise<StoreFile> {
  try {
    const raw = await readFile(storePath, "utf8");
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

async function writeDisk(file: StoreFile): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(storePath, JSON.stringify(file, null, 0), "utf8");
}

export async function loadPriceAlertStore(): Promise<StoreFile> {
  if (mem) return mem;
  mem = await readDisk();
  return mem;
}

async function mutate(mutator: (store: StoreFile) => void): Promise<StoreFile> {
  const run = writeChain.then(async () => {
    const store = await loadPriceAlertStore();
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
    mem = next;
    await writeDisk(next);
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

/** Test helper: replace store contents (used by unit tests). */
export async function __setStoreForTests(file: StoreFile): Promise<void> {
  mem = {
    alerts: [...file.alerts],
    notifications: [...file.notifications],
    updatedAt: file.updatedAt
  };
  await writeDisk(mem);
}
