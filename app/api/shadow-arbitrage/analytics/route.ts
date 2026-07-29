import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import { computeAnalytics } from "@/lib/shadowArbitrage";
import { SHADOW_BANNER } from "@/lib/shadowArbitrage/config";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
} as const;

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
    { status: 200, headers: NO_STORE }
  );
}
