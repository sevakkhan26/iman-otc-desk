/**
 * PostgreSQL-backed API key store (single source of truth).
 * Preserves HMAC key hashes from the prior file store for compatibility.
 */
import { and, eq, sql } from "drizzle-orm";
import { getDbAsync } from "@/db/client";
import { apiKeyScopes, apiKeys, apiRateLimitBuckets, apiClients } from "@/db/schema";
import type { ApiKeyRecord, ApiKeyScope, ApiKeyStoreFile } from "@/lib/apiKeys/types";
import { isApiKeyScope, normalizeRecordScopes } from "@/lib/apiKeys/types";
import { randomUUID } from "node:crypto";

function numOrNull(v: string | null | undefined): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function pgListApiKeyRecords(): Promise<ApiKeyRecord[]> {
  const db = await getDbAsync();
  const keys = await db.select().from(apiKeys);
  const scopes = await db.select().from(apiKeyScopes);
  const byKey = new Map<string, ApiKeyScope[]>();
  for (const s of scopes) {
    if (!isApiKeyScope(s.scope)) continue;
    const list = byKey.get(s.apiKeyId) ?? [];
    list.push(s.scope);
    byKey.set(s.apiKeyId, list);
  }
  return keys.map((k) => {
    const sc = byKey.get(k.id) ?? (["tether:read"] as ApiKeyScope[]);
    return {
      id: k.id,
      name: k.name,
      keyPrefix: k.keyPrefix,
      keySuffix: k.keySuffix,
      keyHash: k.keyHash,
      scope: sc[0],
      scopes: sc,
      createdAt: k.createdAt,
      expiresAt: k.expiresAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      createdBy: k.createdBy
    } satisfies ApiKeyRecord;
  });
}

/** Normalize legacy 32-hex ids to UUID form for PG uuid columns. */
export function toUuid(id: string): string {
  if (
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
  ) {
    return id;
  }
  if (/^[0-9a-f]{32}$/i.test(id)) {
    const h = id.toLowerCase();
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }
  return randomUUID();
}

export async function pgInsertApiKey(record: ApiKeyRecord): Promise<void> {
  const db = await getDbAsync();
  const scopes = normalizeRecordScopes(record);
  const keyId = toUuid(record.id);

  await db.insert(apiKeys).values({
    id: keyId,
    name: record.name,
    keyPrefix: record.keyPrefix,
    keySuffix: record.keySuffix,
    keyHash: record.keyHash,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    lastUsedAt: record.lastUsedAt,
    createdBy: record.createdBy,
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString()
  });

  if (scopes.length) {
    await db.insert(apiKeyScopes).values(
      scopes.map((scope) => ({
        apiKeyId: keyId,
        scope
      }))
    );
  }
}

export async function pgUpdateApiKeyScopes(id: string, scopes: ApiKeyScope[]): Promise<boolean> {
  const db = await getDbAsync();
  const existing = await db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
  if (!existing[0]) return false;
  if (existing[0].revokedAt) {
    throw new Error("KEY_REVOKED");
  }
  await db.delete(apiKeyScopes).where(eq(apiKeyScopes.apiKeyId, id));
  if (scopes.length) {
    await db.insert(apiKeyScopes).values(scopes.map((scope) => ({ apiKeyId: id, scope })));
  }
  await db
    .update(apiKeys)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(apiKeys.id, id));
  return true;
}

export async function pgRevokeApiKey(id: string): Promise<ApiKeyRecord | null> {
  const db = await getDbAsync();
  const now = new Date().toISOString();
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: now, updatedAt: now })
    .where(eq(apiKeys.id, id))
    .returning();
  if (!rows[0]) return null;
  const scopes = await db.select().from(apiKeyScopes).where(eq(apiKeyScopes.apiKeyId, id));
  const sc = scopes.map((s) => s.scope).filter(isApiKeyScope);
  const k = rows[0];
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    keySuffix: k.keySuffix,
    keyHash: k.keyHash,
    scope: sc[0] ?? "tether:read",
    scopes: sc.length ? sc : ["tether:read"],
    createdAt: k.createdAt,
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdBy: k.createdBy
  };
}

export async function pgFindApiKeyByHash(keyHash: string): Promise<ApiKeyRecord | null> {
  const db = await getDbAsync();
  const rows = await db.select().from(apiKeys).where(eq(apiKeys.keyHash, keyHash)).limit(1);
  const k = rows[0];
  if (!k) return null;
  const scopes = await db.select().from(apiKeyScopes).where(eq(apiKeyScopes.apiKeyId, k.id));
  const sc = scopes.map((s) => s.scope).filter(isApiKeyScope);
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    keySuffix: k.keySuffix,
    keyHash: k.keyHash,
    scope: sc[0] ?? "tether:read",
    scopes: sc.length ? sc : ["tether:read"],
    createdAt: k.createdAt,
    expiresAt: k.expiresAt,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdBy: k.createdBy
  };
}

export async function pgTouchApiKeyLastUsed(id: string, whenIso: string): Promise<void> {
  const db = await getDbAsync();
  await db.update(apiKeys).set({ lastUsedAt: whenIso }).where(eq(apiKeys.id, id));
}

/** Atomic rate-limit increment. Returns new count for the window. */
export async function pgIncrementRateLimit(
  apiKeyId: string,
  windowStartMs: number
): Promise<number> {
  const db = await getDbAsync();
  await db
    .insert(apiRateLimitBuckets)
    .values({ apiKeyId, bucketStartMs: windowStartMs, requestCount: 1 })
    .onConflictDoUpdate({
      target: [apiRateLimitBuckets.apiKeyId, apiRateLimitBuckets.bucketStartMs],
      set: { requestCount: sql`${apiRateLimitBuckets.requestCount} + 1` }
    });
  const rows = await db
    .select()
    .from(apiRateLimitBuckets)
    .where(
      and(
        eq(apiRateLimitBuckets.apiKeyId, apiKeyId),
        eq(apiRateLimitBuckets.bucketStartMs, windowStartMs)
      )
    )
    .limit(1);
  return rows[0]?.requestCount ?? 1;
}

export async function pgEnsureDefaultClient(name: string, createdBy: string | null): Promise<string> {
  const db = await getDbAsync();
  const existing = await db.select().from(apiClients).limit(1);
  if (existing[0]) return existing[0].id;
  const id = randomUUID();
  await db.insert(apiClients).values({
    id,
    name,
    isActive: true,
    createdBy,
    createdAt: new Date().toISOString()
  });
  return id;
}

/** Import helper: load full file-shaped store into PG (idempotent by key_hash). */
export async function pgImportApiKeyStoreFile(file: ApiKeyStoreFile): Promise<number> {
  let n = 0;
  for (const key of file.keys) {
    const exists = await pgFindApiKeyByHash(key.keyHash);
    if (exists) continue;
    try {
      await pgInsertApiKey(key);
      n += 1;
    } catch {
      // skip duplicates
    }
  }
  return n;
}

void numOrNull;
