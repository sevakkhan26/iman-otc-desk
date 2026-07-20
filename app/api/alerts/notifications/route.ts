import { NextResponse } from "next/server";
import { getSession } from "@/lib/authSession";
import {
  clearNotifications,
  getStorageDiagnostics,
  listNotifications,
  PriceAlertStorageError,
  resolveStorageBackend,
  unreadCount
} from "@/lib/priceAlerts/store";
import { evaluatePriceAlerts } from "@/lib/priceAlerts/engine";
import { loadLivePriceBundle } from "@/lib/priceAlerts/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

function json(body: unknown, status = 200) {
  return new NextResponse(JSON.stringify(body), { status, headers: NO_STORE });
}

export async function GET(request: Request) {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);

  const url = new URL(request.url);
  const evaluate = url.searchParams.get("evaluate") !== "0";

  void resolveStorageBackend();

  if (evaluate) {
    try {
      const live = await loadLivePriceBundle();
      await evaluatePriceAlerts(live);
    } catch {
      // best-effort evaluation
    }
  }

  try {
    const items = await listNotifications();
    const unread = await unreadCount();
    return json({
      items,
      unread,
      diagnostics: {
        ...getStorageDiagnostics(),
        alertQuerySucceeded: true,
        notificationQuerySucceeded: true,
        authenticatedRole: session.r
      }
    });
  } catch (error) {
    if (error instanceof PriceAlertStorageError) {
      return json(
        {
          error: error.code,
          message: error.message,
          diagnostics: getStorageDiagnostics()
        },
        error.code.includes("NOT_CONFIGURED") ? 503 : 500
      );
    }
    console.error("[api/alerts/notifications]", error instanceof Error ? error.stack : error);
    return json({ error: "failed", message: "خطای سرور هنگام بارگذاری اعلان‌ها" }, 500);
  }
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return json({ error: "unauthorized", message: "ابتدا وارد شوید" }, 401);
  if (session.r !== "admin") {
    return json({ error: "forbidden", message: "فقط ادمین می‌تواند تاریخچه را پاک کند" }, 403);
  }
  try {
    const count = await clearNotifications();
    return json({ ok: true, cleared: count });
  } catch (error) {
    if (error instanceof PriceAlertStorageError) {
      return json({ error: error.code, message: error.message }, 503);
    }
    return json({ error: "failed", message: "پاک‌کردن تاریخچه ناموفق بود" }, 500);
  }
}
