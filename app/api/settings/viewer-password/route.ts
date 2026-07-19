import { NextResponse } from "next/server";
import { requireAdminClaims } from "@/lib/authSession";
import {
  getViewerAuthPublicMeta,
  setViewerPasswordFromAdmin,
  VIEWER_PASSWORD_MIN_LEN
} from "@/lib/viewerAuthStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

/** Admin-only: change viewer password (hash on disk; invalidates existing viewer sessions). */
export async function POST(request: Request) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  let body: { newPassword?: unknown; confirmPassword?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, message: "بدنه درخواست نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  const newPassword = typeof body.newPassword === "string" ? body.newPassword : "";
  const confirmPassword = typeof body.confirmPassword === "string" ? body.confirmPassword : "";

  if (!newPassword || !confirmPassword) {
    return NextResponse.json(
      { ok: false, message: "رمز جدید و تکرار آن را وارد کنید" },
      { status: 400, headers: NO_STORE }
    );
  }

  if (newPassword !== confirmPassword) {
    return NextResponse.json(
      { ok: false, message: "رمز جدید و تکرار آن یکسان نیستند" },
      { status: 400, headers: NO_STORE }
    );
  }

  const result = await setViewerPasswordFromAdmin(newPassword, admin.u);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message, minLength: VIEWER_PASSWORD_MIN_LEN },
      { status: 400, headers: NO_STORE }
    );
  }

  const meta = await getViewerAuthPublicMeta();
  return NextResponse.json(
    {
      ok: true,
      message: "رمز viewer ذخیره شد. نشست‌های قبلی viewer باطل شدند.",
      viewerAuth: meta
    },
    { headers: NO_STORE }
  );
}

export async function GET() {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }
  return NextResponse.json(
    { viewerAuth: await getViewerAuthPublicMeta() },
    { headers: NO_STORE }
  );
}
