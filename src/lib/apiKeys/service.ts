/**
 * Market-data API key lifecycle: create / list / update scopes / revoke / authenticate / rate-limit.
 * Plaintext keys exist only at creation time in the HTTP response.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  isApiKeyStorageDurable,
  loadApiKeyStore,
  mutateApiKeyStore,
  resolveApiKeyStorageBackend
} from "@/lib/apiKeys/store";
import type {
  ApiKeyPublic,
  ApiKeyRecord,
  ApiKeyScope,
  ApiKeyStatus
} from "@/lib/apiKeys/types";
import {
  isApiKeyScope,
  normalizeRecordScopes
} from "@/lib/apiKeys/types";

export const API_KEY_PREFIX = "otc_live_";
/** @deprecated use scopes array — kept for import compatibility with tether-only tests */
export const API_KEY_SCOPE = "tether:read" as const;
export const API_KEY_RATE_LIMIT_PER_MINUTE = 60;
const RATE_WINDOW_MS = 60_000;
const KEY_RANDOM_BYTES = 32;

export type AuthFailureReason =
  | "missing"
  | "invalid"
  | "expired"
  | "revoked"
  | "rate_limited"
  | "forbidden_scope";

export class ApiKeyServiceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "ApiKeyServiceError";
    this.code = code;
  }
}

function hmacSecret(): string {
  return (
    process.env.TETHER_API_KEY_HMAC_SECRET?.trim() ||
    process.env.AUTH_TOKEN_SECRET?.trim() ||
    "otc-tether-api-key-v1-dev-only"
  );
}

export function hashApiKey(rawKey: string): string {
  return createHmac("sha256", hmacSecret()).update(rawKey, "utf8").digest("hex");
}

export function generateApiKeyPlaintext(): string {
  const body = randomBytes(KEY_RANDOM_BYTES).toString("base64url");
  return `${API_KEY_PREFIX}${body}`;
}

function keyHint(prefix: string, suffix: string): string {
  return `${prefix}…${suffix}`;
}

export function computeKeyStatus(record: ApiKeyRecord, nowMs: number = Date.now()): ApiKeyStatus {
  if (record.revokedAt) return "revoked";
  if (record.expiresAt) {
    const exp = Date.parse(record.expiresAt);
    if (Number.isFinite(exp) && exp <= nowMs) return "expired";
  }
  return "active";
}

export function parseAndValidateScopes(input: unknown): ApiKeyScope[] {
  if (!Array.isArray(input)) {
    throw new ApiKeyServiceError("INVALID_SCOPES", "حداقل یک سطح دسترسی باید انتخاب شود.");
  }
  const scopes = [...new Set(input.filter(isApiKeyScope))];
  if (!scopes.length) {
    throw new ApiKeyServiceError("INVALID_SCOPES", "حداقل یک سطح دسترسی باید انتخاب شود.");
  }
  return scopes;
}

export function toPublicApiKey(record: ApiKeyRecord, nowMs: number = Date.now()): ApiKeyPublic {
  const scopes = normalizeRecordScopes(record);
  return {
    id: record.id,
    name: record.name,
    keyHint: keyHint(record.keyPrefix, record.keySuffix),
    scope: scopes[0] ?? "tether:read",
    scopes,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    status: computeKeyStatus(record, nowMs),
    createdBy: record.createdBy
  };
}

function assertDurableStorage(): void {
  if (!isApiKeyStorageDurable()) {
    throw new ApiKeyServiceError(
      "STORAGE_NOT_CONFIGURED",
      resolveApiKeyStorageBackend() === "none" && process.env.VERCEL === "1"
        ? "ذخیره‌سازی پایدار کلید API روی Vercel در دسترس نیست. UPSTASH_REDIS_REST_URL و UPSTASH_REDIS_REST_TOKEN را تنظیم کنید."
        : "ذخیره‌سازی پایدار کلید API پیکربندی نشده است."
    );
  }
}

