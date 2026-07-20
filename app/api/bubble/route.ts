import { NextResponse } from "next/server";
import { buildMarketBubbleResponse } from "@/lib/bubble/compute";
import { getFxStreetPrices } from "@/lib/providers/fxStreet";
import { getGoldMarketPrices } from "@/lib/providers/goldMarket";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

const NO_STORE = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8"
};

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  try {
    const settings = await getSettings();
    const [fxR, goldR] = await Promise.allSettled([
      getFxStreetPrices(settings),
      getGoldMarketPrices(settings)
    ]);

    const fx = fxR.status === "fulfilled" ? fxR.value : null;
    const gold = goldR.status === "fulfilled" ? goldR.value : null;

    const notes: string[] = [];
    if (fxR.status === "rejected") {
      notes.push(
        `ارز: ${fxR.reason instanceof Error ? fxR.reason.message : "دریافت ناموفق"}`
      );
    }
    if (goldR.status === "rejected") {
      notes.push(
        `طلا: ${goldR.reason instanceof Error ? goldR.reason.message : "دریافت ناموفق"}`
      );
    }

    const payload = buildMarketBubbleResponse(fx, gold);
    if (notes.length) {
      payload.notes = [...notes, ...payload.notes];
    }
    const serverNow = new Date().toISOString();
    const body = {
      ...payload,
      serverNow,
      generatedAt: payload.lastUpdated ?? serverNow,
      isStale: false,
      lastSuccessfulRefreshAt: payload.lastUpdated ?? null,
      lastAttemptedRefreshAt: serverNow,
      refreshIntervalMs: 30_000
    };

    return new NextResponse(JSON.stringify(body), { status: 200, headers: NO_STORE });
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطای سرور";
    const serverNow = new Date().toISOString();
    return new NextResponse(
      JSON.stringify({
        lastUpdated: null,
        serverNow,
        generatedAt: serverNow,
        notes: [message],
        dollar: {
          summary: null,
          summaryUnavailableReason: "داده کافی برای محاسبه حباب در دسترس نیست",
          sources: []
        },
        gold: {
          summary: null,
          summaryUnavailableReason: "داده کافی برای محاسبه حباب در دسترس نیست",
          sources: []
        },
        health: []
      }),
      { status: 200, headers: NO_STORE }
    );
  }
}
