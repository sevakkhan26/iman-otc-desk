/**
 * Impact News provider: multi-source RSS, Iran filter, retention, dedupe, persistence.
 * Export surface unchanged for dashboard: getImpactNews(settings) → ImpactNewsResponse.
 */

import { XMLParser } from "fast-xml-parser";
import { BROWSER_UA, outboundFetch, ProviderError } from "@/lib/http";
import { applyNewsTranslations } from "@/lib/newsTranslation";
import {
  dedupeArticles,
  MAX_VISIBLE_ARTICLES,
  scoreAndBuildArticle,
  sortArticlesForDisplay,
  type RawNewsArticle,
  type ScoredNewsArticle
} from "@/lib/news/pipeline";
import { NEWS_FEEDS, type NewsFeedDef } from "@/lib/news/sources";
import {
  listActiveArticles,
  loadNewsStore,
  mergeArticles,
  purgeExpiredArticles,
  saveNewsStore,
  upsertProvider,
  type ProviderHealth
} from "@/lib/news/store";
import type { DeskSettings, ImpactNewsItem, ImpactNewsResponse, SourceStatus } from "@/lib/types";

/** Continuous refresh window for Impact News (2–5 min per requirements). */
export const NEWS_SERVER_REFRESH_MS = 3 * 60_000;
const MIN_GAP_MS = 20_000;
const EMPTY_FRESH_MESSAGE = "در حال حاضر خبر تازه و اثرگذار مرتبط با بازار ایران یافت نشد.";

type RssItem = {
  title?: string;
  link?: string | { href?: string };
  guid?: string | { "#text"?: string };
  pubDate?: string;
  published?: string;
  description?: string;
  summary?: string;
  source?: string | { "#text"?: string };
};

type FeedFetchResult = {
  feed: NewsFeedDef;
  articles: ScoredNewsArticle[];
  health: ProviderHealth;
};

let inflight: Promise<ImpactNewsResponse> | null = null;
let lastFetchAt = 0;
let lastResponse: ImpactNewsResponse | null = null;
let nextRefreshAt: string | null = null;

function sourceName(item: RssItem, fallback: string): string {
  if (typeof item.source === "string" && item.source.trim()) return item.source.trim();
  if (item.source && typeof item.source === "object" && item.source["#text"]) {
    return String(item.source["#text"]);
  }
  return fallback;
}

function linkOf(item: RssItem): string | undefined {
  if (typeof item.link === "string") return item.link;
  if (item.link && typeof item.link === "object" && item.link.href) return item.link.href;
  if (typeof item.guid === "string" && item.guid.startsWith("http")) return item.guid;
  if (item.guid && typeof item.guid === "object" && item.guid["#text"]?.startsWith("http")) {
    return item.guid["#text"];
  }
  return undefined;
}

function parseDate(value?: string): string | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

async function fetchFeedText(url: string, timeoutMs: number): Promise<{ status: number; text: string; retryAfterSec: number | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await outboundFetch(url, {
      signal: controller.signal,
      headers: {
        accept: "application/rss+xml, application/xml, text/xml, */*",
        "user-agent": BROWSER_UA,
        "accept-language": "en-US,en;q=0.9,fa;q=0.8"
      },
      cache: "no-store"
    });
    const retryAfterRaw = res.headers.get("retry-after");
    let retryAfterSec: number | null = null;
    if (retryAfterRaw) {
      const asNum = Number(retryAfterRaw);
      if (Number.isFinite(asNum)) retryAfterSec = asNum;
      else {
        const asDate = Date.parse(retryAfterRaw);
        if (Number.isFinite(asDate)) retryAfterSec = Math.max(0, Math.round((asDate - Date.now()) / 1000));
      }
    }
    const text = await res.text();
    return { status: res.status, text, retryAfterSec };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    throw new ProviderError(error instanceof Error ? error.message : "خطای شبکه خبر");
  } finally {
    clearTimeout(timer);
  }
}

function parseRssItems(xml: string): RssItem[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    trimValues: true
  });
  const parsed = parser.parse(xml) as {
    rss?: { channel?: { item?: RssItem | RssItem[] } };
    feed?: { entry?: RssItem | RssItem[] };
  };

  const rssItems = parsed.rss?.channel?.item;
  if (rssItems) return Array.isArray(rssItems) ? rssItems : [rssItems];

  const atom = parsed.feed?.entry;
  if (atom) return Array.isArray(atom) ? atom : [atom];

  return [];
}

