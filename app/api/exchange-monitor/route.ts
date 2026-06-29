import { NextResponse } from "next/server";
import { getExchangeMonitor } from "@/lib/market";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getExchangeMonitor());
}
