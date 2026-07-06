import { NextResponse } from "next/server";
import { getSettings, patchSettings, publicSettings, type Settings } from "@/lib/data";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(publicSettings(await getSettings()));
}

export async function PATCH(request: Request) {
  return NextResponse.json(await patchSettings((await request.json()) as Partial<Settings>));
}