export async function listApiKeys(): Promise<ApiKeyPublic[]> {
  assertDurableStorage();
  const store = await loadApiKeyStore({ force: true });
  const now = Date.now();
  return store.keys
    .map((k) => toPublicApiKey(k, now))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function createApiKey(input: {
  name: string;
  expiresAt?: string | null;
  /** Defaults to tether:read when omitted (backward compatible). */
  scopes?: unknown;
  createdBy: string | null;
}): Promise<{ publicKey: ApiKeyPublic; plaintext: string }> {
  assertDurableStorage();
  const name = input.name.trim();
  if (!name || name.length < 2) {
    throw new ApiKeyServiceError("INVALID_NAME", "نام کلید الزامی است (حداقل ۲ کاراکتر).");
  }
  if (name.length > 80) {
    throw new ApiKeyServiceError("INVALID_NAME", "نام کلید حداکثر ۸۰ کاراکتر است.");
  }

  const scopes =
    input.scopes === undefined || input.scopes === null
      ? (["tether:read"] as ApiKeyScope[])
      : parseAndValidateScopes(input.scopes);

  let expiresAt: string | null = null;
  if (input.expiresAt) {
    const exp = Date.parse(input.expiresAt);
    if (!Number.isFinite(exp)) {
      throw new ApiKeyServiceError("INVALID_EXPIRY", "تاریخ انقضا نامعتبر است.");
    }
    if (exp <= Date.now()) {
      throw new ApiKeyServiceError("INVALID_EXPIRY", "تاریخ انقضا باید در آینده باشد.");
    }
    expiresAt = new Date(exp).toISOString();
  }

  const plaintext = generateApiKeyPlaintext();
  const keyHash = hashApiKey(plaintext);
  const id = randomBytes(16).toString("hex");
  const nowIso = new Date().toISOString();
  const keyPrefix = plaintext.slice(0, API_KEY_PREFIX.length + 8);
  const keySuffix = plaintext.slice(-4);

  const record: ApiKeyRecord = {
    id,
    name,
    keyPrefix,
    keySuffix,
    keyHash,
    scope: scopes[0],
    scopes,
    createdAt: nowIso,
    expiresAt,
    lastUsedAt: null,
    revokedAt: null,
    createdBy: input.createdBy
  };

  await mutateApiKeyStore((store) => {
    if (JSON.stringify(record).includes(plaintext)) {
      throw new ApiKeyServiceError("INTERNAL", "خطای داخلی ذخیره کلید");
    }
    store.keys.push(record);
  });

  return { publicKey: toPublicApiKey(record), plaintext };
}

/** Update scopes on an existing active key without rotating the secret. */
export async function updateApiKeyScopes(
  id: string,
  scopesInput: unknown
): Promise<ApiKeyPublic | null> {
  assertDurableStorage();
  const scopes = parseAndValidateScopes(scopesInput);
  let found: ApiKeyRecord | null = null;
  let wasRevoked = false;
  await mutateApiKeyStore((store) => {
    const key = store.keys.find((k) => k.id === id);
    if (!key) return;
    if (key.revokedAt) {
      wasRevoked = true;
      return;
    }
    key.scopes = scopes;
    key.scope = scopes[0];
    found = key;
  });
  if (wasRevoked) {
    throw new ApiKeyServiceError("KEY_REVOKED", "کلید لغو‌شده قابل ویرایش نیست.");
  }
  return found ? toPublicApiKey(found) : null;
}

export async function revokeApiKey(id: string): Promise<ApiKeyPublic | null> {
  assertDurableStorage();
  let found: ApiKeyRecord | null = null;
  await mutateApiKeyStore((store) => {
    const key = store.keys.find((k) => k.id === id);
    if (!key) return;
    if (!key.revokedAt) {
      key.revokedAt = new Date().toISOString();
    }
    found = key;
  });
  return found ? toPublicApiKey(found) : null;
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    if (ba.length !== bb.length || ba.length === 0) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export type AuthSuccess = {
  ok: true;
  keyId: string;
  name: string;
  scopes: ApiKeyScope[];
};

export type AuthResult = AuthSuccess | { ok: false; reason: AuthFailureReason };

/**
 * Authenticate Bearer token. Updates lastUsedAt and rate-limit counters.
 * Does not log or return the raw key.
 */
export async function authenticateApiKey(
  authorizationHeader: string | null
): Promise<AuthResult> {
  if (!authorizationHeader || !authorizationHeader.startsWith("Bearer ")) {
    return { ok: false, reason: "missing" };
  }
  const raw = authorizationHeader.slice("Bearer ".length).trim();
  if (!raw || !raw.startsWith(API_KEY_PREFIX) || raw.length < API_KEY_PREFIX.length + 20) {
    return { ok: false, reason: "invalid" };
  }

  if (!isApiKeyStorageDurable()) {
    return { ok: false, reason: "invalid" };
  }

  const presentedHash = hashApiKey(raw);
  const store = await loadApiKeyStore({ force: true });
  const match = store.keys.find((k) => safeEqualHex(k.keyHash, presentedHash));
  if (!match) {
    return { ok: false, reason: "invalid" };
  }

  const status = computeKeyStatus(match);
  if (status === "revoked") return { ok: false, reason: "revoked" };
  if (status === "expired") return { ok: false, reason: "expired" };

  const scopes = normalizeRecordScopes(match);

  const now = Date.now();
  const windowStart = Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
  let limited = false;
  await mutateApiKeyStore((s) => {
    const rl = s.rateLimits[match.id];
    if (!rl || rl.windowStartMs !== windowStart) {
      s.rateLimits[match.id] = { windowStartMs: windowStart, count: 1 };
    } else {
      rl.count += 1;
      if (rl.count > API_KEY_RATE_LIMIT_PER_MINUTE) {
        limited = true;
      }
    }
    for (const [kid, entry] of Object.entries(s.rateLimits)) {
      if (entry.windowStartMs < windowStart - RATE_WINDOW_MS * 2) {
        delete s.rateLimits[kid];
      }
    }
    if (!limited) {
      const key = s.keys.find((k) => k.id === match.id);
      if (key) key.lastUsedAt = new Date(now).toISOString();
    }
  });

  if (limited) return { ok: false, reason: "rate_limited" };

  return { ok: true, keyId: match.id, name: match.name, scopes };
}

/** Ensure an authenticated key holds the required scope. */
export function requireApiKeyScope(
  auth: AuthSuccess,
  required: ApiKeyScope
): AuthResult {
  if (!auth.scopes.includes(required)) {
    return { ok: false, reason: "forbidden_scope" };
  }
  return auth;
}

export function assertNoPlaintextInStore(keys: ApiKeyRecord[], plaintext: string): void {
  for (const k of keys) {
    if (k.keyHash === plaintext || k.keyPrefix === plaintext || JSON.stringify(k).includes(plaintext)) {
      throw new Error("plaintext key leaked into store");
    }
  }
}
