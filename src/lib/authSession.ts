import "server-only";

import { cookies } from "next/headers";
import { AUTH_COOKIE, type DeskRole, getRoleFromCookie } from "@/lib/auth";

export async function getSessionRole(): Promise<DeskRole | null> {
  const jar = await cookies();
  return getRoleFromCookie(jar.get(AUTH_COOKIE)?.value);
}

export async function requireAdminSession(): Promise<DeskRole | null> {
  const role = await getSessionRole();
  return role === "admin" ? role : null;
}