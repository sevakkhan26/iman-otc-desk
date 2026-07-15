import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/market";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Keep domestic providers (incl. Arzinja) on a region that can reach Arvan IR edges.
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

export async function GET() {
  return NextResponse.json(await getDashboard());
}
