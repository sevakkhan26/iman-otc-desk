import { NextResponse } from "next/server";
import { requireAdminClaims } from "@/lib/authSession";
import { listUserAccounts, resetUserPassword } from "@/lib/userStore";
import { VIEWER_PASSWORD_MIN_LEN } from "@/lib/viewerAuthStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Admin-only: set / reset password for env viewer or any managed user.
 * Env admin password cannot be changed here (stays in .env).
 * Bumps session epoch so old cookies for that user become invalid.
 */
export async function POST(request: Request, context: RouteContext) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  const { id: rawId } = await context.params;
  const id = decodeURIComponent(rawId || "");

  let body: { newPassword?: unknown; confirmPassword?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, message: "بدنه درخواست نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  const result = await resetUserPassword(
    id,
    {
      newPassword: typeof body.newPassword === "string" ? body.newPassword : "",
      confirmPassword: typeof body.confirmPassword === "string" ? body.confirmPassword : ""
    },
    admin.u
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        message: result.message,
        minLength: VIEWER_PASSWORD_MIN_LEN
      },
      { status: result.status ?? 400, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      message: "رمز عبور ذخیره شد. نشست‌های قبلی این کاربر باطل شدند.",
      user: result.user,
      users: await listUserAccounts()
    },
    { headers: NO_STORE }
  );
}
