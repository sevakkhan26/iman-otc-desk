import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getGoldPriceSamples } from "@/lib/goldHistory";
import { getMedianPriceSamples } from "@/lib/history";
import type {
  ForexEvent,
  ForexHistoricalEvent,
  ForexMarketReaction,
  ForexPreviousMonthSection,
  ForexReactionDirection,
  ForexReactionWindow,
  ForexResultClass,
  SourceStatus
} from "@/lib/types";

const dataDir = path.join(process.cwd(), ".data");
const historyPath = path.join(dataDir, "forex-events-history.json");

/** Keep completed events for 4 months so previous-month queries stay available. */
const RETAIN_MS = 120 * 24 * 60 * 60_000;

type HistoryFile = {
  events: ForexEvent[];
  updatedAt: string | null;
};

const CATEGORY_FA: Record<string, string> = {
  FOMC: "تصمیم / بیانیه نرخ بهره فدرال رزرو",
  NFP: "اشتغال غیرکشاورزی آمریکا",
  "Core PCE": "شاخص قیمت PCE هسته",
  CPI: "شاخص قیمت مصرف‌کننده آمریکا",
  PPI: "شاخص قیمت تولیدکننده آمریکا",
  GDP: "تولید ناخالص داخلی آمریکا",
  "Unemployment Rate": "نرخ بیکاری آمریکا",
  "Retail Sales": "خرده‌فروشی آمریکا",
  PMI: "شاخص مدیران خرید (PMI)",
  ISM: "شاخص ISM",
  "Jobless Claims": "مدعیان بیکاری آمریکا",
  "Fed Speaks": "سخنان مقام فدرال رزرو"
};

const INVERSE_CATEGORIES = new Set(["Unemployment Rate", "Jobless Claims"]);

function parseNumeric(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function isCompletedPast(event: ForexEvent, nowMs = Date.now()): boolean {
  if (!event.date) return false;
  const t = new Date(event.date).getTime();
  if (!Number.isFinite(t) || t > nowMs) return false;
  // Prefer events that have released (actual present) or are clearly past release time.
  return true;
}

function isImportant(event: ForexEvent): boolean {
  return event.impact === "high" || event.impact === "medium";
}

async function readHistory(): Promise<HistoryFile> {
  try {
    const raw = await readFile(historyPath, "utf8");
    const parsed = JSON.parse(raw) as HistoryFile;
    if (!parsed || !Array.isArray(parsed.events)) return { events: [], updatedAt: null };
    return {
      events: parsed.events.filter(
        (e): e is ForexEvent =>
          Boolean(e) && typeof e.id === "string" && typeof e.title === "string" && typeof e.date === "string"
      ),
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : null
    };
  } catch {
    return { events: [], updatedAt: null };
  }
}

async function writeHistory(file: HistoryFile): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true });
    await writeFile(historyPath, JSON.stringify(file), "utf8");
  } catch {
    // best-effort
  }
}

function mergePreferRicher(a: ForexEvent, b: ForexEvent): ForexEvent {
  // Prefer the version with actual; then with forecast; keep latest premium fields.
  const aScore = (a.actual ? 4 : 0) + (a.forecast ? 2 : 0) + (a.previous ? 1 : 0);
  const bScore = (b.actual ? 4 : 0) + (b.forecast ? 2 : 0) + (b.previous ? 1 : 0);
  return bScore >= aScore ? b : a;
}

/** Persist completed important USD events for previous-month panel (survives restarts). */
export async function recordCompletedForexEvents(events: ForexEvent[]): Promise<void> {
  const now = Date.now();
  const completed = events.filter((e) => isImportant(e) && isCompletedPast(e, now) && e.country === "USD");
  if (!completed.length) return;

  const existing = await readHistory();
  const byId = new Map<string, ForexEvent>();
  for (const event of existing.events) {
    byId.set(event.id, event);
  }
  for (const event of completed) {
    const prev = byId.get(event.id);
    byId.set(event.id, prev ? mergePreferRicher(prev, event) : event);
  }

  const pruned = Array.from(byId.values())
    .filter((event) => {
      if (!event.date) return false;
      const t = new Date(event.date).getTime();
      return Number.isFinite(t) && now - t <= RETAIN_MS;
    })
    .sort((a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime());

  await writeHistory({ events: pruned, updatedAt: new Date().toISOString() });
}

/** Previous calendar month in UTC: [start, end). */
export function previousCalendarMonthRangeUtc(now = new Date()): {
  start: Date;
  end: Date;
  monthKey: string;
} {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, 0, 0, 0, 0));
  const monthKey = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, monthKey };
}

export function formatPersianMonthLabel(rangeStartIso: string): string {
  const date = new Date(rangeStartIso);
  if (Number.isNaN(date.getTime())) return "ماه گذشته";
  // Mid-month of previous month for stable Jalali month name
  const mid = new Date(date.getTime() + 14 * 24 * 60 * 60_000);
  return new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    timeZone: "Asia/Tehran",
    month: "long",
    year: "numeric"
  }).format(mid);
}

function titleFaFor(event: ForexEvent): string {
  return CATEGORY_FA[event.category] ?? event.title;
}

