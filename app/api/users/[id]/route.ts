import { NextResponse } from "next/server";
import { requireAdminClaims } from "@/lib/authSession";
import {
  deleteManagedUser,
  listUserAccounts,
  setManagedUserEnabled
} from "@/lib/userStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

type RouteContext = { params: Promise<{ id: string }> };

/** Admin-only: enable/disable managed user. */
export async function PATCH(request: Request, context: RouteContext) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  const { id: rawId } = await context.params;
  const id = decodeURIComponent(rawId || "");

  let body: { enabled?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, message: "بدنه درخواست نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  if (typeof body.enabled !== "boolean") {
    return NextResponse.json(
      { ok: false, message: "فیلد enabled باید true یا false باشد" },
      { status: 400, headers: NO_STORE }
    );
  }

  const result = await setManagedUserEnabled(id, body.enabled, admin.u);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: result.status ?? 400, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      message: body.enabled ? "کاربر فعال شد" : "کاربر غیرفعال شد",
      user: result.user,
      users: await listUserAccounts()
    },
    { headers: NO_STORE }
  );
}

/** Admin-only: delete a managed user (not env bootstrap accounts). */
export async function DELETE(_request: Request, context: RouteContext) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  const { id: rawId } = await context.params;
  const id = decodeURIComponent(rawId || "");

  const result = await deleteManagedUser(id);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: result.status ?? 400, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      message: "کاربر حذف شد",
      users: await listUserAccounts()
    },
    { headers: NO_STORE }
  );
}
