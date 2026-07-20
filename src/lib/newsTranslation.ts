/**
 * News translation cache — durable store: PostgreSQL app_settings key `news_translations`.
 */
import { createHash } from "node:crypto";
import { pgGetKv, pgSetKv } from "@/db/repositories/kv";
import { outboundFetch } from "@/lib/http";
import type { DeskSettings, ImpactNewsItem } from "@/lib/types";

const KV_KEY = "news_translations";
const MAX_CACHE_ENTRIES = 400;
const BATCH_SIZE = 8;
const TRANSLATE_TIMEOUT_MS = 20_000;
const LOG_PREFIX = "[news-translation]";

const PRESERVE_TOKEN_REGEX =
  /\b(BTC|ETH|USDT|USDC|BNB|SOL|XRP|Binance|Coinbase|Kraken|OKX|Bybit|Tether|CoinDesk|Google News|Ark Invest|CryptoRank)\b/gi;

type TranslationCacheEntry = {
  title: string;
  summary: string;
  translatedTitle: string;
  translatedSummary: string;
  updatedAt: string;
};

type TranslationCache = {
  entries: Record<string, TranslationCacheEntry>;
};

type TranslationRequestItem = {
  id: string;
  title: string;
  summary: string;
  source: string;
};

type TranslationResultItem = {
  id: string;
  translatedTitle: string;
  translatedSummary: string;
};

const systemPrompt = `Translate crypto/market news into natural Persian (Farsi) for an Iranian OTC desk.

Return JSON: { "items": [ { "id", "translatedTitle", "translatedSummary" } ] }

Rules:
- Natural Persian, not word-for-word.
- Keep in English: source names, BTC, ETH, USDT, USDC, Binance, Coinbase, Kraken, OKX, Bybit, Tether, CoinDesk, Google News, Ark Invest, CryptoRank.
- translatedTitle: concise Persian headline.
- translatedSummary: 1-2 Persian sentences on USDT/IRT market impact.
- Do not invent facts.`;

function isMostlyPersian(text: string): boolean {
  const persianChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  return persianChars >= Math.max(6, text.length * 0.2);
}

function isMostlyEnglish(text: string): boolean {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return latin >= Math.max(12, text.length * 0.35) && !isMostlyPersian(text);
}

function cacheKeyFor(item: Pick<ImpactNewsItem, "id" | "title" | "impactOnUsdtIrt">) {
  return createHash("sha1").update(`${item.id}|${item.title}|${item.impactOnUsdtIrt}`).digest("hex");
}

export function resolveOpenAiApiKey(settings: DeskSettings): string {
  const fromEnv = process.env.OPENAI_API_KEY?.trim() ?? "";
  const fromSettings = settings.openAiApiKey?.trim() ?? "";
  return fromEnv || fromSettings;
}

function isValidCachedEntry(entry: TranslationCacheEntry): boolean {
  if (isMostlyPersian(entry.title)) {
    return isMostlyPersian(entry.translatedTitle) || entry.translatedTitle === entry.title;
  }
  return isMostlyPersian(entry.translatedTitle) && entry.translatedTitle !== entry.title;
}

function sanitizeCache(cache: TranslationCache): TranslationCache {
  const entries: TranslationCache["entries"] = {};
  for (const [key, entry] of Object.entries(cache.entries)) {
    if (isValidCachedEntry(entry)) entries[key] = entry;
  }
  return { entries };
}

async function readCache(): Promise<TranslationCache> {
  try {
    const parsed = await pgGetKv<TranslationCache>(KV_KEY);
    if (!parsed?.entries || typeof parsed.entries !== "object") return { entries: {} };
    return sanitizeCache(parsed);
  } catch {
    return { entries: {} };
  }
}

async function writeCache(cache: TranslationCache): Promise<void> {
  const sanitized = sanitizeCache(cache);
  const entries = Object.entries(sanitized.entries)
    .sort(([, a], [, b]) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_CACHE_ENTRIES);
  try {
    await pgSetKv(KV_KEY, { entries: Object.fromEntries(entries) }, "news-translation");
  } catch {
    // best-effort cache
  }
}

