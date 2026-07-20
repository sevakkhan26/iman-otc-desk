import { NextResponse } from "next/server";
import { DatabaseUnavailableError } from "@/db/client";
import { getDashboard } from "@/lib/market";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// Keep domestic providers (incl. Arzinja) on a region that can reach Arvan IR edges.
export const preferredRegion = ["sin1"];
export const maxDuration = 60;

const NO_STORE = {
  "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
  pragma: "no-cache",
  "content-type": "application/json; charset=utf-8"
} as const;

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  try {
    const body = await getDashboard();
    return new NextResponse(JSON.stringify(body), { status: 200, headers: NO_STORE });
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) {
      return new NextResponse(
        JSON.stringify({
          error: "database_unavailable",
          message: "پایگاه‌داده در دسترس نیست. DATABASE_URL را بررسی کنید."
        }),
        { status: 503, headers: NO_STORE }
      );
    }
    console.error("[dashboard]", error instanceof Error ? error.message : error);
    return new NextResponse(
      JSON.stringify({
        error: "internal_error",
        message: error instanceof Error ? error.message : "خطای داخلی سرور"
      }),
      { status: 500, headers: NO_STORE }
    );
  }
}
