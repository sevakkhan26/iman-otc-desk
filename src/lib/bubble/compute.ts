/**
 * Build bubble page payload from existing FX + gold provider responses (no extra scrapes).
 */
import {
  classifyBubble,
  computeDollarBubble,
  computeGoldBubble,
  type BubbleSign,
  type DollarBubbleLegs,
  type GoldBubbleDetail
} from "@/lib/bubble/formulas";
import type {
  FxStreetQuote,
  FxStreetResponse,
  GoldMarketQuote,
  GoldMarketResponse,
  SourceStatus
} from "@/lib/types";

/**
 * Soft “تأخیری” marker (dashboard FRESH_PRICE_MS / provider visual warn).
 * Does NOT by itself disable derived bubble — only marks health.stale.
 */
export const BUBBLE_WARN_AGE_MS = 15 * 60_000;

/**
 * Hard max age for bubble calculation inputs.
 * Prefer fresh data, but allow up to 48h so the page still paints from PostgreSQL
 * source caches during DNS/proxy outages (still marked stale in health/notes).
 * Override with BUBBLE_INPUT_MAX_AGE_HOURS (e.g. 2 for strict mode).
 *
 * IMPORTANT: Must match provider OFFLINE_DISPLAY_TTL_MS (gold/fx 48h).
 * A shorter gate (e.g. 6h) silently empties /bubble while gold-prices/fx still paint.
 */
export const BUBBLE_INPUT_MAX_AGE_MS =
  Math.max(1, Number(process.env.BUBBLE_INPUT_MAX_AGE_HOURS ?? 48) || 48) * 60 * 60_000;

/**
 * Quote eligibility window for bubble raw inputs — same as BUBBLE_INPUT_MAX_AGE_MS.
 * Kept as an alias so findFx / gold collectors share one offline horizon with providers.
 */
const MAX_STALE_MS = BUBBLE_INPUT_MAX_AGE_MS;

/**
 * Max allowed skew among ounce / dirham / mazane of the *same* provider.
 * Must tolerate normal multi-instrument lag (gold API vs FX API, different Navasan rate.date fields)
 * while still blocking multi-hour skew (e.g. live ounce + 4h-old FX).
 */
export const BUBBLE_INPUT_ALIGN_MS = 90 * 60_000;

export const MSG_STALE_BUBBLE = "داده قدیمی؛ محاسبه حباب غیرفعال است";
export const MSG_MISALIGNED_BUBBLE = "زمان ورودی‌ها با یکدیگر هماهنگ نیست";
export const MSG_INSUFFICIENT_BUBBLE = "داده کافی برای محاسبه حباب در دسترس نیست";

/** Sanity bands (Toman / USD) — reject unit mix and garbage without inventing. */
const DIRHAM_MIN = 5_000;
const DIRHAM_MAX = 500_000;
const DOLLAR_MIN = 50_000;
const DOLLAR_MAX = 2_000_000;
const OUNCE_MIN = 500;
const OUNCE_MAX = 15_000;
const MAZANE_MIN = 1_000_000;
const MAZANE_MAX = 500_000_000;

export type BubbleSourceHealth = {
  /** Distinguishes dollar vs gold health rows that share the same provider id. */
  scope: "dollar" | "gold";
  sourceId: string;
  sourceName: string;
  status: SourceStatus;
  lastUpdated: string | null;
  stale: boolean;
  note: string | null;
};

export type DollarSideBubble = DollarBubbleLegs & {
  dirhamToman: number;
  side: "buy" | "sell" | "mid" | "reference";
};

/** One FX contribution to the consolidated dollar average. */
export type DollarAverageMember = {
  sourceId: string;
  sourceName: string;
  price: number;
  lastUpdated: string | null;
  assetLabel?: string;
};

/** Single canonical dollar bubble (arithmetic means of valid sources). */
export type ConsolidatedDollarBubble = {
  averageDirhamToman: number;
  calculatedDollarToman: number;
  averageMarketDollarToman: number;
  bubbleToman: number;
  bubblePercent: number;
  sign: BubbleSign;
  dirhamSources: DollarAverageMember[];
  marketDollarSources: DollarAverageMember[];
  dirhamSourceCount: number;
  marketDollarSourceCount: number;
  lastUpdated: string | null;
};

