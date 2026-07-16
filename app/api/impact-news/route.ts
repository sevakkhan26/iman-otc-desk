import { NextResponse } from "next/server";
import { getImpactNews } from "@/lib/providers/news";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const revalidate = 0;

export async function GET() {
  const settings = await getSettings();
  const payload = await getImpactNews(settings);

  // Keep existing `items` shape for the page/ticker; mirror structured fields.
  return NextResponse.json(
    {
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
      }))
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0"
      }
    }
  );
}