function maskTokens(text: string): { masked: string; tokens: string[] } {
  const tokens: string[] = [];
  const masked = text.replace(PRESERVE_TOKEN_REGEX, (match) => {
    const existing = tokens.findIndex((token) => token.toLowerCase() === match.toLowerCase());
    if (existing >= 0) return `__TOK${existing}__`;
    const idx = tokens.length;
    tokens.push(match);
    return `__TOK${idx}__`;
  });
  return { masked, tokens };
}

function unmaskTokens(text: string, tokens: string[]): string {
  let out = text;
  for (let i = 0; i < tokens.length; i++) {
    out = out.replaceAll(`__TOK${i}__`, tokens[i]);
    out = out.replaceAll(`__tok${i}__`, tokens[i]);
  }
  return out;
}

function extractJsonItems(text: string): TranslationResultItem[] | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as { items?: unknown };
    if (!Array.isArray(parsed.items)) return null;
    return parsed.items
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const row = entry as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id : "";
        const translatedTitle = typeof row.translatedTitle === "string" ? row.translatedTitle.trim() : "";
        const translatedSummary = typeof row.translatedSummary === "string" ? row.translatedSummary.trim() : "";
        if (!id || !translatedTitle || !translatedSummary) return null;
        return { id, translatedTitle, translatedSummary };
      })
      .filter((entry): entry is TranslationResultItem => entry !== null);
  } catch {
    return null;
  }
}

