import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/authCookie";
import { getSessionRole } from "@/lib/authSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const role = await getSessionRole();
  if (!role) {
    return NextResponse.json(
      { error: "unauthorized", message: "ابتدا وارد شوید" },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }
  return NextResponse.json({ role }, { headers: NO_STORE_HEADERS });
}
