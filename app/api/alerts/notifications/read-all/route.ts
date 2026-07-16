import { NextResponse } from "next/server";
import { getSession } from "@/lib/authSession";
import { markAllNotificationsRead } from "@/lib/priceAlerts/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

function json(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), { status, headers: NO_STORE });
}

export async function POST() {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);
  const count = await markAllNotificationsRead();
  return json({ ok: true, marked: count });
}
