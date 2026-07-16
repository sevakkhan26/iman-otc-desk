import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE_NAME, NO_STORE_HEADERS, authCookieClearOptions } from "@/lib/authCookie";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true }, { headers: NO_STORE_HEADERS });
  // Expire the exact same cookie identity that login sets (protocol-aware Secure)
  response.cookies.set(AUTH_COOKIE_NAME, "", authCookieClearOptions(request));
  return response;
}