async function translateWithMyMemory(text: string): Promise<string | null> {
  const { masked, tokens } = maskTokens(text);
  const url = new URL("https://api.mymemory.translated.net/get");
  url.searchParams.set("q", masked.slice(0, 500));
  url.searchParams.set("langpair", "en|fa");

  try {
    const response = await outboundFetch(url.toString(), { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const payload = (await response.json()) as { responseData?: { translatedText?: string } };
    const translated = payload.responseData?.translatedText?.trim();
    if (!translated) return null;
    return unmaskTokens(translated, tokens);
  } catch {
    return null;
  }
}

async function translateWithOpenAI(items: TranslationRequestItem[], apiKey: string): Promise<TranslationResultItem[]> {
  if (!items.length) return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TRANSLATE_TIMEOUT_MS);

  try {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    const response = await outboundFetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: JSON.stringify({
              items: items.map((item) => ({
                id: item.id,
                title: item.title,
                summary: item.summary,
                source: item.source
              }))
            })
          }
        ]
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.warn(`${LOG_PREFIX} OpenAI HTTP ${response.status}: ${body.slice(0, 200)}`);
      return [];
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = payload.choices?.[0]?.message?.content;
    if (!text) {
      console.warn(`${LOG_PREFIX} OpenAI returned empty content`);
      return [];
    }
    return extractJsonItems(text) ?? [];
  } catch (error) {
    console.warn(`${LOG_PREFIX} OpenAI request failed:`, error instanceof Error ? error.message : error);
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function translateOneItem(
  item: TranslationRequestItem,
  apiKey: string,
  useOpenAi: boolean
): Promise<TranslationResultItem | null> {
  if (useOpenAi) {
    const batch = await translateWithOpenAI([item], apiKey);
    if (batch[0]) return batch[0];
  }

  const translatedTitle = isMostlyEnglish(item.title) ? await translateWithMyMemory(item.title) : item.title;
  if (!translatedTitle || !isMostlyPersian(translatedTitle)) return null;

  const translatedSummary = isMostlyPersian(item.summary)
    ? item.summary
    : (await translateWithMyMemory(item.summary)) ?? item.summary;

  return {
    id: item.id,
    translatedTitle,
    translatedSummary
  };
}

function pickSummary(item: ImpactNewsItem, translated?: string): string {
  const candidate = translated?.trim();
  if (candidate && isMostlyPersian(candidate)) return candidate;
  if (isMostlyPersian(item.impactOnUsdtIrt)) return item.impactOnUsdtIrt;
  return candidate || item.impactOnUsdtIrt;
}

function pickTitle(item: ImpactNewsItem, translated?: string): string {
  const candidate = translated?.trim();
  if (candidate && isMostlyPersian(candidate)) return candidate;
  if (isMostlyPersian(item.title)) return item.title;
  return candidate || item.title;
}

export async function applyNewsTranslations(items: ImpactNewsItem[], settings: DeskSettings): Promise<ImpactNewsItem[]> {
  if (!items.length) return items;

  const apiKey = resolveOpenAiApiKey(settings);
  const useOpenAi = Boolean(apiKey);
  if (!useOpenAi) {
    console.warn(
      `${LOG_PREFIX} OPENAI_API_KEY is missing in .env.local and settings — using fallback translator (MyMemory)`
    );
  } else if (!process.env.OPENAI_API_KEY?.trim()) {
    console.warn(`${LOG_PREFIX} OPENAI_API_KEY not in .env.local; using key from settings.json`);
  }

  const cache = await readCache();
  const pending: TranslationRequestItem[] = [];
  const resolved = new Map<string, { translatedTitle: string; translatedSummary: string }>();

  for (const item of items) {
    const key = cacheKeyFor(item);
    const cached = cache.entries[key];
    if (cached && cached.title === item.title && cached.summary === item.impactOnUsdtIrt && isValidCachedEntry(cached)) {
      resolved.set(item.id, {
        translatedTitle: cached.translatedTitle,
        translatedSummary: cached.translatedSummary
      });
      continue;
    }

    if (isMostlyPersian(item.title)) {
      const translatedSummary = pickSummary(item);
      resolved.set(item.id, { translatedTitle: item.title, translatedSummary });
      continue;
    }

    pending.push({
      id: item.id,
      title: item.title,
      summary: item.impactOnUsdtIrt,
      source: item.source
    });
  }

  if (pending.length) {
    for (let i = 0; i < pending.length; i += BATCH_SIZE) {
      const batch = pending.slice(i, i + BATCH_SIZE);
      let translated: TranslationResultItem[] = [];

      if (useOpenAi) {
        translated = await translateWithOpenAI(batch, apiKey);
      }

      const byId = new Map(translated.map((entry) => [entry.id, entry]));

      for (const item of batch) {
        const original = items.find((entry) => entry.id === item.id);
        if (!original) continue;

        let hit = byId.get(item.id);
        if (!hit || !isMostlyPersian(hit.translatedTitle)) {
          hit = (await translateOneItem(item, apiKey, false)) ?? undefined;
        }

        const translatedTitle = pickTitle(original, hit?.translatedTitle);
        const translatedSummary = pickSummary(original, hit?.translatedSummary);
        resolved.set(item.id, { translatedTitle, translatedSummary });

        if (shouldCache(original.title, translatedTitle)) {
          cache.entries[cacheKeyFor(original)] = {
            title: original.title,
            summary: original.impactOnUsdtIrt,
            translatedTitle,
            translatedSummary,
            updatedAt: new Date().toISOString()
          };
        }
      }
    }

    try {
      await writeCache(cache);
    } catch {
      // best-effort cache
    }
  }

  const output = items.map((item) => {
    const hit = resolved.get(item.id);
    return {
      ...item,
      translatedTitle: pickTitle(item, hit?.translatedTitle),
      translatedSummary: pickSummary(item, hit?.translatedSummary)
    };
  });

  const persianCount = output.filter((item) => isMostlyPersian(item.translatedTitle)).length;
  console.info(`${LOG_PREFIX} translated ${persianCount}/${output.length} headlines to Persian`);
  return output;
}

function shouldCache(originalTitle: string, translatedTitle: string): boolean {
  if (isMostlyPersian(originalTitle)) return true;
  return isMostlyPersian(translatedTitle) && translatedTitle !== originalTitle;
}