import { NextResponse } from "next/server";
import { getTetherMarket } from "@/lib/market";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Arzinja (api-v2.arzinja.ir / Arvan IR) is often unreachable from fra1/EU; sin1 works.
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  return NextResponse.json(await getTetherMarket());
}