async function fetchOneFeed(feed: NewsFeedDef): Promise<FeedFetchResult> {
  const attemptedAt = new Date().toISOString();
  const baseHealth: ProviderHealth = {
    id: feed.id,
    name: feed.name,
    status: "unavailable",
    lastAttemptAt: attemptedAt,
    lastSuccessAt: null,
    articleCount: 0,
    httpStatus: null,
    lastError: null,
    retryAfterAt: null
  };

  try {
    const { status, text, retryAfterSec } = await fetchFeedText(feed.url, feed.timeoutMs);
    baseHealth.httpStatus = status;

    if (status === 429) {
      const waitSec = retryAfterSec ?? 120;
      baseHealth.status = "degraded";
      baseHealth.lastError = `HTTP 429 — backoff ${waitSec}s`;
      baseHealth.retryAfterAt = new Date(Date.now() + waitSec * 1000).toISOString();
      return { feed, articles: [], health: baseHealth };
    }

    if (status >= 400) {
      baseHealth.status = "unavailable";
      baseHealth.lastError = `HTTP ${status}`;
      return { feed, articles: [], health: baseHealth };
    }

    const items = parseRssItems(text);
    const scored: ScoredNewsArticle[] = [];
    const fetchedAt = new Date().toISOString();

    for (const item of items.slice(0, 40)) {
      const title = (item.title ?? "").trim();
      if (!title) continue;
      const raw: RawNewsArticle = {
        title,
        url: linkOf(item),
        source: sourceName(item, feed.name),
        publishedAt: parseDate(item.pubDate ?? item.published),
        sourceId: feed.id,
        snippet: typeof item.description === "string" ? item.description.replace(/<[^>]+>/g, " ").slice(0, 280) : undefined
      };
      const built = scoreAndBuildArticle(raw, fetchedAt);
      if (built) scored.push(built);
    }

    baseHealth.articleCount = scored.length;
    baseHealth.lastSuccessAt = fetchedAt;
    baseHealth.status = scored.length > 0 ? "healthy" : "degraded";
    baseHealth.lastError = scored.length > 0 ? null : "هیچ خبر مرتبط با آستانه ایران یافت نشد";
    return { feed, articles: scored, health: baseHealth };
  } catch (error) {
    baseHealth.status = "unavailable";
    baseHealth.lastError = error instanceof Error ? error.message : "خطای ناشناخته";
    return { feed, articles: [], health: baseHealth };
  }
}

function toImpactItem(article: ScoredNewsArticle & { translatedTitle?: string; translatedSummary?: string }): ImpactNewsItem {
  return {
    id: article.id,
    title: article.title,
    translatedTitle: article.translatedTitle ?? article.title,
    translatedSummary: article.translatedSummary ?? article.impactOnUsdtIrt,
    source: article.source,
    publishedAt: article.publishedAt,
    severity: article.severity,
    impactOnUsdtIrt: article.impactOnUsdtIrt,
    recommendedAction: article.recommendedAction,
    assets: article.assets,
    category: article.category,
    group: article.group,
    url: article.url,
    // Extended fields (optional on type)
    iranRelevanceScore: article.iranRelevanceScore,
    impactScore: article.impactScore,
    impactReason: article.impactReason,
    categoryLabel: article.categoryLabel,
    fetchedAt: article.fetchedAt,
    status: "active"
  };
}

function aggregateSourceStatus(providers: ProviderHealth[]): SourceStatus {
  if (!providers.length) return "unavailable";
  const healthy = providers.filter((p) => p.status === "healthy").length;
  const anyOk = providers.some((p) => p.status === "healthy" || p.status === "degraded");
  if (healthy === providers.length) return "available";
  if (anyOk) return "degraded";
  return "unavailable";
}

