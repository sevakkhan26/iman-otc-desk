import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/market";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Keep domestic providers (incl. Arzinja) on a region that can reach Arvan IR edges.
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  return NextResponse.json(await getDashboard());
}
