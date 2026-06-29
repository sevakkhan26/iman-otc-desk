import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "@/lib/http";
import type { DeskSettings, ForexEvent, ForexEventsResponse, ForexImpact, PremiumImpact } from "@/lib/types";

// Forex Factory public weekly calendar mirror (faireconomy.media). Real source, no API key required.
const THIS_WEEK = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const NEXT_WEEK = "https://nfs.faireconomy.media/ff_calendar_nextweek.json";

type RawEvent = {
  title?: string;
  country?: string;
  date?: string;
  impact?: string;
  forecast?: string;
  previous?: string;
  actual?: string;
};

// Only the high-impact event types the desk cares about.
const categoryMatchers: Array<{ category: string; pattern: RegExp }> = [
  { category: "FOMC", pattern: /\bfomc\b|federal funds rate|fomc statement|fed (?:chair|press|interest rate)|rate decision/i },
  { category: "NFP", pattern: /non[\s-]?farm(?: employment| payrolls?)?|\bnfp\b/i },
  { category: "Core PCE", pattern: /core pce|pce price index/i },
  { category: "CPI", pattern: /\bcpi\b|consumer price index/i },
  { category: "PPI", pattern: /\bppi\b|producer price index/i },
  { category: "GDP", pattern: /\bgdp\b|gross domestic product/i },
  { category: "Unemployment Rate", pattern: /unemployment rate/i },
  { category: "Retail Sales", pattern: /retail sales/i },
  { category: "PMI", pattern: /\bpmi\b|purchasing managers/i }
];

function matchCategory(title: string): string | null {
  return categoryMatchers.find((matcher) => matcher.pattern.test(title))?.category ?? null;
}

function normalizeImpact(value: string | undefined): ForexImpact {
  const lowered = (value ?? "").toLowerCase();
  if (lowered.includes("high")) return "high";
  if (lowered.includes("medium")) return "medium";
  if (lowered.includes("holiday")) return "holiday";
  return "low";
}

function clean(value: string | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length ? trimmed : null;
}

function parseNumeric(value: string | null): number | null {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

// Categories where a HIGHER reading signals a WEAKER economy / softer USD (inverse direction).
const inverseCategories = new Set(["Unemployment Rate"]);

// Likely effect of a USD macro release on the USDT/IRT premium.
// Hotter US data → stronger USD + risk-off → more demand for dollar-proxy in Iran → premium up.
// Softer data → the opposite → premium eases. Before release (no actual) we stay neutral (no guessing).
function premiumImpactFor(
  category: string,
  forecast: string | null,
  actual: string | null
): { impact: PremiumImpact; reason: string | null } {
  const a = parseNumeric(actual);
  const f = parseNumeric(forecast);
  if (a !== null && f !== null) {
    const tolerance = Math.max(Math.abs(f) * 0.001, 0.01);
    if (Math.abs(a - f) <= tolerance) {
      return { impact: "neutral", reason: "داده تقریباً مطابق پیش‌بینی" };
    }
    const inverse = inverseCategories.has(category);
    const strongerUsd = inverse ? a < f : a > f;
    return strongerUsd
      ? { impact: "up", reason: "داده داغ‌تر از پیش‌بینی (دلار قوی‌تر)" }
      : { impact: "down", reason: "داده ضعیف‌تر از پیش‌بینی (دلار ضعیف‌تر)" };
  }
  return { impact: "neutral", reason: "در انتظار انتشار؛ احتمال نوسان" };
}

function idFor(value: string) {
  return createHash("sha1").update(value).digest("hex").slice(0, 12);
}

function toEvent(raw: RawEvent): ForexEvent | null {
  const title = (raw.title ?? "").trim();
  if (!title) return null;
  // Desk only cares about US Dollar events; ignore every other currency (EUR, CAD, …).
  if ((raw.country ?? "").trim().toUpperCase() !== "USD") return null;
  const category = matchCategory(title);
  if (!category) return null;
  const date = raw.date ? new Date(raw.date) : null;
  const iso = date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
  const forecast = clean(raw.forecast);
  const actual = clean(raw.actual);
  const premium = premiumImpactFor(category, forecast, actual);
  return {
    id: idFor(`${title}:${raw.country ?? ""}:${raw.date ?? ""}`),
    title,
    category,
    country: clean(raw.country) ?? "—",
    date: iso,
    impact: normalizeImpact(raw.impact),
    previous: clean(raw.previous),
    forecast,
    actual,
    premiumImpact: premium.impact,
    premiumImpactReason: premium.reason
  };
}

// A browser-like UA reduces the chance of the CDN rate-limiting/refusing the request.
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function fetchWeek(url: string): Promise<ForexEvent[]> {
  const data = await fetchJson<RawEvent[]>(url, 12_000, { headers: { "user-agent": BROWSER_UA } });
  if (!Array.isArray(data)) return [];
  return data.map(toEvent).filter((event): event is ForexEvent => event !== null);
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Forex Factory rate-limits aggressive polling, and the calendar only changes weekly,
// so cache successful responses (in memory AND on disk) and fall back to the last good
// result on transient errors (e.g. HTTP 429). Disk persistence survives server restarts.
const FRESH_TTL_MS = 30 * 60_000; // 30 min: do not re-fetch within this window
const STALE_TTL_MS = 24 * 60 * 60_000; // 24 h: serve last good data when the source fails

const dataDir = path.join(process.cwd(), ".data");
const cachePath = path.join(dataDir, "forex-cache.json");

type CacheEntry = { at: number; data: ForexEventsResponse };

let memCache: CacheEntry | null = null;
let inflight: Promise<ForexEventsResponse> | null = null;

async function readDiskCache(): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as CacheEntry;
    return parsed && typeof parsed.at === "number" && parsed.data ? parsed : null;
  } catch {
    return null;
  }
}

