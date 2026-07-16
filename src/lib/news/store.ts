/**
 * Persistent Impact News store (.data/impact-news-store.json).
 * Compatible with Docker disk and best-effort on serverless.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Severity } from "@/lib/types";
import type { ScoredNewsArticle } from "@/lib/news/pipeline";
import { filterByRetention, isWithinRetention } from "@/lib/news/pipeline";

const dataDir = path.join(process.cwd(), ".data");
const storePath = path.join(dataDir, "impact-news-store.json");

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
    const raw = await readFile(storePath, "utf8");
    const parsed = JSON.parse(raw) as NewsStoreFile;
    if (!parsed || parsed.version !== 1 || typeof parsed.articles !== "object") {
      memoryStore = emptyStore();
      return memoryStore;
    }
    memoryStore = {
      version: 1,
      updatedAt: parsed.updatedAt ?? null,
      articles: parsed.articles ?? {},
      providers: parsed.providers ?? {}
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
    await mkdir(dataDir, { recursive: true });
    await writeFile(storePath, JSON.stringify(store, null, 2), "utf8");
  } catch {
    /* serverless / read-only FS: keep memory only */
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
    // Prefer newer publishedAt / higher impact; never invent fields
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
