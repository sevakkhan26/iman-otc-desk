import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/authSession";
import { getSettings, patchSettings, toPublicSettings } from "@/lib/settings";
import type { SettingsPatch } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const role = await requireAdminSession();
  if (!role) {
    return NextResponse.json({ error: "forbidden", message: "دسترسی مجاز نیست" }, { status: 403 });
  }
  return NextResponse.json(toPublicSettings(await getSettings()));
}

export async function PATCH(request: Request) {
  const role = await requireAdminSession();
  if (!role) {
    return NextResponse.json({ error: "forbidden", message: "دسترسی مجاز نیست" }, { status: 403 });
  }
  const patch = (await request.json()) as SettingsPatch;
  return NextResponse.json(await patchSettings(patch));
}