/** Single canonical gold bubble from arithmetic means of valid inputs (no per-provider cards). */
export type ConsolidatedGoldBubble = GoldBubbleDetail & {
  averageOunceUsd: number;
  averageDirhamToman: number;
  averageMazaneToman: number;
  ounceSourceCount: number;
  dirhamSourceCount: number;
  mazaneSourceCount: number;
  lastUpdated: string | null;
};

export type MarketBubbleResponse = {
  lastUpdated: string | null;
  notes: string[];
  dollar: {
    consolidated: ConsolidatedDollarBubble | null;
    unavailableReason: string | null;
  };
  gold: {
    consolidated: ConsolidatedGoldBubble | null;
    unavailableReason: string | null;
  };
  health: BubbleSourceHealth[];
  /** Server wall clock (UTC ISO) — shared header clock for all clients. */
  serverNow?: string;
  generatedAt?: string;
  isStale?: boolean;
  lastSuccessfulRefreshAt?: string | null;
  lastAttemptedRefreshAt?: string | null;
  refreshIntervalMs?: number;
};

export const MSG_DOLLAR_INSUFFICIENT = "داده معتبر کافی در دسترس نیست";
export const MSG_GOLD_INSUFFICIENT = "داده معتبر کافی در دسترس نیست";

/** Parse ISO (already UTC from providers via toUtcIso / Date.toISOString) → epoch ms. */
export function parseBubbleTimestampUtc(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function ageMs(iso: string | null | undefined, nowMs: number = Date.now()): number | null {
  const t = parseBubbleTimestampUtc(iso);
  if (t === null) return null;
  return nowMs - t;
}

/** Quote still within the long cache window (may still be «تأخیری» for bubble output). */
function isWithinCacheWindow(iso: string | null | undefined, nowMs: number = Date.now()): boolean {
  const age = ageMs(iso, nowMs);
  if (age === null) return true; // missing timestamp: do not discard value
  if (age < 0) return true;
  return age <= MAX_STALE_MS;
}

/**
 * Hard freshness for derived bubble.
 * Missing timestamp → allow (providers sometimes omit; value still present).
 * Present timestamp → age must be ≤ BUBBLE_INPUT_MAX_AGE_MS (default 48h).
 */
export function isBubbleInputFresh(iso: string | null | undefined, nowMs: number = Date.now()): boolean {
  const age = ageMs(iso, nowMs);
  if (age === null) return true;
  if (age < 0) return true;
  return age <= BUBBLE_INPUT_MAX_AGE_MS;
}

/**
 * Gate for gold bubble inputs of a single provider.
 * - Null timestamps are skipped for skew (not treated as year-1970 / ancient).
 * - Any present timestamp older than MAX_AGE → stale.
 * - Span of present timestamps > ALIGN → misaligned (hours of skew, not minutes).
 */
export function areBubbleInputsAligned(
  timestamps: Array<string | null | undefined>,
  nowMs: number = Date.now()
): { ok: boolean; reason: "ok" | "stale" | "misaligned" } {
  const times: number[] = [];
  for (const iso of timestamps) {
    const t = parseBubbleTimestampUtc(iso);
    if (t === null) continue;
    const age = nowMs - t;
    if (age > BUBBLE_INPUT_MAX_AGE_MS) return { ok: false, reason: "stale" };
    times.push(t);
  }
  if (times.length >= 2) {
    const span = Math.max(...times) - Math.min(...times);
    if (span > BUBBLE_INPUT_ALIGN_MS) return { ok: false, reason: "misaligned" };
  }
  return { ok: true, reason: "ok" };
}

export function bubbleGateMessage(reason: "stale" | "misaligned" | "insufficient"): string {
  if (reason === "stale") return MSG_STALE_BUBBLE;
  if (reason === "misaligned") return MSG_MISALIGNED_BUBBLE;
  return MSG_INSUFFICIENT_BUBBLE;
}

function inBand(value: number | null, min: number, max: number): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  if (value < min || value > max) return null;
  return value;
}

