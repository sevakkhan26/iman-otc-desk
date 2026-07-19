import "server-only";

import { cookies } from "next/headers";
import { AUTH_COOKIE, type DeskRole, type SessionClaims } from "@/lib/auth";
import { getSessionRoleFromClaims, verifySessionToken } from "@/lib/authToken";
import { isIdentityStillValid } from "@/lib/userStore";

/**
 * Verify cookie signature + password/session epoch for the identity.
 * Env admin tokens always use pv=0. Env viewer + managed users check store epoch.
 * Deleted / disabled / rotated-password users return null.
 */
export async function getSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  const claims = await verifySessionToken(jar.get(AUTH_COOKIE)?.value);
  if (!claims) return null;

  const pv = typeof claims.pv === "number" && Number.isFinite(claims.pv) ? claims.pv : 0;
  const stillValid = await isIdentityStillValid(claims.u, claims.r, pv);
  if (!stillValid) return null;

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
