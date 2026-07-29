import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import { runShadowMatrix } from "@/lib/shadowArbitrage";
import { SHADOW_BANNER } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;


/**
 * GET /api/shadow-arbitrage/matrix[?refresh=1]
 *
 * Admin only. Serves what the background worker persisted. `refresh=1` may
 * trigger at most one rate-limited, single-flight collection cycle; if that is
 * throttled the persisted cache is returned instead. The browser never talks to
 * an exchange, and this route places no orders.
 */
export async function GET(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  try {
    const url = new URL(request.url);
    const manualRefresh = url.searchParams.get("refresh") === "1";
    const body = await runShadowMatrix(manualRefresh);
    return new NextResponse(JSON.stringify(body), { status: 200, headers: SHADOW_NO_STORE });
  } catch (error) {
    console.error("[shadow-arbitrage/matrix]", error instanceof Error ? error.message : error);
    return new NextResponse(
      JSON.stringify({
        error: "unavailable",
        message: error instanceof Error ? error.message : "ماتریس سایه در دسترس نیست",
        banner: SHADOW_BANNER
      }),
      { status: 503, headers: SHADOW_NO_STORE }
    );
  }
}
