import { NextResponse } from "next/server";
import { getImpactNews } from "@/lib/providers/news";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const settings = await getSettings();
  return NextResponse.json(await getImpactNews(settings));
}
