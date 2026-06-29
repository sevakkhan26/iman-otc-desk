import { NextResponse } from "next/server";
import { getSettings, patchSettings, toPublicSettings } from "@/lib/settings";
import type { SettingsPatch } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json(toPublicSettings(await getSettings()));
}

export async function PATCH(request: Request) {
  const patch = (await request.json()) as SettingsPatch;
  return NextResponse.json(await patchSettings(patch));
}
