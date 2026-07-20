/**
 * Durable storage for external Tether API keys.
 * Same backend selection model as price alerts / market snapshot:
 * file (local/Docker), upstash (Vercel), fail-closed when unavailable.
 */
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { outboundFetch } from "@/lib/http";
import type { ApiKeyRecord, ApiKeyStoreFile } from "@/lib/apiKeys/types";

const REDIS_KEY = "otc:tether-api-keys:v1";

export class ApiKeyStorageError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiKeyStorageError";
    this.code = code;
  }
}

type StorageBackend = "file" | "upstash" | "none";

let mem: ApiKeyStoreFile | null = null;
let writeChain: Promise<void> = Promise.resolve();

function isVercel(): boolean {
  return process.env.VERCEL === "1";
}

function hasUpstash(): boolean {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim() ?? "";
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim() ?? "";
  return url.length > 0 && token.length > 0;
}

export function resolveApiKeyStorageBackend(): StorageBackend {
  const explicit = (
    process.env.TETHER_API_KEYS_STORAGE ??
    process.env.PRICE_ALERTS_STORAGE ??
    ""
  )
    .trim()
    .toLowerCase();
  if (explicit === "upstash") return hasUpstash() ? "upstash" : "none";
  if (explicit === "file") {
    if (isVercel()) return hasUpstash() ? "upstash" : "none";
    return "file";
  }
  if (explicit === "none" || explicit === "memory") return "none";
  if (hasUpstash()) return "upstash";
  if (isVercel()) return "none";
  return "file";
}

export function isApiKeyStorageDurable(): boolean {
  const b = resolveApiKeyStorageBackend();
  return b === "file" || b === "upstash";
}

function emptyStore(): ApiKeyStoreFile {
  return { version: 1, keys: [], rateLimits: {}, updatedAt: null };
}

function storeFilePath(): string {
  const fromEnv = process.env.TETHER_API_KEYS_DATA_FILE?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const dir =
    process.env.TETHER_API_KEYS_DATA_DIR?.trim() ||
    process.env.PRICE_ALERTS_DATA_DIR?.trim() ||
    path.join(process.cwd(), ".data");
  return path.join(path.resolve(dir), "tether-api-keys.json");
}

function parseStore(raw: unknown): ApiKeyStoreFile {
  if (!raw || typeof raw !== "object") return emptyStore();
  const o = raw as Partial<ApiKeyStoreFile>;
  const keys = Array.isArray(o.keys) ? (o.keys as ApiKeyRecord[]) : [];
  const rateLimits =
    o.rateLimits && typeof o.rateLimits === "object" && !Array.isArray(o.rateLimits)
      ? (o.rateLimits as ApiKeyStoreFile["rateLimits"])
      : {};
  return {
    version: 1,
    keys,
    rateLimits,
    updatedAt: typeof o.updatedAt === "string" ? o.updatedAt : null
  };
}

async function upstashCommand(args: unknown[]): Promise<unknown> {
  const base = process.env.UPSTASH_REDIS_REST_URL!.trim().replace(/\/$/, "");
  const token = process.env.UPSTASH_REDIS_REST_TOKEN!.trim();
  const res = await outboundFetch(base, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "content-type": "application/json"
    },
    body: JSON.stringify(args),
    cache: "no-store"
  });
  if (!res.ok) {
    throw new ApiKeyStorageError("UPSTASH_HTTP", "اتصال به ذخیره‌سازی Upstash ناموفق بود");
  }
  const payload = (await res.json()) as { result?: unknown; error?: string };
  if (payload.error) {
    throw new ApiKeyStorageError("UPSTASH_CMD", "دستور ذخیره‌سازی Upstash ناموفق بود");
  }
  return payload.result;
}

async function readBackend(): Promise<ApiKeyStoreFile> {
  const backend = resolveApiKeyStorageBackend();
  if (backend === "upstash") {
    const result = await upstashCommand(["GET", REDIS_KEY]);
    if (result == null || result === "") return emptyStore();
    const raw = typeof result === "string" ? result : JSON.stringify(result);
    return parseStore(JSON.parse(raw));
  }
  if (backend === "file") {
    const file = storeFilePath();
    try {
      const raw = await readFile(file, "utf8");
      return parseStore(JSON.parse(raw));
    } catch {
      return emptyStore();
    }
  }
  throw new ApiKeyStorageError(
    "STORAGE_NOT_CONFIGURED",
    isVercel()
      ? "ذخیره‌سازی کلید API در Vercel پیکربندی نشده است (Upstash لازم است)."
      : "ذخیره‌سازی کلید API در دسترس نیست."
  );
}

async function writeBackend(store: ApiKeyStoreFile): Promise<void> {
  const backend = resolveApiKeyStorageBackend();
  if (backend === "upstash") {
    await upstashCommand(["SET", REDIS_KEY, JSON.stringify(store)]);
    return;
  }
  if (backend === "file") {
    if (isVercel()) {
      throw new ApiKeyStorageError("FILE_FORBIDDEN", "ذخیره فایل روی Vercel مجاز نیست");
    }
    const file = storeFilePath();
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.tether-api-keys.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(tmp, "w");
    try {
      await handle.writeFile(JSON.stringify(store), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    return;
  }
  throw new ApiKeyStorageError(
    "STORAGE_NOT_CONFIGURED",
    isVercel()
      ? "ذخیره‌سازی کلید API در Vercel پیکربندی نشده است (Upstash لازم است)."
      : "ذخیره‌سازی کلید API در دسترس نیست."
  );
}

export async function loadApiKeyStore(options?: { force?: boolean }): Promise<ApiKeyStoreFile> {
  // Force-read for auth/list so multi-process revoke is visible (no stale mem).
  if (!options?.force && mem) return mem;
  mem = await readBackend();
  return mem;
}

export async function mutateApiKeyStore(
  mutator: (store: ApiKeyStoreFile) => void
): Promise<ApiKeyStoreFile> {
  const run = writeChain.then(async () => {
    const backend = resolveApiKeyStorageBackend();
    if (backend === "none") {
      throw new ApiKeyStorageError(
        "STORAGE_NOT_CONFIGURED",
        isVercel()
          ? "ذخیره‌سازی کلید API در Vercel پیکربندی نشده است (Upstash لازم است)."
          : "ذخیره‌سازی کلید API در دسترس نیست."
      );
    }
    mem = await readBackend();
    const next: ApiKeyStoreFile = {
      version: 1,
      keys: [...(mem.keys ?? [])],
      rateLimits: { ...(mem.rateLimits ?? {}) },
      updatedAt: mem.updatedAt
    };
    mutator(next);
    next.updatedAt = new Date().toISOString();
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

/** Test helper: reset in-memory cache (does not wipe durable store). */
export function clearApiKeyStoreMemory(): void {
  mem = null;
}

/** Test helper: wipe file store when running unit tests. */
export async function __dangerouslyResetApiKeyStoreForTests(): Promise<void> {
  mem = null;
  const backend = resolveApiKeyStorageBackend();
  if (backend === "file") {
    await unlink(storeFilePath()).catch(() => {});
  } else if (backend === "upstash") {
    await upstashCommand(["DEL", REDIS_KEY]).catch(() => {});
  }
}
