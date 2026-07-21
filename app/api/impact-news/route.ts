import { NextResponse } from "next/server";
import { getImpactNews } from "@/lib/providers/news";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { getSettings } from "@/lib/settings";
import { serveSwr } from "@/lib/swrServe";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;
export const maxDuration = 30;

function mapPayload(payload: Awaited<ReturnType<typeof getImpactNews>>) {
  return {
    status: payload.sourceStatus === "unavailable" && !payload.items.length ? "error" : "ok",
    updatedAt: payload.updatedAt ?? payload.lastUpdated,
    nextRefreshAt: payload.nextRefreshAt ?? null,
    sourceStatus: payload.sourceStatus,
    lastUpdated: payload.lastUpdated,
    message: payload.message,
    providers: payload.providers,
    items: payload.items,
    articles: payload.items.map((item) => ({
      id: item.id,
      title: item.translatedTitle || item.title,
      summaryFa: item.translatedSummary || item.impactOnUsdtIrt,
      source: item.source,
      url: item.url,
      publishedAt: item.publishedAt,
      category: item.categoryLabel ?? item.category,
      impactLevel: item.severity === "high" ? "زیاد" : item.severity === "medium" ? "متوسط" : "کم",
      impactScore: item.impactScore ?? null,
      impactReason: item.impactReason ?? item.impactOnUsdtIrt,
      iranRelevanceScore: item.iranRelevanceScore ?? null
    })),
    serverNow: new Date().toISOString()
  };
}

const EMPTY = {
  status: "error" as const,
  updatedAt: null,
  nextRefreshAt: null,
  sourceStatus: "unavailable" as const,
  lastUpdated: null,
  message: "خبرها موقتاً در دسترس نیست — دوباره تلاش کنید",
  providers: [] as unknown[],
  items: [] as unknown[],
  articles: [] as unknown[],
  serverNow: new Date().toISOString()
};

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;

  try {
    // No hard deadline throw — getImpactNews serves DB instantly + background RSS.
    const body = await serveSwr("api:impact-news", 30_000, 30 * 60_000, async () => {
      const settings = await getSettings();
      return mapPayload(await getImpactNews(settings));
    });
    return NextResponse.json(body, {
      headers: { "Cache-Control": "no-store, max-age=0" }
    });
  } catch (error) {
    console.error("[impact-news]", error instanceof Error ? error.message : error);
    // Never 500 the news shell — empty 200 keeps UI usable
    return NextResponse.json(
      { ...EMPTY, serverNow: new Date().toISOString() },
      { status: 200, headers: { "Cache-Control": "no-store, max-age=0" } }
    );
  }
}
