import { NextResponse } from "next/server";
import { getSession } from "@/lib/authSession";
import { patchPriceAlert, removePriceAlert } from "@/lib/priceAlerts/service";
import type { CreateAlertInput } from "@/lib/priceAlerts/service";

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
  if (session.r !== "admin") {
    return json({ error: "forbidden", message: "فقط ادمین می‌تواند هشدار را ویرایش کند" }, 403);
  }

  const { id } = await ctx.params;
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "invalid_json", message: "بدنه درخواست نامعتبر است" }, 400);
  }

  try {
    const patch = body as Partial<CreateAlertInput> & { enabled?: boolean };
    const alert = await patchPriceAlert(id, patch, session.u);
    if (!alert) return json({ error: "not_found", message: "هشدار پیدا نشد" }, 404);
    return json({ alert });
  } catch (error) {
    const message = error instanceof Error ? error.message : "ویرایش ناموفق بود";
    return json({ error: "validation", message }, 400);
  }
}

export async function DELETE(_request: Request, ctx: Ctx) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);
  if (session.r !== "admin") {
    return json({ error: "forbidden", message: "فقط ادمین می‌تواند هشدار را حذف کند" }, 403);
  }

  const { id } = await ctx.params;
  const ok = await removePriceAlert(id);
  if (!ok) return json({ error: "not_found", message: "هشدار پیدا نشد" }, 404);
  return json({ ok: true });
}
