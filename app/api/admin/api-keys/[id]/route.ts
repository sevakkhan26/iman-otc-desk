import { NextResponse } from "next/server";
import { requireAdminClaims } from "@/lib/authSession";
import {
  ApiKeyServiceError,
  revokeApiKey,
  updateApiKeyScopes
} from "@/lib/apiKeys/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

type RouteCtx = { params: Promise<{ id: string }> };

function invalidId(id: string): boolean {
  return !id || !/^[a-f0-9]{16,64}$/i.test(id);
}

/** Admin-only: update scopes without rotating the secret. */
export async function PATCH(request: Request, context: RouteCtx) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  const { id } = await context.params;
  if (invalidId(id)) {
    return NextResponse.json(
      { ok: false, message: "شناسه کلید نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  let body: { scopes?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, message: "بدنه درخواست نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const key = await updateApiKeyScopes(id, body.scopes);
    if (!key) {
      return NextResponse.json(
        { ok: false, message: "کلید پیدا نشد" },
        { status: 404, headers: NO_STORE }
      );
    }
    return NextResponse.json({ ok: true, key }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ApiKeyServiceError) {
      const status =
        error.code === "STORAGE_NOT_CONFIGURED"
          ? 503
          : error.code === "KEY_REVOKED"
            ? 400
            : 400;
      return NextResponse.json(
        { ok: false, message: error.message, code: error.code },
        { status, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { ok: false, message: "به‌روزرسانی دسترسی‌ها ناموفق بود" },
      { status: 500, headers: NO_STORE }
    );
  }
}

/** Admin-only: revoke an API key. */
export async function DELETE(_request: Request, context: RouteCtx) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  const { id } = await context.params;
  if (invalidId(id)) {
    return NextResponse.json(
      { ok: false, message: "شناسه کلید نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const key = await revokeApiKey(id);
    if (!key) {
      return NextResponse.json(
        { ok: false, message: "کلید پیدا نشد" },
        { status: 404, headers: NO_STORE }
      );
    }
    return NextResponse.json({ ok: true, key }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof ApiKeyServiceError) {
      return NextResponse.json(
        { ok: false, message: error.message, code: error.code },
        { status: 503, headers: NO_STORE }
      );
    }
    return NextResponse.json(
      { ok: false, message: "لغو کلید ناموفق بود" },
      { status: 500, headers: NO_STORE }
    );
  }
}
