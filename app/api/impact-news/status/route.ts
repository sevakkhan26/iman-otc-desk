import { NextResponse } from "next/server";
import { getImpactNewsStatus } from "@/lib/providers/news";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

/** Safe non-secret diagnostics for Impact News providers. */
export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  const settings = await getSettings();
  const status = await getImpactNewsStatus(settings);
  return NextResponse.json(status, {
    headers: { "Cache-Control": "no-store, max-age=0" }
  });
}
