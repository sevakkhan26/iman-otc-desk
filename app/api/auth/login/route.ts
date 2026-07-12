import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, COOKIE_MAX_AGE_S, INVALID_CREDENTIALS_MESSAGE } from "@/lib/auth";
import { verifyCredentials } from "@/lib/authCredentials";
import { createSessionToken } from "@/lib/authToken.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cookieSecure(request: NextRequest): boolean {
  return process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
}

export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // fall through to the credential check with empty body
  }

  const identity = verifyCredentials(body.username, body.password);
  if (!identity) {
    return NextResponse.json({ ok: false, message: INVALID_CREDENTIALS_MESSAGE }, { status: 401 });
  }

  const token = createSessionToken(identity.username, identity.role);
  if (!token) {
    return NextResponse.json({ ok: false, message: INVALID_CREDENTIALS_MESSAGE }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_S,
    secure: cookieSecure(request)
  });
  return response;
}