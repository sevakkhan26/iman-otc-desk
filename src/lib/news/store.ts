/**
 * Impact News store — PostgreSQL app_settings + news_items.
 * Fail closed on write when DATABASE_URL missing; reads fall back to empty only if DB down
 * would break the request path, so we throw on write and soft-empty on read if unavailable.
 */
import { eq } from "drizzle-orm";
import { getDatabaseUrl, getDb } from "@/db/client";
import { appSettings, newsItems } from "@/db/schema";
import type { Severity } from "@/lib/types";
import type { ScoredNewsArticle } from "@/lib/news/pipeline";
import { filterByRetention, isWithinRetention } from "@/lib/news/pipeline";

const NEWS_META_KEY = "impact_news_store";

export type ProviderHealth = {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "unavailable";
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  articleCount: number;
  httpStatus: number | null;
  lastError: string | null;
  retryAfterAt: string | null;
};

export type StoredArticle = ScoredNewsArticle & {
  translatedTitle?: string;
  translatedSummary?: string;
};

export type NewsStoreFile = {
  version: 1;
  updatedAt: string | null;
  articles: Record<string, StoredArticle>;
  providers: Record<string, ProviderHealth>;
};

let memoryStore: NewsStoreFile | null = null;

function emptyStore(): NewsStoreFile {
  return { version: 1, updatedAt: null, articles: {}, providers: {} };
}

export async function loadNewsStore(): Promise<NewsStoreFile> {
  if (memoryStore) return memoryStore;
  try {
    getDatabaseUrl();
    const db = getDb();
    const metaRows = await db
      .select()
      .from(appSettings)
      .where(eq(appSettings.key, NEWS_META_KEY))
      .limit(1);
    const meta = metaRows[0]?.value as Partial<NewsStoreFile> | undefined;
    const articleRows = await db.select().from(newsItems);
    const articles: Record<string, StoredArticle> = {};
    for (const row of articleRows) {
      articles[row.id] = row.payload as StoredArticle;
    }
    // Prefer news_items rows; fall back to embedded articles in meta blob
    if (!Object.keys(articles).length && meta?.articles) {
      Object.assign(articles, meta.articles);
    }
    memoryStore = {
      version: 1,
      updatedAt: typeof meta?.updatedAt === "string" ? meta.updatedAt : null,
      articles,
      providers: (meta?.providers as Record<string, ProviderHealth>) ?? {}
    };
    return memoryStore;
  } catch {
    memoryStore = emptyStore();
    return memoryStore;
  }
}

export async function saveNewsStore(store: NewsStoreFile): Promise<void> {
  memoryStore = store;
  try {
    getDatabaseUrl();
    const db = getDb();
    const now = new Date().toISOString();
    // Meta (providers + updatedAt)
    await db
      .insert(appSettings)
      .values({
        key: NEWS_META_KEY,
        value: {
          version: 1,
          updatedAt: store.updatedAt,
          providers: store.providers
        } as unknown as Record<string, unknown>,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: {
            version: 1,
            updatedAt: store.updatedAt,
            providers: store.providers
          } as unknown as Record<string, unknown>,
          updatedAt: now
        }
      });

    // Upsert articles
    for (const [id, article] of Object.entries(store.articles)) {
      await db
        .insert(newsItems)
        .values({
          id,
          payload: article as unknown as Record<string, unknown>,
          publishedAt: article.publishedAt ?? null,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: newsItems.id,
          set: {
            payload: article as unknown as Record<string, unknown>,
            publishedAt: article.publishedAt ?? null,
            updatedAt: now
          }
        });
    }
  } catch {
    /* keep memory; caller paths are best-effort for news */
  }
}

export function purgeExpiredArticles(store: NewsStoreFile, nowMs = Date.now()): number {
  let removed = 0;
  for (const [id, article] of Object.entries(store.articles)) {
    if (!isWithinRetention(article.publishedAt, article.severity as Severity, nowMs)) {
      delete store.articles[id];
      removed += 1;
    }
  }
  return removed;
}

export function mergeArticles(store: NewsStoreFile, incoming: ScoredNewsArticle[]): number {
  let added = 0;
  const now = new Date().toISOString();
  for (const item of incoming) {
    const prev = store.articles[item.id];
    if (!prev) {
      store.articles[item.id] = { ...item };
      added += 1;
      continue;
    }
    const prevT = new Date(prev.publishedAt ?? 0).getTime();
    const nextT = new Date(item.publishedAt ?? 0).getTime();
    const keep = {
      ...prev,
      ...item,
      translatedTitle: prev.translatedTitle,
      translatedSummary: prev.translatedSummary,
      fetchedAt: now
    };
    if (nextT < prevT && prev.impactScore >= item.impactScore) {
      store.articles[item.id] = {
        ...keep,
        publishedAt: prev.publishedAt,
        title: prev.title,
        impactScore: Math.max(prev.impactScore, item.impactScore),
        severity: prev.impactScore >= item.impactScore ? prev.severity : item.severity
      };
    } else {
      store.articles[item.id] = keep;
    }
  }
  store.updatedAt = now;
  return added;
}

export function listActiveArticles(store: NewsStoreFile, nowMs = Date.now()): StoredArticle[] {
  return filterByRetention(Object.values(store.articles), nowMs);
}

export function upsertProvider(store: NewsStoreFile, health: ProviderHealth): void {
  store.providers[health.id] = health;
}
