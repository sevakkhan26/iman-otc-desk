import { NextResponse } from "next/server";
import { getTetherMarket } from "@/lib/market";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Arzinja (api-v2.arzinja.ir / Arvan IR) is often unreachable from fra1/EU; sin1 works.
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

export async function GET() {
  return NextResponse.json(await getTetherMarket());
}
