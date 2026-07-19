import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/authSession";
import { getSettings, patchSettings, toPublicSettings } from "@/lib/settings";
import type { SettingsPatch } from "@/lib/types";
import { getViewerAuthPublicMeta } from "@/lib/viewerAuthStore";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const role = await requireAdminSession();
  if (!role) {
    return NextResponse.json({ error: "forbidden", message: "دسترسی مجاز نیست" }, { status: 403 });
  }
  const settings = toPublicSettings(await getSettings());
  const viewerAuth = await getViewerAuthPublicMeta();
  return NextResponse.json({ ...settings, viewerAuth });
}

export async function PATCH(request: Request) {
  const role = await requireAdminSession();
  if (!role) {
    return NextResponse.json({ error: "forbidden", message: "دسترسی مجاز نیست" }, { status: 403 });
  }
  const patch = (await request.json()) as SettingsPatch;
  const settings = await patchSettings(patch);
  const viewerAuth = await getViewerAuthPublicMeta();
  return NextResponse.json({ ...settings, viewerAuth });
}
