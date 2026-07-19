import "server-only";

import { cookies } from "next/headers";
import { AUTH_COOKIE, type DeskRole, type SessionClaims } from "@/lib/auth";
import { getSessionRoleFromClaims, verifySessionToken } from "@/lib/authToken";
import { getViewerSessionEpoch } from "@/lib/viewerAuthStore";

/**
 * Verify cookie signature + viewer password epoch (file/env override).
 * Admin sessions ignore epoch. Old viewer cookies after panel password change return null.
 */
export async function getSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const claims = await verifySessionToken(jar.get(AUTH_COOKIE)?.value);
  if (!claims) return null;

  if (claims.r === "viewer") {
    const epoch = await getViewerSessionEpoch();
    const pv = typeof claims.pv === "number" && Number.isFinite(claims.pv) ? claims.pv : 0;
    if (pv !== epoch) return null;
  }

  return claims;
}

export async function getSessionRole(): Promise<DeskRole | null> {
  const session = await getSession();
  return getSessionRoleFromClaims(session);
}

export async function requireAdminSession(): Promise<DeskRole | null> {
  const role = await getSessionRole();
  return role === "admin" ? role : null;
}

export async function requireAdminClaims(): Promise<SessionClaims | null> {
  const session = await getSession();
  return session?.r === "admin" ? session : null;
}