async function refreshPipeline(settings: DeskSettings): Promise<ImpactNewsResponse> {
  const store = await loadNewsStore();
  purgeExpiredArticles(store);

  const results = await Promise.allSettled(NEWS_FEEDS.map((feed) => fetchOneFeed(feed)));
  const collected: ScoredNewsArticle[] = [];
  const healthList: ProviderHealth[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") {
      collected.push(...result.value.articles);
      healthList.push(result.value.health);
      upsertProvider(store, result.value.health);
    }
  }

  // Skip feeds still in 429 backoff (do not hammer)
  const deduped = dedupeArticles(collected);
  mergeArticles(store, deduped);
  purgeExpiredArticles(store);
  await saveNewsStore(store);

  const active = sortArticlesForDisplay(listActiveArticles(store)).slice(0, MAX_VISIBLE_ARTICLES);

  if (!active.length) {
    const status = aggregateSourceStatus(healthList);
    const response: ImpactNewsResponse = {
      items: [],
      sourceStatus: status,
      lastUpdated: store.updatedAt,
      message:
        status === "unavailable"
          ? "منابع خبر در دسترس نیستند. اخبار قبلی منقضی شده‌اند."
          : EMPTY_FRESH_MESSAGE,
      updatedAt: store.updatedAt,
      nextRefreshAt: new Date(Date.now() + NEWS_SERVER_REFRESH_MS).toISOString(),
      providers: healthList.map((h) => ({
        id: h.id,
        name: h.name,
        status: h.status,
        lastSuccessAt: h.lastSuccessAt,
        articleCount: h.articleCount,
        lastError: h.lastError
      }))
    };
    lastResponse = response;
    lastFetchAt = Date.now();
    nextRefreshAt = response.nextRefreshAt ?? null;
    return response;
  }

  // Translate only titles/summaries that need it; keep publishedAt from source
  const asItems = active.map((a) => toImpactItem(a));
  const translated = await applyNewsTranslations(asItems, settings);

  // Persist translations back into store
  for (const item of translated) {
    const row = store.articles[item.id];
    if (row) {
      row.translatedTitle = item.translatedTitle;
      row.translatedSummary = item.translatedSummary;
    }
  }
  await saveNewsStore(store);

  const finalItems = sortArticlesForDisplay(
    translated.map((item) => {
      const row = store.articles[item.id];
      return {
        ...item,
        iranRelevanceScore: row?.iranRelevanceScore ?? item.iranRelevanceScore,
        impactScore: row?.impactScore ?? item.impactScore,
        impactReason: row?.impactReason ?? item.impactReason,
        categoryLabel: row?.categoryLabel ?? item.categoryLabel,
        fetchedAt: row?.fetchedAt ?? item.fetchedAt
      };
    })
  );

  const status = aggregateSourceStatus(healthList);
  const response: ImpactNewsResponse = {
    items: finalItems,
    sourceStatus: status === "unavailable" && finalItems.length ? "degraded" : status,
    lastUpdated: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nextRefreshAt: new Date(Date.now() + NEWS_SERVER_REFRESH_MS).toISOString(),
    providers: healthList.map((h) => ({
      id: h.id,
      name: h.name,
      status: h.status,
      lastSuccessAt: h.lastSuccessAt,
      articleCount: h.articleCount,
      lastError: h.lastError
    }))
  };

  lastResponse = response;
  lastFetchAt = Date.now();
  nextRefreshAt = response.nextRefreshAt ?? null;
  return response;
}

export async function getImpactNews(settings: DeskSettings): Promise<ImpactNewsResponse> {
  if (settings.enabledSources.news === false) {
    return {
      items: [],
      sourceStatus: "unavailable",
      lastUpdated: null,
      message: "منبع خبر در تنظیمات غیرفعال است",
      updatedAt: null,
      nextRefreshAt: null
    };
  }

  const now = Date.now();

  // Serve warm cache during min-gap / within server refresh window
  if (lastResponse && now - lastFetchAt < NEWS_SERVER_REFRESH_MS) {
    // Still purge client-visible retention on each read
    const store = await loadNewsStore();
    purgeExpiredArticles(store);
    const activeIds = new Set(listActiveArticles(store).map((a) => a.id));
    const items = lastResponse.items.filter((item) => activeIds.has(item.id));
    if (items.length === lastResponse.items.length || items.length > 0) {
      return {
        ...lastResponse,
        items: sortArticlesForDisplay(items),
        nextRefreshAt: nextRefreshAt ?? new Date(lastFetchAt + NEWS_SERVER_REFRESH_MS).toISOString()
      };
    }
  }

  if (inflight) return inflight;

  // Throttle concurrent storms
  if (lastResponse && now - lastFetchAt < MIN_GAP_MS) {
    return lastResponse;
  }

  inflight = refreshPipeline(settings).finally(() => {
    inflight = null;
  });
  return inflight;
}

export async function getImpactNewsStatus(settings: DeskSettings) {
  const store = await loadNewsStore();
  const providers = Object.values(store.providers);
  const active = listActiveArticles(store);

  return {
    status: settings.enabledSources.news === false ? "disabled" : "ok",
    updatedAt: store.updatedAt,
    nextRefreshAt: nextRefreshAt ?? (lastFetchAt ? new Date(lastFetchAt + NEWS_SERVER_REFRESH_MS).toISOString() : null),
    serverRefreshMs: NEWS_SERVER_REFRESH_MS,
    activeArticleCount: active.length,
    storedArticleCount: Object.keys(store.articles).length,
    lastMemoryFetchAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null,
    providers: providers.map((p) => ({
      id: p.id,
      name: p.name,
      status: p.status,
      lastAttemptAt: p.lastAttemptAt,
      lastSuccessAt: p.lastSuccessAt,
      articleCount: p.articleCount,
      httpStatus: p.httpStatus,
      lastError: p.lastError,
      retryAfterAt: p.retryAfterAt
    })),
    feeds: NEWS_FEEDS.map((f) => ({ id: f.id, name: f.name, reliability: f.reliability }))
  };
}

/** Test helper — expose pipeline rebuild without network when raw articles injected. */
export function buildItemsFromRaw(raws: RawNewsArticle[]): ScoredNewsArticle[] {
  const scored = raws.map((r) => scoreAndBuildArticle(r)).filter((x): x is ScoredNewsArticle => Boolean(x));
  return sortArticlesForDisplay(dedupeArticles(scored));
}
