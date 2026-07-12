import "server-only";

import { cookies } from "next/headers";
import { AUTH_COOKIE, type DeskRole, type SessionClaims } from "@/lib/auth";
import { getSessionRoleFromClaims, verifySessionToken } from "@/lib/authToken";

export async function getSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  return verifySessionToken(jar.get(AUTH_COOKIE)?.value);
}

export async function getSessionRole(): Promise<DeskRole | null> {
  const session = await getSession();
  return getSessionRoleFromClaims(session);
}

export async function requireAdminSession(): Promise<DeskRole | null> {
  const role = await getSessionRole();
  return role === "admin" ? role : null;
}