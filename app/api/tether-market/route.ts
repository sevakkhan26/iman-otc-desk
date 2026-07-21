import { NextResponse } from "next/server";
import { getTetherMarket } from "@/lib/market";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { serveSwr, withDeadline } from "@/lib/swrServe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Arzinja (api-v2.arzinja.ir / Arvan IR) is often unreachable from fra1/EU; sin1 works.
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  "content-type": "application/json; charset=utf-8"
} as const;

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  try {
    // Process SWR: instant if warm; cold path hard-capped
    const body = await serveSwr(
      "api:tether-market",
      20_000,
      10 * 60_000,
      () => withDeadline(getTetherMarket(), 12_000, "tether-market")
    );
    return new NextResponse(JSON.stringify(body), { status: 200, headers: NO_STORE });
  } catch (error) {
    console.error("[tether-market]", error instanceof Error ? error.message : error);
    return new NextResponse(
      JSON.stringify({
        error: "unavailable",
        message: error instanceof Error ? error.message : "منبع در دسترس نیست"
      }),
      { status: 503, headers: NO_STORE }
    );
  }
}
