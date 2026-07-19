import { NextResponse } from "next/server";
import { requireAdminClaims } from "@/lib/authSession";
import type { DeskRole } from "@/lib/auth";
import {
  createManagedUser,
  listUserAccounts,
  USERNAME_MAX_LEN,
  USERNAME_MIN_LEN
} from "@/lib/userStore";
import { VIEWER_PASSWORD_MIN_LEN } from "@/lib/viewerAuthStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

/** Admin-only: list bootstrap + managed users (no password hashes). */
export async function GET() {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  const users = await listUserAccounts();
  return NextResponse.json(
    {
      users,
      limits: {
        usernameMin: USERNAME_MIN_LEN,
        usernameMax: USERNAME_MAX_LEN,
        passwordMin: VIEWER_PASSWORD_MIN_LEN
      }
    },
    { headers: NO_STORE }
  );
}

/** Admin-only: create a managed user with initial password. */
export async function POST(request: Request) {
  const admin = await requireAdminClaims();
  if (!admin) {
    return NextResponse.json(
      { error: "forbidden", message: "دسترسی مجاز نیست" },
      { status: 403, headers: NO_STORE }
    );
  }

  let body: {
    username?: unknown;
    password?: unknown;
    confirmPassword?: unknown;
    role?: unknown;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, message: "بدنه درخواست نامعتبر است" },
      { status: 400, headers: NO_STORE }
    );
  }

  const role: DeskRole | undefined =
    body.role === "admin" ? "admin" : body.role === "viewer" ? "viewer" : undefined;

  const result = await createManagedUser(
    {
      username: typeof body.username === "string" ? body.username : "",
      password: typeof body.password === "string" ? body.password : "",
      confirmPassword: typeof body.confirmPassword === "string" ? body.confirmPassword : "",
      role
    },
    admin.u
  );

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, message: result.message },
      { status: 400, headers: NO_STORE }
    );
  }

  return NextResponse.json(
    {
      ok: true,
      message: "کاربر ایجاد شد",
      user: result.user,
      users: await listUserAccounts()
    },
    { status: 201, headers: NO_STORE }
  );
}
