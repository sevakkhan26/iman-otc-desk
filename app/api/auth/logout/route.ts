import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function cookieSecure(request: NextRequest): boolean {
  return process.env.NODE_ENV === "production" || request.nextUrl.protocol === "https:";
}

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  response.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
    secure: cookieSecure(request)
  });
  return response;
}