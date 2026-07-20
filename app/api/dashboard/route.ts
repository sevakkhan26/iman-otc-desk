import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/market";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Keep domestic providers (incl. Arzinja) on a region that can reach Arvan IR edges.
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  "content-type": "application/json; charset=utf-8"
} as const;

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  const body = await getDashboard();
  return new NextResponse(JSON.stringify(body), { status: 200, headers: NO_STORE });
}
