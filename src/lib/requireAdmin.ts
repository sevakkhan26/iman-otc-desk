import "server-only";

import { NextResponse } from "next/server";
import type { SessionClaims } from "@/lib/auth";
import { forbiddenJson, isSession, requireApiSession } from "@/lib/requireApiAuth";

/** Admin-only API gate. */
export async function requireAdminSession(): Promise<SessionClaims | NextResponse> {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  if (session.r !== "admin") return forbiddenJson("فقط مدیر سیستم");
  return session;
}
