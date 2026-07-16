import { NextResponse } from "next/server";
import { getSession } from "@/lib/authSession";
import { deleteNotification, markNotificationRead } from "@/lib/priceAlerts/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

function json(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), { status, headers: NO_STORE });
}

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);

  const { id } = await ctx.params;
  let body: { read?: boolean } = {};
  try {
    body = (await request.json()) as { read?: boolean };
  } catch {
    body = { read: true };
  }

  if (body.read === false) {
    return json({ error: "unsupported", message: "فقط علامت‌گذاری خوانده‌شده پشتیبانی می‌شود" }, 400);
  }

  const row = await markNotificationRead(id);
  if (!row) return json({ error: "not_found", message: "اعلان پیدا نشد" }, 404);
  return json({ notification: row });
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);
  if (session.r !== "admin") {
    return json({ error: "forbidden", message: "فقط ادمین می‌تواند اعلان را حذف کند" }, 403);
  }

  const { id } = await ctx.params;
  const ok = await deleteNotification(id);
  if (!ok) return json({ error: "not_found", message: "اعلان پیدا نشد" }, 404);
  return json({ ok: true });
}