function pickPrice(buy: number | null, sell: number | null, mid: number | null): number | null {
  if (mid !== null && Number.isFinite(mid) && mid > 0) return mid;
  if (buy !== null && sell !== null && buy > 0 && sell > 0) return (buy + sell) / 2;
  const single = buy ?? sell;
  if (single !== null && single > 0) return single;
  return null;
}

function latestIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const v of values) {
    if (!v) continue;
    const t = Date.parse(v);
    if (!Number.isFinite(t)) continue;
    if (t > bestMs) {
      bestMs = t;
      best = v;
    }
  }
  return best;
}

function arithmeticMean(values: number[]): number | null {
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  const avg = sum / values.length;
  return Number.isFinite(avg) ? avg : null;
}

function paperDollarAssetsFor(sourceId: string): string[] {
  if (sourceId === "bonbast") return ["دلار بن‌بست", "دلار کاغذی"];
  return ["دلار کاغذی"];
}

const DOLLAR_FX_SOURCES: Array<{ id: string; name: string }> = [
  { id: "navasan", name: "نوسان" },
  { id: "bonbast", name: "بن‌بست" }
];

function findFx(
  quotes: FxStreetQuote[],
  sourceId: string,
  assets: string[]
): FxStreetQuote | null {
  for (const asset of assets) {
    const hit = quotes.find(
      (q) =>
        q.sourceId === sourceId &&
        q.assetType === asset &&
        q.status !== "unavailable" &&
        isWithinCacheWindow(q.lastUpdated)
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Collect one mid price per FX source for dirham / market-dollar averages.
 * Requires bubble-fresh timestamp and valid positive price in-band.
 */
function collectValidFxMembers(
  fxQuotes: FxStreetQuote[],
  kind: "dirham" | "marketDollar",
  nowMs: number
): DollarAverageMember[] {
  const members: DollarAverageMember[] = [];
  for (const src of DOLLAR_FX_SOURCES) {
    const assets = kind === "dirham" ? (["درهم امارات"] as string[]) : paperDollarAssetsFor(src.id);
    const q = findFx(fxQuotes, src.id, assets);
    if (!q) continue;
    if (!isBubbleInputFresh(q.lastUpdated, nowMs)) continue;
    const band = kind === "dirham" ? [DIRHAM_MIN, DIRHAM_MAX] : [DOLLAR_MIN, DOLLAR_MAX];
    const price = inBand(pickPrice(q.buyPrice, q.sellPrice, q.midPrice), band[0]!, band[1]!);
    if (price === null) continue;
    members.push({
      sourceId: src.id,
      sourceName: src.name,
      price,
      lastUpdated: q.lastUpdated,
      assetLabel: q.assetType
    });
  }
  return members;
}

export function buildConsolidatedDollarBubble(
  fxQuotes: FxStreetQuote[],
  nowMs: number = Date.now()
): { consolidated: ConsolidatedDollarBubble | null; reason: string | null } {
  const dirhamSources = collectValidFxMembers(fxQuotes, "dirham", nowMs);
  const marketDollarSources = collectValidFxMembers(fxQuotes, "marketDollar", nowMs);

  const averageDirhamToman = arithmeticMean(dirhamSources.map((m) => m.price));
  const averageMarketDollarToman = arithmeticMean(marketDollarSources.map((m) => m.price));

  if (averageDirhamToman === null || averageMarketDollarToman === null) {
    return { consolidated: null, reason: MSG_DOLLAR_INSUFFICIENT };
  }

  const legs = computeDollarBubble(averageDirhamToman, averageMarketDollarToman);
  if (!legs) {
    return { consolidated: null, reason: MSG_DOLLAR_INSUFFICIENT };
  }

  return {
    consolidated: {
      averageDirhamToman,
      calculatedDollarToman: legs.realDollarToman,
      averageMarketDollarToman,
      bubbleToman: legs.bubbleToman,
      bubblePercent: legs.bubblePercent,
      sign: legs.sign,
      dirhamSources,
      marketDollarSources,
      dirhamSourceCount: dirhamSources.length,
      marketDollarSourceCount: marketDollarSources.length,
      lastUpdated: latestIso([
        ...dirhamSources.map((m) => m.lastUpdated),
        ...marketDollarSources.map((m) => m.lastUpdated)
      ])
    },
    reason: null
  };
}

/** Explicit dollar comparison wording (same sign as local−global: market − calculated). */
export function dollarBubblePrimaryStatus(sign: BubbleSign | null | undefined): string {
  if (sign === "positive") return "دلار بازار از ارزش محاسباتی درهم گران‌تر است";
  if (sign === "negative") return "دلار بازار از ارزش محاسباتی درهم ارزان‌تر است";
  if (sign === "near_zero") return "دلار بازار و ارزش محاسباتی تقریباً برابرند";
  return "نامشخص";
}

/** Single compact result sentence for the dollar card (live %; never hardcoded). */
export function dollarBubbleSupportSentence(
  sign: BubbleSign | null | undefined,
  bubblePercent: number | null | undefined
): string {
  if (sign === "near_zero") {
    return "دلار بازار تقریباً برابر با ارزش محاسباتی درهم است.";
  }
  if (sign !== "positive" && sign !== "negative") return "";
  if (bubblePercent == null || !Number.isFinite(bubblePercent)) {
    return sign === "positive"
      ? "دلار بازار از ارزش محاسباتی درهم گران‌تر است."
      : "دلار بازار از ارزش محاسباتی درهم ارزان‌تر است.";
  }
  const abs = Math.abs(bubblePercent);
  const pctFa = new Intl.NumberFormat("fa-IR", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  }).format(abs);
  if (sign === "positive") {
    return `دلار بازار ${pctFa}٪ از ارزش محاسباتی درهم گران‌تر است.`;
  }
  return `دلار بازار ${pctFa}٪ از ارزش محاسباتی درهم ارزان‌تر است.`;
}

/**
 * Collect one fresh, in-band price per source for a gold instrument (no duplicate sourceIds).
 * Talavest may contribute ounce/mazane when present; never shown by name on the bubble UI.
 */
function collectValidGoldInstrumentPrices(
  goldQuotes: GoldMarketQuote[],
  instrument: GoldMarketQuote["instrument"],
  min: number,
  max: number,
  nowMs: number
): { prices: number[]; timestamps: Array<string | null>; count: number } {
  const bySource = new Map<string, GoldMarketQuote>();
  for (const q of goldQuotes) {
    if (q.instrument !== instrument || q.status === "unavailable") continue;
    if (!isWithinCacheWindow(q.lastUpdated, nowMs)) continue;
    if (!isBubbleInputFresh(q.lastUpdated, nowMs)) continue;
    // First quote per sourceId only
    if (!bySource.has(q.sourceId)) bySource.set(q.sourceId, q);
  }
  const prices: number[] = [];
  const timestamps: Array<string | null> = [];
  for (const q of bySource.values()) {
    const p = inBand(pickPrice(q.buyPrice, q.sellPrice, q.midPrice), min, max);
    if (p === null) continue;
    prices.push(p);
    timestamps.push(q.lastUpdated);
  }
  return { prices, timestamps, count: prices.length };
}

function collectValidDirhamPricesForGold(
  fxQuotes: FxStreetQuote[],
  nowMs: number
): { prices: number[]; timestamps: Array<string | null>; count: number } {
  const members = collectValidFxMembers(fxQuotes, "dirham", nowMs);
  return {
    prices: members.map((m) => m.price),
    timestamps: members.map((m) => m.lastUpdated),
    count: members.length
  };
}

/**
 * One gold bubble from arithmetic means of all valid ounce / dirham / mazane values.
 * Provider names are not attached to the result (UI shows a single «حباب طلا» card).
 */
export function buildConsolidatedGoldBubble(
  goldQuotes: GoldMarketQuote[],
  fxQuotes: FxStreetQuote[],
  nowMs: number = Date.now()
): { consolidated: ConsolidatedGoldBubble | null; reason: string | null } {
  const ounces = collectValidGoldInstrumentPrices(
    goldQuotes,
    "اونس طلا به دلار",
    OUNCE_MIN,
    OUNCE_MAX,
    nowMs
  );
  const mazanes = collectValidGoldInstrumentPrices(
    goldQuotes,
    "مثقال طلای آبشده",
    MAZANE_MIN,
    MAZANE_MAX,
    nowMs
  );
  const dirhams = collectValidDirhamPricesForGold(fxQuotes, nowMs);

  const averageOunceUsd = arithmeticMean(ounces.prices);
  const averageDirhamToman = arithmeticMean(dirhams.prices);
  const averageMazaneToman = arithmeticMean(mazanes.prices);

  if (averageOunceUsd === null || averageDirhamToman === null || averageMazaneToman === null) {
    return { consolidated: null, reason: MSG_GOLD_INSUFFICIENT };
  }

  // Guard multi-hour skew across the *averages' constituent timestamps*
  const gate = areBubbleInputsAligned(
    [
      latestIso(ounces.timestamps),
      latestIso(dirhams.timestamps),
      latestIso(mazanes.timestamps)
    ],
    nowMs
  );
  // Only hard-stale on the mean timestamps if present; small lag across instruments is OK (90m align).
  if (!gate.ok && gate.reason === "stale") {
    return { consolidated: null, reason: MSG_STALE_BUBBLE };
  }
  if (!gate.ok && gate.reason === "misaligned") {
    return { consolidated: null, reason: MSG_MISALIGNED_BUBBLE };
  }

  const detail = computeGoldBubble(averageOunceUsd, averageDirhamToman, averageMazaneToman);
  if (!detail) {
    return { consolidated: null, reason: MSG_GOLD_INSUFFICIENT };
  }

  return {
    consolidated: {
      ...detail,
      // Averages feed the formula; detail fields mirror those averages
      averageOunceUsd,
      averageDirhamToman,
      averageMazaneToman,
      ounceSourceCount: ounces.count,
      dirhamSourceCount: dirhams.count,
      mazaneSourceCount: mazanes.count,
      lastUpdated: latestIso([
        ...ounces.timestamps,
        ...dirhams.timestamps,
        ...mazanes.timestamps
      ])
    },
    reason: null
  };
}

export function buildMarketBubbleResponse(
  fx: FxStreetResponse | null,
  gold: GoldMarketResponse | null
): MarketBubbleResponse {
  const fxQuotes = fx?.quotes ?? [];
  const goldQuotes = gold?.quotes ?? [];
  const notes: string[] = [];
  if (fx?.notes?.length) notes.push(...fx.notes);
  if (gold?.notes?.length) notes.push(...gold.notes);
  if (fx?.stale) notes.push("بخشی از داده‌های ارز ممکن است تأخیری باشد");
  if (gold?.stale) notes.push("بخشی از داده‌های طلا ممکن است تأخیری باشد");

  const dollarBuilt = buildConsolidatedDollarBubble(fxQuotes);
  const goldBuilt = buildConsolidatedGoldBubble(goldQuotes, fxQuotes);

  const dollarHealth: BubbleSourceHealth[] = DOLLAR_FX_SOURCES.map((src) => {
    const inDirham = dollarBuilt.consolidated?.dirhamSources.some((m) => m.sourceId === src.id);
    const inMarket = dollarBuilt.consolidated?.marketDollarSources.some((m) => m.sourceId === src.id);
    const used = Boolean(inDirham || inMarket);
    return {
      scope: "dollar" as const,
      sourceId: src.id,
      sourceName: src.name,
      status: used ? ("available" as const) : ("unavailable" as const),
      lastUpdated:
        dollarBuilt.consolidated?.dirhamSources.find((m) => m.sourceId === src.id)?.lastUpdated ??
        dollarBuilt.consolidated?.marketDollarSources.find((m) => m.sourceId === src.id)?.lastUpdated ??
        null,
      stale: false,
      note: used ? "در میانگین حباب دلار لحاظ شد" : "در میانگین حباب دلار استفاده نشد"
    };
  });

  // Gold health is aggregate (no per-provider gold cards on /bubble).
  const goldHealth: BubbleSourceHealth = {
    scope: "gold",
    sourceId: "gold-consolidated",
    sourceName: "طلا",
    status: goldBuilt.consolidated ? "available" : "unavailable",
    lastUpdated: goldBuilt.consolidated?.lastUpdated ?? null,
    stale: false,
    note: goldBuilt.consolidated ? null : goldBuilt.reason
  };

  return {
    lastUpdated: latestIso([
      fx?.lastUpdated,
      gold?.lastUpdated,
      dollarBuilt.consolidated?.lastUpdated ?? null,
      goldBuilt.consolidated?.lastUpdated ?? null
    ]),
    notes,
    dollar: {
      consolidated: dollarBuilt.consolidated,
      unavailableReason: dollarBuilt.reason
    },
    gold: {
      consolidated: goldBuilt.consolidated,
      unavailableReason: goldBuilt.reason
    },
    health: [...dollarHealth, goldHealth]
  };
}

/** Dollar-side status pill (kept short). Gold uses goldBubblePrimaryStatus. */
export function bubbleSignLabel(sign: BubbleSign | null | undefined): string {
  if (sign === "positive") return "حباب مثبت";
  if (sign === "negative") return "حباب منفی / تخفیف نسبت به ارزش محاسباتی";
  if (sign === "near_zero") return "تقریباً بدون حباب";
  return "نامشخص";
}

/**
 * Explicit gold comparison direction.
 * Positive ⇔ localPureGoldKgToman − globalGoldKgToman > 0 ⇔ Iran more expensive.
 * (Subtraction order is never inverted.)
 */
export function goldBubblePrimaryStatus(sign: BubbleSign | null | undefined): string {
  if (sign === "positive") return "طلای ایران گران‌تر از ارزش جهانی است";
  if (sign === "negative") return "طلای ایران ارزان‌تر از ارزش جهانی است";
  if (sign === "near_zero") return "قیمت طلای ایران و ارزش جهانی تقریباً برابر است";
  return "نامشخص";
}

/** Supporting Persian sentence; percent is |goldBubblePercent| for signed wording. */
export function goldBubbleSupportSentence(
  sign: BubbleSign | null | undefined,
  bubblePercent: number | null | undefined
): string {
  if (sign === "near_zero") {
    return "اختلاف معناداری میان قیمت داخلی و ارزش جهانی محاسباتی وجود ندارد.";
  }
  if (sign !== "positive" && sign !== "negative") {
    return "";
  }
  if (bubblePercent == null || !Number.isFinite(bubblePercent)) {
    return sign === "positive"
      ? "قیمت طلای ایران بالاتر از ارزش جهانی محاسباتی است."
      : "قیمت طلای ایران پایین‌تر از ارزش جهانی محاسباتی است.";
  }
  const abs = Math.abs(bubblePercent);
  const pctFa = new Intl.NumberFormat("fa-IR", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0
  }).format(abs);
  if (sign === "positive") {
    return `قیمت طلای ایران ${pctFa}٪ بالاتر از ارزش جهانی محاسباتی است.`;
  }
  return `قیمت طلای ایران ${pctFa}٪ پایین‌تر از ارزش جهانی محاسباتی است.`;
}

/** Iran more expensive → red; cheaper → green; equal → neutral; invalid → warn. */
export function bubbleSignTone(sign: BubbleSign | null | undefined): "danger" | "good" | "warn" | "muted" {
  if (sign === "positive") return "danger";
  if (sign === "negative") return "good";
  if (sign === "near_zero") return "muted";
  return "warn";
}

// re-export for tests convenience
export { classifyBubble };
