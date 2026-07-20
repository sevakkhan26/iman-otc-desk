/** Public metadata for an API key (never includes hash or full plaintext). */
export type ApiKeyStatus = "active" | "expired" | "revoked";

/** Independent read scopes — one key may hold any non-empty subset. */
export type ApiKeyScope = "tether:read" | "usd:read" | "aed:read" | "gold:read";

export const ALL_API_KEY_SCOPES: readonly ApiKeyScope[] = [
  "tether:read",
  "usd:read",
  "aed:read",
  "gold:read"
] as const;

export const API_KEY_SCOPE_LABELS: Record<ApiKeyScope, string> = {
  "tether:read": "قیمت تتر",
  "usd:read": "قیمت دلار",
  "aed:read": "قیمت درهم",
  "gold:read": "قیمت طلا"
};

export type ApiKeyPublic = {
  id: string;
  name: string;
  /** e.g. otc_live_ab12…x9f3 */
  keyHint: string;
  /**
   * Legacy single-scope field for older clients.
   * Always equals scopes[0] when scopes is non-empty (prefer `scopes`).
   */
  scope: ApiKeyScope;
  /** Full granted scopes (one or more). */
  scopes: ApiKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: ApiKeyStatus;
  createdBy: string | null;
};

/** Stored record — only keyHash, never plaintext. */
export type ApiKeyRecord = {
  id: string;
  name: string;
  keyPrefix: string;
  keySuffix: string;
  keyHash: string;
  /**
   * Legacy field: single scope on keys created before multi-scope.
   * Prefer `scopes` when present.
   */
  scope?: ApiKeyScope | "tether:read";
  /** Multi-scope list. Absent on legacy records → treat as [scope] or [tether:read]. */
  scopes?: ApiKeyScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdBy: string | null;
};

export type ApiKeyStoreFile = {
  version: 1;
  keys: ApiKeyRecord[];
  rateLimits: Record<string, { windowStartMs: number; count: number }>;
  updatedAt: string | null;
};

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return (
    value === "tether:read" ||
    value === "usd:read" ||
    value === "aed:read" ||
    value === "gold:read"
  );
}

/** Normalize legacy single-scope records to a scopes array. */
export function normalizeRecordScopes(record: ApiKeyRecord): ApiKeyScope[] {
  if (Array.isArray(record.scopes) && record.scopes.length > 0) {
    const unique = [...new Set(record.scopes.filter(isApiKeyScope))];
    if (unique.length) return unique;
  }
  if (isApiKeyScope(record.scope)) return [record.scope];
  // Historical default: all pre-multi-scope keys were tether-only
  return ["tether:read"];
}
