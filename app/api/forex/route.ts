import { NextResponse } from "next/server";
import { getForexEvents } from "@/lib/providers/forex";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  const settings = await getSettings();
  return NextResponse.json(await getForexEvents(settings));
}
