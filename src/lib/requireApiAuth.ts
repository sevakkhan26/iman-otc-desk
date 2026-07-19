/**
 * Node route-handler session gate (signature + viewer password epoch).
 * Middleware only checks cookie signature; use this so rotated viewer passwords
 * cannot keep calling data APIs.
 */
import "server-only";

import { NextResponse } from "next/server";
import type { SessionClaims } from "@/lib/auth";
import { getSession } from "@/lib/authSession";

const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private"
} as const;

export function unauthorizedJson(message = "ابتدا وارد شوید") {
  return NextResponse.json(
    { error: "unauthorized", message },
    { status: 401, headers: NO_STORE }
  );
}

export function forbiddenJson(message = "دسترسی مجاز نیست") {
  return NextResponse.json({ error: "forbidden", message }, { status: 403, headers: NO_STORE });
}

/** Returns session or a 401 Response. */
export async function requireApiSession(): Promise<SessionClaims | NextResponse> {
  const session = await getSession();
  if (!session) return unauthorizedJson();
  return session;
}

export function isSession(value: SessionClaims | NextResponse): value is SessionClaims {
  return !(value instanceof NextResponse);
}
