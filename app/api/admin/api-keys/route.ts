import { NextResponse } from "next/server";
import { requireAdminClaims } from "@/lib/authSession";
import {
  ApiKeyServiceError,
  createApiKey,
  listApiKeys
} from "@/lib/apiKeys/service";
import { isApiKeyStorageDurable, resolveApiKeyStorageBackend } from "@/lib/apiKeys/store";
import { ALL_API_KEY_SCOPES, API_KEY_SCOPE_LABELS } from "@/lib/apiKeys/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

/** Admin-only: list API keys (masked) + storage diagnostics. */
export async function GET() {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  try {
    const keys = await listApiKeys();
    return NextResponse.json(
      {
        keys,
        scopeOptions: ALL_API_KEY_SCOPES.map((id) => ({
          id,
          label: API_KEY_SCOPE_LABELS[id]
        })),
        storage: {
          backend: resolveApiKeyStorageBackend(),
          durable: isApiKeyStorageDurable()
        }
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    const message =
      error instanceof ApiKeyServiceError
        ? error.message
        : "بارگذاری کلیدها ناموفق بود";
    return NextResponse.json(
      { error: "storage_error", message, keys: [] },
      { status: 503, headers: NO_STORE }
    );
  }
}

/** Admin-only: create a market-data API key. Plaintext returned once. */
export async function POST(request: Request) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  let body: { name?: unknown; expiresAt?: unknown; scopes?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, message: "بدنه درخواست نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const result = await createApiKey({
      name: typeof body.name === "string" ? body.name : "",
      expiresAt:
        body.expiresAt === null || body.expiresAt === undefined || body.expiresAt === ""
          ? null
          : typeof body.expiresAt === "string"
            ? body.expiresAt
            : null,
      scopes: body.scopes,
      createdBy: admin.u
    });

    return NextResponse.json(
      {
        ok: true,
        key: result.publicKey,
        plaintext: result.plaintext,
        warning:
          "این کلید فقط یک‌بار نمایش داده می‌شود. آن را کپی و در جای امن نگه دارید."
      },
      { headers: NO_STORE }
    );
  } catch (error) {
    if (error instanceof ApiKeyServiceError) {
      const status = error.code === "STORAGE_NOT_CONFIGURED" ? 503 : 400;
      return NextResponse.json(
        { ok: false, message: error.message, code: error.code },
        { status, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { ok: false, message: "ایجاد کلید ناموفق بود" },
      { status: 500, headers: NO_STORE }
    );
  }
}
