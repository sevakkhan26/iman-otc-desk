import { NextResponse } from "next/server";
import { getImpactNews, getSettings } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(await getImpactNews(await getSettings()));
}
