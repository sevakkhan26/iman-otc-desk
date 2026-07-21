import { NextResponse } from "next/server";
import { getForexEvents } from "@/lib/providers/forex";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { getSettings } from "@/lib/settings";
import { serveSwr } from "@/lib/swrServe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  try {
    // No hard deadline — getForexEvents serves disk/memory cache immediately
    // and refreshes faireconomy calendar in the background.
    const body = await serveSwr("api:forex", 30_000, 24 * 60 * 60_000, async () => {
      const settings = await getSettings();
      return getForexEvents(settings);
    });
    return NextResponse.json(body);
  } catch (error) {
    console.error("[forex]", error instanceof Error ? error.message : error);
    return NextResponse.json(
      {
        events: [],
        sourceStatus: "unavailable",
        lastUpdated: null,
        message: "داده فارکس موقتاً در دسترس نیست — دوباره تلاش کنید",
        serverNow: new Date().toISOString()
      },
      { status: 200 }
    );
  }
}
