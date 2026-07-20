import { NextResponse } from "next/server";
import {
  authenticateApiKey,
  requireApiKeyScope,
  type AuthResult,
  type AuthSuccess
} from "@/lib/apiKeys/service";
import type { ApiKeyScope } from "@/lib/apiKeys/types";

export const V1_NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  "content-type": "application/json; charset=utf-8"
} as const;

export function v1JsonError(status: number, error: string, message: string) {
  return new NextResponse(JSON.stringify({ error, message }), {
    status,
    headers: V1_NO_STORE
  });
}

export function v1JsonOk(body: unknown) {
  return new NextResponse(JSON.stringify(body), {
    status: 200,
    headers: V1_NO_STORE
  });
}

export function authFailureResponse(auth: Extract<AuthResult, { ok: false }>) {
  if (auth.reason === "missing" || auth.reason === "invalid") {
    return v1JsonError(401, "unauthorized", "کلید API نامعتبر یا موجود نیست");
  }
  if (auth.reason === "expired" || auth.reason === "revoked") {
    return v1JsonError(403, "forbidden", "کلید API منقضی یا لغو شده است");
  }
  if (auth.reason === "rate_limited") {
    return v1JsonError(429, "rate_limited", "تعداد درخواست بیش از حد مجاز است");
  }
  if (auth.reason === "forbidden_scope") {
    return v1JsonError(403, "forbidden", "این کلید به این مجموعه داده دسترسی ندارد");
  }
  return v1JsonError(401, "unauthorized", "کلید API نامعتبر یا موجود نیست");
}

/** Authenticate Bearer key and require a specific scope. */
export async function authorizeV1Request(
  request: Request,
  requiredScope: ApiKeyScope
): Promise<AuthSuccess | NextResponse> {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  if (!auth.ok) return authFailureResponse(auth);
  const scoped = requireApiKeyScope(auth, requiredScope);
  if (!scoped.ok) return authFailureResponse(scoped);
  return scoped;
}

/** Authenticate only (for combined market-prices). */
export async function authenticateV1Request(
  request: Request
): Promise<AuthSuccess | NextResponse> {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  if (!auth.ok) return authFailureResponse(auth);
  return auth;
}
