import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import { computeAnalytics } from "@/lib/shadowArbitrage";
import { SHADOW_BANNER } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const analytics = await computeAnalytics();
  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      shadowMode: true,
      serverNow: new Date().toISOString(),
      analytics
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
