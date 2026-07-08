import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchJson } from "@/lib/http";
import type { SourceStatus, TelegramPrice, TelegramPricesResponse, TelegramPriceType } from "@/lib/types";

const dataDir = path.join(process.cwd(), ".data");
const offsetPath = path.join(dataDir, "telegram-offset.json");
const pricesPath = path.join(dataDir, "telegram-prices.json");

// don't hammer Telegram if the dashboard polls often
const MIN_POLL_MS = 4_000;

// the four tracked items, in display order (also the parse priority order — most specific first)
const TRACKED: TelegramPriceType[] = ["دلار کاغذی", "دلار سبزه میدان", "درهم امارات", "دلار خروجی"];

const MATCHERS: Array<{ type: TelegramPriceType; pattern: RegExp }> = [
  { type: "دلار کاغذی", pattern: /دلار\s*کاغذی/ },
  { type: "دلار سبزه میدان", pattern: /(?:دلار\s*)?سبزه\s*می?دان/ },
  { type: "درهم امارات", pattern: /درهم(?:\s*امارات)?/ },
  { type: "دلار خروجی", pattern: /(?:دلار\s*)?خروجی/ }
];

type TgChat = { title?: string; username?: string };
type TgMessage = { message_id?: number; date?: number; text?: string; caption?: string; chat?: TgChat };
type TgUpdate = { update_id: number; channel_post?: TgMessage; edited_channel_post?: TgMessage };
type TgResponse = { ok: boolean; result?: TgUpdate[]; description?: string };

type PricesFile = { items: TelegramPrice[]; lastUpdated: string | null; lastPolledAt: number };

/** Convert Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII. */
function normalizeDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x06f0 && code <= 0x06f9) out += String(code - 0x06f0);
    else if (code >= 0x0660 && code <= 0x0669) out += String(code - 0x0660);
    else out += ch;
  }
  return out;
}

function detectCurrency(text: string): string {
  if (/ریال/.test(text)) return "ریال";
  return "تومان";
}

/** Pull the first plausible integer price out of a line (after digit normalization). */
function extractPrice(line: string): number | null {
  const normalized = normalizeDigits(line);
  const match = normalized.match(/\d[\d.,٫٬،\s]*\d|\d/);
  if (!match) return null;
  const digits = match[0].replace(/[^\d]/g, "");
  if (!digits) return null;
  const value = Number.parseInt(digits, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function matchType(line: string): TelegramPriceType | null {
  for (const matcher of MATCHERS) {
    if (matcher.pattern.test(line)) return matcher.type;
  }
  return null;
}

/** Parse one channel message into zero or more tracked prices (one per matched line). */
function parseMessage(message: TgMessage): TelegramPrice[] {
  const text = message.text ?? message.caption ?? "";
  if (!text.trim()) return [];
  const channel = message.chat?.title ?? message.chat?.username ?? "کانال تلگرام";
  const messageDate = message.date ? new Date(message.date * 1000).toISOString() : null;
  const receivedAt = new Date().toISOString();

  const seen = new Set<TelegramPriceType>();
  const results: TelegramPrice[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const type = matchType(line);
    if (!type || seen.has(type)) continue;
    const price = extractPrice(line);
    if (price === null) continue;
    seen.add(type);
    results.push({
      type,
      price,
      currency: detectCurrency(line),
      sourceChannel: channel,
      messageDate,
      receivedAt,
      rawText: line.slice(0, 200),
      confidence: "high",
      status: "ok"
    });
  }
  return results;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2), "utf8");
}

function emptyItems(): TelegramPrice[] {
  const receivedAt = new Date().toISOString();
  return TRACKED.map((type) => ({
    type,
    price: null,
    currency: "تومان",
    sourceChannel: "—",
    messageDate: null,
    receivedAt,
    rawText: "",
    confidence: "low",
    status: "no-data"
  }));
}

/** Merge freshly-parsed prices over the stored ones, keeping the newest per type. */
function mergePrices(stored: TelegramPrice[], fresh: TelegramPrice[]): TelegramPrice[] {
  const byType = new Map<TelegramPriceType, TelegramPrice>();
  for (const item of stored) byType.set(item.type, item);
  for (const item of fresh) {
    const prev = byType.get(item.type);
    const prevTime = prev?.messageDate ? Date.parse(prev.messageDate) : 0;
    const nextTime = item.messageDate ? Date.parse(item.messageDate) : 0;
    if (!prev || nextTime >= prevTime) byType.set(item.type, item);
  }
  // always return all four tracked types in order (fill gaps with no-data)
  const blanks = emptyItems();
  return TRACKED.map((type) => byType.get(type) ?? blanks.find((b) => b.type === type)!);
}

function toResponse(file: PricesFile, sourceStatus: SourceStatus, message?: string): TelegramPricesResponse {
  return { items: file.items, sourceStatus, lastUpdated: file.lastUpdated, message };
}

export async function getTelegramPrices(): Promise<TelegramPricesResponse> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const stored = await readJson<PricesFile>(pricesPath, { items: emptyItems(), lastUpdated: null, lastPolledAt: 0 });

  if (!token) {
    return toResponse(stored, "unavailable", "توکن تلگرام تنظیم نشده است");
  }

  // throttle: serve cached results if polled very recently
  if (Date.now() - stored.lastPolledAt < MIN_POLL_MS) {
    return toResponse(stored, "available");
  }

  try {
    const offset = await readJson<{ offset: number }>(offsetPath, { offset: 0 });
    const allowed = encodeURIComponent(JSON.stringify(["channel_post", "edited_channel_post"]));
    const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=0&allowed_updates=${allowed}${
      offset.offset ? `&offset=${offset.offset}` : ""
    }`;
    const data = await fetchJson<TgResponse>(url, 12_000);
    if (!data.ok) {
      return toResponse(stored, "degraded", data.description || "پاسخ نامعتبر از تلگرام");
    }

    const updates = data.result ?? [];
    const fresh: TelegramPrice[] = [];
    let maxUpdateId = offset.offset ? offset.offset - 1 : 0;
    for (const update of updates) {
      maxUpdateId = Math.max(maxUpdateId, update.update_id);
      const post = update.channel_post ?? update.edited_channel_post;
      if (post) fresh.push(...parseMessage(post));
    }

    const merged = mergePrices(stored.items, fresh);
    const next: PricesFile = {
      items: merged,
      lastUpdated: fresh.length || !stored.lastUpdated ? new Date().toISOString() : stored.lastUpdated,
      lastPolledAt: Date.now()
    };
    await writeJson(pricesPath, next);
    if (updates.length) await writeJson(offsetPath, { offset: maxUpdateId + 1 });

    return toResponse(next, "available");
  } catch (error) {
    // never crash the dashboard — return last good data with a degraded status
    return toResponse(stored, "degraded", error instanceof Error ? error.message : "دریافت از تلگرام ناموفق بود");
  }
}
