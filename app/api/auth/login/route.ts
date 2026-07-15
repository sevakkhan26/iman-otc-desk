import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, COOKIE_MAX_AGE_S, INVALID_CREDENTIALS_MESSAGE } from "@/lib/auth";
import { verifyCredentials } from "@/lib/authCredentials";
import { createSessionToken } from "@/lib/authToken.server";
import { probeArzinjaQuote } from "@/lib/providers/domestic";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Same region preference as tether-market so Arzinja probe matches production fetch path
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

function cookieSecure(request: NextRequest): boolean {
  return process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
}

/**
 * Unauthenticated Arzinja connectivity probe (existing /api/auth/login path, GET only).
 * Query: ?probe=arzinja
 * Returns live buy/sell/mid from official API when reachable from this serverless region.
 */
export async function GET(request: NextRequest) {
  if (request.nextUrl.searchParams.get("probe") !== "arzinja") {
    return NextResponse.json(
      { ok: false, message: "Use POST to login, or GET ?probe=arzinja for connectivity check" },
      { status: 400 }
    );
  }
  const arzinja = await probeArzinjaQuote();
  return NextResponse.json({
    ok: arzinja.sourceStatus === "available" || arzinja.sourceStatus === "degraded",
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    arzinja
  });
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