async function writeDiskCache(entry: CacheEntry): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(cachePath, JSON.stringify(entry), "utf8");
  } catch {
    // disk cache is best-effort; ignore write failures
  }
}

async function getCachedEntry(): Promise<CacheEntry | null> {
  if (memCache) return memCache;
  memCache = await readDiskCache();
  return memCache;
}

async function fetchFresh(): Promise<ForexEventsResponse> {
  // Sequential (not a parallel burst) with a short gap, to stay under the source rate limit.
  const thisWeek = await Promise.allSettled([fetchWeek(THIS_WEEK)]);
  await delay(400);
  const nextWeek = await Promise.allSettled([fetchWeek(NEXT_WEEK)]);
  const results = [...thisWeek, ...nextWeek];
  const collected = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  const allFailed = results.every((result) => result.status === "rejected");

  if (!collected.length) {
    const firstError =
      results.find((result): result is PromiseRejectedResult => result.status === "rejected")?.reason ?? null;
    return {
      events: [],
      sourceStatus: allFailed ? "unavailable" : "degraded",
      lastUpdated: allFailed ? null : new Date().toISOString(),
      message: allFailed
        ? firstError instanceof Error
          ? firstError.message
          : "منبع در دسترس نیست"
        : "داده‌ای دریافت نشد"
    };
  }

  // Keep High and Medium impact only, de-duplicate, sort by time ascending.
  const unique = Array.from(new Map(collected.map((event) => [event.id, event])).values())
    .filter((event) => event.impact === "high" || event.impact === "medium")
    .sort((a, b) => new Date(a.date ?? 0).getTime() - new Date(b.date ?? 0).getTime());

  return {
    events: unique,
    sourceStatus: allFailed ? "degraded" : "available",
    lastUpdated: new Date().toISOString()
  };
}

export async function getForexEvents(settings: DeskSettings): Promise<ForexEventsResponse> {
  if (settings.enabledSources.forex === false) {
    return { events: [], sourceStatus: "unavailable", lastUpdated: null, message: "منبع تقویم فارکس در تنظیمات غیرفعال است" };
  }

  const cached = await getCachedEntry();
  if (cached && cached.data.events.length && Date.now() - cached.at < FRESH_TTL_MS) {
    return cached.data; // still fresh — no network call
  }

  // De-duplicate concurrent refreshes (e.g. dashboard + alerts) into one upstream request.
  if (!inflight) {
    inflight = (async () => {
      try {
        const fresh = await fetchFresh();
        if (fresh.events.length) {
          const entry: CacheEntry = { at: Date.now(), data: fresh };
          memCache = entry;
          await writeDiskCache(entry);
          return fresh;
        }
        // Upstream failed/empty: serve the last good data if still within the stale window.
        const fallback = await getCachedEntry();
        if (fallback && fallback.data.events.length && Date.now() - fallback.at < STALE_TTL_MS) {
          return {
            ...fallback.data,
            sourceStatus: "degraded",
            message: `آخرین داده معتبر نمایش داده شد (به‌روزرسانی موقتاً ناموفق${
              fresh.message ? `: ${fresh.message}` : ""
            })`
          };
        }
        return fresh;
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}
