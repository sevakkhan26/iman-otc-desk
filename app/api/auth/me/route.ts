import { NextResponse } from "next/server";
import { getSessionRole } from "@/lib/authSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const role = await getSessionRole();
  if (!role) {
    return NextResponse.json({ error: "unauthorized", message: "ابتدا وارد شوید" }, { status: 401 });
  }
  return NextResponse.json({ role });
}