import { getImpactNews, getImpactNewsStatus } from "../src/lib/providers/news.ts";
import { getSettings } from "../src/lib/settings.ts";

async function main() {
  const settings = await getSettings();
  const news = await getImpactNews(settings);
  const status = await getImpactNewsStatus(settings);
  console.log(
    JSON.stringify(
      {
        sourceStatus: news.sourceStatus,
        itemCount: news.items.length,
        updatedAt: news.updatedAt,
        nextRefreshAt: news.nextRefreshAt,
        message: news.message,
        sample: news.items.slice(0, 5).map((i) => ({
          id: i.id,
          title: i.translatedTitle || i.title,
          source: i.source,
          publishedAt: i.publishedAt,
          severity: i.severity,
          impactScore: i.impactScore,
          iranRelevanceScore: i.iranRelevanceScore,
          categoryLabel: i.categoryLabel
        })),
        providers: status.providers?.map((p) => ({
          id: p.id,
          status: p.status,
          count: p.articleCount,
          http: p.httpStatus,
          err: p.lastError
        }))
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
