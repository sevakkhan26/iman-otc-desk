import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, sessionTokenForRole } from "@/lib/auth";
import { verifyCredentials } from "@/lib/authCredentials";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60; // 30 days

export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // fall through to the credential check with empty body
  }

  const role = verifyCredentials(body.username, body.password);
  if (!role) {
    return NextResponse.json({ ok: false, message: "نام کاربری یا رمز عبور اشتباه است" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, role });
  response.cookies.set(AUTH_COOKIE, sessionTokenForRole(role), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
    // secure only when actually served over https (the internal prod server runs on http://127.0.0.1)
    secure: request.nextUrl.protocol === "https:"
  });
  return response;
}
