import { NextResponse } from "next/server";
import { getTetherMarket } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getTetherMarket());
}
