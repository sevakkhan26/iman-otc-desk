import { NextResponse } from "next/server";
import { getSettings, intelligenceState } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await intelligenceState(await getSettings()));
}