function classifyResult(
  category: string,
  forecast: string | null,
  actual: string | null
): { resultClass: ForexResultClass; resultLabel: string; surprise: number | null; surpriseDisplay: string | null } {
  const a = parseNumeric(actual);
  const f = parseNumeric(forecast);
  if (a === null || f === null) {
    return {
      resultClass: "incomplete",
      resultLabel: "ناقص — مقدار واقعی یا پیش‌بینی موجود نیست",
      surprise: null,
      surpriseDisplay: null
    };
  }
  const surprise = a - f;
  const tolerance = Math.max(Math.abs(f) * 0.001, 0.01);
  if (Math.abs(surprise) <= tolerance) {
    return {
      resultClass: "inline",
      resultLabel: "مطابق انتظار",
      surprise,
      surpriseDisplay: formatSurprise(surprise)
    };
  }
  const inverse = INVERSE_CATEGORIES.has(category);
  // "Better" for the economy/data narrative used in desk UI (not investment advice).
  const better = inverse ? a < f : a > f;
  return {
    resultClass: better ? "better" : "weaker",
    resultLabel: better ? "بهتر از انتظار" : "ضعیف‌تر از انتظار",
    surprise,
    surpriseDisplay: formatSurprise(surprise)
  };
}

function formatSurprise(value: number): string {
  const sign = value > 0 ? "+" : "";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${sign}${value.toFixed(digits)}`;
}

type PriceSample = { t: number; v: number };

function nearestSample(samples: PriceSample[], targetMs: number, maxDeltaMs: number): number | null {
  if (!samples.length) return null;
  let best: PriceSample | null = null;
  let bestDelta = Infinity;
  for (const sample of samples) {
    const delta = Math.abs(sample.t - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = sample;
    }
  }
  if (!best || bestDelta > maxDeltaMs) return null;
  return best.v;
}

function directionOf(change: number | null): { direction: ForexReactionDirection; directionLabel: string } {
  if (change === null || !Number.isFinite(change)) return { direction: "flat", directionLabel: "خنثی" };
  if (Math.abs(change) < 1e-9) return { direction: "flat", directionLabel: "خنثی" };
  if (change > 0) return { direction: "up", directionLabel: "صعودی" };
  return { direction: "down", directionLabel: "نزولی" };
}

function buildReaction(
  symbol: string,
  label: string,
  window: ForexReactionWindow,
  windowLabel: string,
  samples: PriceSample[],
  releaseMs: number,
  afterOffsetMs: number,
  beforeTolMs: number,
  afterTolMs: number
): ForexMarketReaction | null {
  const before = nearestSample(samples, releaseMs, beforeTolMs);
  const after = nearestSample(samples, releaseMs + afterOffsetMs, afterTolMs);
  if (before === null || after === null) return null;
  const absoluteChange = after - before;
  const percentChange = before !== 0 ? (absoluteChange / before) * 100 : null;
  const { direction, directionLabel } = directionOf(absoluteChange);
  return {
    symbol,
    label,
    window,
    windowLabel,
    before,
    after,
    absoluteChange,
    percentChange,
    direction,
    directionLabel
  };
}

function measureReactionsWithSeries(
  releaseIso: string,
  medianSeries: PriceSample[],
  goldSeries: PriceSample[]
): {
  reactions: ForexMarketReaction[];
  available: boolean;
  note: string;
} {
  const releaseMs = new Date(releaseIso).getTime();
  if (!Number.isFinite(releaseMs)) {
    return {
      reactions: [],
      available: false,
      note: "داده کافی برای سنجش واکنش بازار در دسترس نیست"
    };
  }

  const windows: Array<{ window: ForexReactionWindow; label: string; offset: number; afterTol: number }> = [
    { window: "15m", label: "۱۵ دقیقه پس از انتشار", offset: 15 * 60_000, afterTol: 20 * 60_000 },
    { window: "1h", label: "۱ ساعت پس از انتشار", offset: 60 * 60_000, afterTol: 30 * 60_000 },
    { window: "eod", label: "پایان همان روز معاملاتی (تقریبی)", offset: 8 * 60 * 60_000, afterTol: 3 * 60 * 60_000 }
  ];

  const reactions: ForexMarketReaction[] = [];
  for (const w of windows) {
    const usdt = buildReaction(
      "USDT/IRT",
      "میانه تتر ایران",
      w.window,
      w.label,
      medianSeries,
      releaseMs,
      w.offset,
      45 * 60_000,
      w.afterTol
    );
    if (usdt) reactions.push(usdt);

    const xau = buildReaction(
      "XAU/USD",
      "انس طلا (دلار)",
      w.window,
      w.label,
      goldSeries,
      releaseMs,
      w.offset,
      45 * 60_000,
      w.afterTol
    );
    if (xau) reactions.push(xau);
  }

  if (!reactions.length) {
    return {
      reactions: [],
      available: false,
      note: "داده کافی برای سنجش واکنش بازار در دسترس نیست"
    };
  }

  return {
    reactions,
    available: true,
    note: "واکنش مشاهده‌شده پس از انتشار (همبستگی زمانی؛ علت قطعی ادعا نمی‌شود)"
  };
}

function buildSummaryFa(
  event: ForexEvent,
  result: ReturnType<typeof classifyResult>,
  reactionAvailable: boolean,
  reactions: ForexMarketReaction[]
): string {
  const parts: string[] = [];
  if (result.resultClass === "incomplete") {
    parts.push("انتشار انجام شده اما مقدار واقعی یا پیش‌بینی برای محاسبه غافلگیری کامل نیست.");
  } else if (result.resultClass === "inline") {
    parts.push("نتیجه تقریباً مطابق پیش‌بینی بازار بوده است.");
  } else if (result.resultClass === "better") {
    parts.push("نتیجه قوی‌تر از پیش‌بینی بوده و معمولاً با فشار حمایتی روی دلار همراه می‌شود.");
  } else {
    parts.push("نتیجه ضعیف‌تر از پیش‌بینی بوده و معمولاً با فشار نزولی روی دلار همراه می‌شود.");
  }

  if (reactionAvailable && reactions.length) {
    const usdt1h = reactions.find((r) => r.symbol === "USDT/IRT" && r.window === "1h");
    const xau1h = reactions.find((r) => r.symbol === "XAU/USD" && r.window === "1h");
    const bits: string[] = [];
    if (usdt1h) bits.push(`میانه تتر ${usdt1h.directionLabel}`);
    if (xau1h) bits.push(`انس طلا ${xau1h.directionLabel}`);
    if (bits.length) {
      parts.push(`واکنش مشاهده‌شده در بازهٔ یک‌ساعته: ${bits.join("، ")}.`);
    } else {
      parts.push("واکنش قیمتی پس از انتشار در داده‌های موجود ثبت شده است.");
    }
  } else {
    parts.push("برای سنجش واکنش طلا/تتر در این زمان‌بندی، نمونهٔ قیمت کافی ثبت نشده است.");
  }

  return parts.slice(0, 3).join(" ");
}

function toHistoricalEvent(
  event: ForexEvent,
  medianSeries: PriceSample[],
  goldSeries: PriceSample[]
): ForexHistoricalEvent {
  const result = classifyResult(event.category, event.forecast, event.actual);
  const complete = result.resultClass !== "incomplete";
  const reaction = event.date
    ? measureReactionsWithSeries(event.date, medianSeries, goldSeries)
    : {
        reactions: [],
        available: false,
        note: "داده کافی برای سنجش واکنش بازار در دسترس نیست"
      };

  return {
    id: event.id,
    title: event.title,
    titleFa: titleFaFor(event),
    category: event.category,
    country: event.country,
    date: event.date!,
    impact: event.impact,
    previous: event.previous,
    forecast: event.forecast,
    actual: event.actual,
    complete,
    surprise: result.surprise,
    surpriseDisplay: result.surpriseDisplay,
    resultClass: result.resultClass,
    resultLabel: result.resultLabel,
    summaryFa: buildSummaryFa(event, result, reaction.available, reaction.reactions),
    reactionAvailable: reaction.available,
    reactionNote: reaction.note,
    reactions: reaction.reactions,
    link: event.link
  };
}

export async function buildPreviousMonthSection(
  liveEvents: ForexEvent[],
  sourceStatus: SourceStatus,
  lastUpdated: string | null
): Promise<ForexPreviousMonthSection> {
  // Always merge latest live completed events into durable store first.
  await recordCompletedForexEvents(liveEvents);

  const { start, end, monthKey } = previousCalendarMonthRangeUtc();
  const rangeStart = start.toISOString();
  const rangeEnd = end.toISOString();
  const monthLabelFa = formatPersianMonthLabel(rangeStart);

  const history = await readHistory();
  const startMs = start.getTime();
  const endMs = end.getTime();
  const nowMs = Date.now();

  const candidates = new Map<string, ForexEvent>();
  for (const event of [...history.events, ...liveEvents]) {
    if (!isImportant(event) || event.country !== "USD" || !event.date) continue;
    const t = new Date(event.date).getTime();
    if (!Number.isFinite(t)) continue;
    if (t < startMs || t >= endMs) continue;
    if (t > nowMs) continue; // never future
    const prev = candidates.get(event.id);
    candidates.set(event.id, prev ? mergePreferRicher(prev, event) : event);
  }

  const sorted = Array.from(candidates.values()).sort(
    (a, b) => new Date(b.date ?? 0).getTime() - new Date(a.date ?? 0).getTime()
  );

  const [medianSamples, goldSamples] = await Promise.all([
    getMedianPriceSamples(),
    getGoldPriceSamples("اونس طلا به دلار")
  ]);
  const medianSeries = medianSamples;
  const goldSeries = goldSamples.map((s) => ({ t: s.t, v: s.v }));
  const events = sorted.map((event) => toHistoricalEvent(event, medianSeries, goldSeries));

  return {
    monthKey,
    monthLabelFa,
    rangeStart,
    rangeEnd,
    events,
    sourceStatus,
    lastUpdated,
    message: events.length
      ? undefined
      : "برای ماه گذشته رویداد مهم تکمیل‌شده‌ای یافت نشد."
  };
}
