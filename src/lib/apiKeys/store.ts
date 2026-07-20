/**
 * Durable storage for external market-data API keys — PostgreSQL only.
 * Fail closed when DATABASE_URL is unavailable.
 */
import {
  pgFindApiKeyByHash,
  pgImportApiKeyStoreFile,
  pgIncrementRateLimit,
  pgInsertApiKey,
  pgListApiKeyRecords,
  pgRevokeApiKey,
  pgTouchApiKeyLastUsed,
  pgUpdateApiKeyScopes,
  toUuid
} from "@/db/repositories/apiKeys";
import { DatabaseUnavailableError, getDatabaseUrl } from "@/db/client";
import type { ApiKeyRecord, ApiKeyScope, ApiKeyStoreFile } from "@/lib/apiKeys/types";

export class ApiKeyStorageError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiKeyStorageError";
    this.code = code;
  }
}

export function resolveApiKeyStorageBackend(): "postgres" {
  return "postgres";
}

export function isApiKeyStorageDurable(): boolean {
  try {
    getDatabaseUrl();
    return true;
  } catch {
    return false;
  }
}

export async function loadApiKeyStore(_options?: { force?: boolean }): Promise<ApiKeyStoreFile> {
  try {
    const keys = await pgListApiKeyRecords();
    return { version: 1, keys, rateLimits: {}, updatedAt: new Date().toISOString() };
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      throw new ApiKeyStorageError("DATABASE_UNAVAILABLE", error.message);
    }
    throw new ApiKeyStorageError(
      "STORAGE_READ_FAILED",
      error instanceof Error ? error.message : "خواندن کلیدها از PostgreSQL ناموفق بود"
    );
  }
}

/**
 * Mutate API keys. The mutator receives a mutable file-shaped store;
 * we apply create/update/revoke operations detected by diffing keys.
 * For rate limits, use pgIncrementRateLimit via service path.
 */
export async function mutateApiKeyStore(
  mutator: (store: ApiKeyStoreFile) => void
): Promise<ApiKeyStoreFile> {
  if (!isApiKeyStorageDurable()) {
    throw new ApiKeyStorageError(
      "DATABASE_UNAVAILABLE",
      "DATABASE_URL is required for API key storage (PostgreSQL)."
    );
  }

  const before = await loadApiKeyStore({ force: true });
  const draft: ApiKeyStoreFile = {
    version: 1,
    keys: before.keys.map((k) => ({ ...k, scopes: k.scopes ? [...k.scopes] : undefined })),
    rateLimits: { ...before.rateLimits },
    updatedAt: before.updatedAt
  };
  mutator(draft);

  // Apply key-level changes
  const beforeById = new Map(before.keys.map((k) => [k.id, k]));
  const afterById = new Map(draft.keys.map((k) => [k.id, k]));

  for (const [id, after] of afterById) {
    const prev = beforeById.get(id);
    if (!prev) {
      await pgInsertApiKey(after);
      continue;
    }
    // revoke
    if (!prev.revokedAt && after.revokedAt) {
      await pgRevokeApiKey(toUuid(id));
    }
    // scopes
    const prevScopes = JSON.stringify(prev.scopes ?? [prev.scope]);
    const nextScopes = JSON.stringify(after.scopes ?? [after.scope]);
    if (prevScopes !== nextScopes && after.scopes) {
      await pgUpdateApiKeyScopes(toUuid(id), after.scopes as ApiKeyScope[]);
    }
    // lastUsed
    if (after.lastUsedAt && after.lastUsedAt !== prev.lastUsedAt) {
      await pgTouchApiKeyLastUsed(toUuid(id), after.lastUsedAt);
    }
  }

  return loadApiKeyStore({ force: true });
}

export async function pgRateLimitTick(
  apiKeyId: string,
  windowStartMs: number
): Promise<number> {
  return pgIncrementRateLimit(toUuid(apiKeyId), windowStartMs);
}

export function clearApiKeyStoreMemory(): void {
  // no process cache
}

export async function __dangerouslyResetApiKeyStoreForTests(): Promise<void> {
  // Tests should use a dedicated DATABASE_URL (pglite temp dir)
}

export { pgFindApiKeyByHash, pgImportApiKeyStoreFile, toUuid };
