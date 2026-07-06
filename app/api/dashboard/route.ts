import { NextResponse } from "next/server";
import { getDashboard } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getDashboard());
}
