import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/market";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getDashboard());
}
