import { NextRequest, NextResponse } from "next/server";
import { INVALID_CREDENTIALS_MESSAGE } from "@/lib/auth";
import {
  AUTH_COOKIE_NAME,
  COOKIE_MAX_AGE_S,
  NO_STORE_HEADERS,
  authCookieSetOptions
} from "@/lib/authCookie";
import { verifyCredentials } from "@/lib/authCredentials";
import { createSessionToken } from "@/lib/authToken.server";
import { probeArzinjaQuote, probeDomesticHealth } from "@/lib/providers/domestic";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Same region preference as tether-market so Arzinja/domestic probes match production fetch path
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

/**
 * Unauthenticated connectivity probes (existing /api/auth/login path, GET only).
 *   ?probe=arzinja  — single Arzinja check
 *   ?probe=domestic — full multi-provider health (isolated)
 */
export async function GET(request: NextRequest) {
  const probe = request.nextUrl.searchParams.get("probe");
  if (probe === "domestic") {
    const report = await probeDomesticHealth();
    const healthy = report.providers.filter(
      (p) => p.status === "available" || p.status === "degraded"
    ).length;
    return NextResponse.json(
      {
        ok: healthy > 0,
        commit: report.commit ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        region: report.region,
        vercel: report.vercel,
        healthyCount: healthy,
        total: report.providers.length,
        providers: report.providers
      },
      { headers: NO_STORE_HEADERS }
    );
  }
  if (probe === "arzinja") {
    const arzinja = await probeArzinjaQuote();
    return NextResponse.json(
      {
        ok: arzinja.sourceStatus === "available" || arzinja.sourceStatus === "degraded",
        commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
        arzinja
      },
      { headers: NO_STORE_HEADERS }
    );
  }
  return NextResponse.json(
    {
      ok: false,
      message: "Use POST to login, or GET ?probe=arzinja|domestic for connectivity check"
    },
    { status: 400, headers: NO_STORE_HEADERS }
  );
}

export async function POST(request: NextRequest) {
  let body: { username?: unknown; password?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    // fall through to the credential check with empty body
  }

  const identity = await verifyCredentials(body.username, body.password);
  if (!identity) {
    return NextResponse.json(
      { ok: false, message: INVALID_CREDENTIALS_MESSAGE },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  const token = createSessionToken(
    identity.username,
    identity.role,
    identity.passwordVersion
  );
  if (!token) {
    return NextResponse.json(
      { ok: false, message: INVALID_CREDENTIALS_MESSAGE },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  // Never put the session token in JSON — only in HttpOnly cookie
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  response.cookies.set(AUTH_COOKIE_NAME, token, authCookieSetOptions(request, COOKIE_MAX_AGE_S));
  return response;
}
