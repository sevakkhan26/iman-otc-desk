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

const MAX_STALE_MS = 6 * 60 * 60_000;
const FRESH_MS = 15 * 60_000;

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

export type DollarSourceBubbleCard = {
  sourceId: string;
  sourceName: string;
  available: boolean;
  unavailableReason: string | null;
  dirham: {
    buy: number | null;
    sell: number | null;
    mid: number | null;
    lastUpdated: string | null;
    referenceOnly: boolean;
  };
  marketDollar: {
    buy: number | null;
    sell: number | null;
    mid: number | null;
    lastUpdated: string | null;
    assetLabel: string;
    referenceOnly: boolean;
  };
  mid: DollarSideBubble | null;
  buy: DollarSideBubble | null;
  sell: DollarSideBubble | null;
  health: BubbleSourceHealth;
};

export type GoldSourceBubbleCard = {
  sourceId: string;
  sourceName: string;
  available: boolean;
  unavailableReason: string | null;
  detail: GoldBubbleDetail | null;
  inputs: {
    ounceUsd: number | null;
    mazaneToman: number | null;
    dirhamToman: number | null;
    dirhamSourceId: string | null;
    dirhamSourceName: string | null;
    crossSourceDirham: boolean;
  };
  health: BubbleSourceHealth;
};

export type MarketBubbleResponse = {
  lastUpdated: string | null;
  notes: string[];
  dollar: {
    summary: DollarSideBubble | null;
    summaryUnavailableReason: string | null;
    sources: DollarSourceBubbleCard[];
  };
  gold: {
    summary: GoldBubbleDetail | null;
    summaryUnavailableReason: string | null;
    sources: GoldSourceBubbleCard[];
  };
  health: BubbleSourceHealth[];
};

function ageMs(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

function isFreshEnough(iso: string | null | undefined): boolean {
  const age = ageMs(iso);
  if (age === null) return true;
  if (age < 0) return true;
  return age <= MAX_STALE_MS;
}

function isStale(iso: string | null | undefined): boolean {
  const age = ageMs(iso);
  if (age === null) return false;
  return age > FRESH_MS;
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

function isReferenceOnly(buy: number | null, sell: number | null): boolean {
  if (buy === null || sell === null) return true;
  if (!(buy > 0 && sell > 0)) return true;
  return Math.abs(buy - sell) / Math.max(buy, sell) <= 0.0001;
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

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function paperDollarAssetsFor(sourceId: string): string[] {
  if (sourceId === "bonbast") return ["دلار بن‌بست", "دلار کاغذی"];
  return ["دلار کاغذی"];
}

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
        isFreshEnough(q.lastUpdated)
    );
    if (hit) return hit;
  }
  return null;
}

function findGold(
  quotes: GoldMarketQuote[],
  sourceId: string,
  instrument: GoldMarketQuote["instrument"]
): GoldMarketQuote | null {
  return (
    quotes.find(
      (q) =>
        q.sourceId === sourceId &&
        q.instrument === instrument &&
        q.status !== "unavailable" &&
        isFreshEnough(q.lastUpdated)
    ) ?? null
  );
}

function sideBubble(
  dirham: number,
  market: number,
  side: DollarSideBubble["side"]
): DollarSideBubble | null {
  const legs = computeDollarBubble(dirham, market);
  if (!legs) return null;
  return { ...legs, dirhamToman: dirham, side };
}

function buildDollarSourceCard(
  sourceId: string,
  sourceName: string,
  fxQuotes: FxStreetQuote[]
): DollarSourceBubbleCard {
  const dirhamQ = findFx(fxQuotes, sourceId, ["درهم امارات"]);
  const dollarQ = findFx(fxQuotes, sourceId, paperDollarAssetsFor(sourceId));

  const health: BubbleSourceHealth = {
    scope: "dollar",
    sourceId,
    sourceName,
    status:
      dirhamQ && dollarQ
        ? dirhamQ.status === "degraded" || dollarQ.status === "degraded"
          ? "degraded"
          : "available"
        : "unavailable",
    lastUpdated: latestIso([dirhamQ?.lastUpdated, dollarQ?.lastUpdated]),
    stale: isStale(dirhamQ?.lastUpdated) || isStale(dollarQ?.lastUpdated),
    note: null
  };

  if (!dirhamQ || !dollarQ) {
    return {
      sourceId,
      sourceName,
      available: false,
      unavailableReason: "داده کافی برای محاسبه حباب در دسترس نیست",
      dirham: {
        buy: null,
        sell: null,
        mid: null,
        lastUpdated: dirhamQ?.lastUpdated ?? null,
        referenceOnly: true
      },
      marketDollar: {
        buy: null,
        sell: null,
        mid: null,
        lastUpdated: dollarQ?.lastUpdated ?? null,
        assetLabel: paperDollarAssetsFor(sourceId)[0]!,
        referenceOnly: true
      },
      mid: null,
      buy: null,
      sell: null,
      health
    };
  }

  const dBuy = inBand(dirhamQ.buyPrice, DIRHAM_MIN, DIRHAM_MAX);
  const dSell = inBand(dirhamQ.sellPrice, DIRHAM_MIN, DIRHAM_MAX);
  const dMid = inBand(pickPrice(dBuy, dSell, dirhamQ.midPrice), DIRHAM_MIN, DIRHAM_MAX);

  const mBuy = inBand(dollarQ.buyPrice, DOLLAR_MIN, DOLLAR_MAX);
  const mSell = inBand(dollarQ.sellPrice, DOLLAR_MIN, DOLLAR_MAX);
  const mMid = inBand(pickPrice(mBuy, mSell, dollarQ.midPrice), DOLLAR_MIN, DOLLAR_MAX);

  const dirhamRefOnly = isReferenceOnly(dirhamQ.buyPrice, dirhamQ.sellPrice);
  const dollarRefOnly = isReferenceOnly(dollarQ.buyPrice, dollarQ.sellPrice);

  let buy: DollarSideBubble | null = null;
  let sell: DollarSideBubble | null = null;
  if (!dirhamRefOnly && !dollarRefOnly && dBuy !== null && dSell !== null && mBuy !== null && mSell !== null) {
    buy = sideBubble(dBuy, mBuy, "buy");
    sell = sideBubble(dSell, mSell, "sell");
  }

  const mid =
    dMid !== null && mMid !== null
      ? sideBubble(dMid, mMid, dirhamRefOnly || dollarRefOnly ? "reference" : "mid")
      : null;

  return {
    sourceId,
    sourceName,
    available: mid !== null || buy !== null || sell !== null,
    unavailableReason:
      mid || buy || sell ? null : "داده کافی برای محاسبه حباب در دسترس نیست",
    dirham: {
      buy: dBuy,
      sell: dSell,
      mid: dMid,
      lastUpdated: dirhamQ.lastUpdated,
      referenceOnly: dirhamRefOnly
    },
    marketDollar: {
      buy: mBuy,
      sell: mSell,
      mid: mMid,
      lastUpdated: dollarQ.lastUpdated,
      assetLabel: dollarQ.assetType,
      referenceOnly: dollarRefOnly
    },
    mid,
    buy,
    sell,
    health
  };
}

function buildGoldSourceCard(
  sourceId: string,
  sourceName: string,
  goldQuotes: GoldMarketQuote[],
  fxQuotes: FxStreetQuote[]
): GoldSourceBubbleCard {
  const ounceQ = findGold(goldQuotes, sourceId, "اونس طلا به دلار");
  const mazaneQ = findGold(goldQuotes, sourceId, "مثقال طلای آبشده");
  const dirhamQ = findFx(fxQuotes, sourceId, ["درهم امارات"]);

  const ounceUsd = inBand(pickPrice(ounceQ?.buyPrice ?? null, ounceQ?.sellPrice ?? null, ounceQ?.midPrice ?? null), OUNCE_MIN, OUNCE_MAX);
  const mazaneToman = inBand(
    pickPrice(mazaneQ?.buyPrice ?? null, mazaneQ?.sellPrice ?? null, mazaneQ?.midPrice ?? null),
    MAZANE_MIN,
    MAZANE_MAX
  );

  // Source-consistent Dirham only — no silent substitution from another FX source.
  const dirhamToman = dirhamQ
    ? inBand(pickPrice(dirhamQ.buyPrice, dirhamQ.sellPrice, dirhamQ.midPrice), DIRHAM_MIN, DIRHAM_MAX)
    : null;

  const health: BubbleSourceHealth = {
    scope: "gold",
    sourceId,
    sourceName,
    status:
      ounceQ && mazaneQ && dirhamQ
        ? [ounceQ.status, mazaneQ.status, dirhamQ.status].includes("degraded")
          ? "degraded"
          : "available"
        : "unavailable",
    lastUpdated: latestIso([ounceQ?.lastUpdated, mazaneQ?.lastUpdated, dirhamQ?.lastUpdated]),
    stale:
      isStale(ounceQ?.lastUpdated) || isStale(mazaneQ?.lastUpdated) || isStale(dirhamQ?.lastUpdated),
    note: dirhamQ ? null : "درهم هم‌منبع برای این منبع FX در دسترس نیست"
  };

  if (ounceUsd === null || mazaneToman === null || dirhamToman === null) {
    return {
      sourceId,
      sourceName,
      available: false,
      unavailableReason: "داده کافی برای محاسبه حباب در دسترس نیست",
      detail: null,
      inputs: {
        ounceUsd,
        mazaneToman,
        dirhamToman,
        dirhamSourceId: dirhamQ?.sourceId ?? null,
        dirhamSourceName: dirhamQ?.sourceName ?? null,
        crossSourceDirham: false
      },
      health
    };
  }

  const detail = computeGoldBubble(ounceUsd, dirhamToman, mazaneToman);
  return {
    sourceId,
    sourceName,
    available: detail !== null,
    unavailableReason: detail ? null : "داده کافی برای محاسبه حباب در دسترس نیست",
    detail,
    inputs: {
      ounceUsd,
      mazaneToman,
      dirhamToman,
      dirhamSourceId: dirhamQ!.sourceId,
      dirhamSourceName: dirhamQ!.sourceName,
      crossSourceDirham: false
    },
    health
  };
}

function dollarSummaryFromCards(cards: DollarSourceBubbleCard[]): {
  summary: DollarSideBubble | null;
  reason: string | null;
} {
  const mids = cards.map((c) => c.mid).filter((m): m is DollarSideBubble => Boolean(m));
  if (!mids.length) {
    return { summary: null, reason: "داده کافی برای محاسبه حباب در دسترس نیست" };
  }
  const dirhams = mids.map((m) => m.dirhamToman);
  const markets = mids.map((m) => m.marketDollarToman);
  const dMed = median(dirhams);
  const mMed = median(markets);
  if (dMed === null || mMed === null) {
    return { summary: null, reason: "داده کافی برای محاسبه حباب در دسترس نیست" };
  }
  const summary = sideBubble(dMed, mMed, "mid");
  return {
    summary,
    reason: summary ? null : "داده کافی برای محاسبه حباب در دسترس نیست"
  };
}

function goldSummaryFromCards(cards: GoldSourceBubbleCard[]): {
  summary: GoldBubbleDetail | null;
  reason: string | null;
} {
  const ok = cards.filter((c) => c.detail);
  if (!ok.length) {
    return { summary: null, reason: "داده کافی برای محاسبه حباب در دسترس نیست" };
  }
  const ounces = ok.map((c) => c.inputs.ounceUsd!).filter((v) => v !== null);
  const dirhams = ok.map((c) => c.inputs.dirhamToman!).filter((v) => v !== null);
  const mazanes = ok.map((c) => c.inputs.mazaneToman!).filter((v) => v !== null);
  const o = median(ounces);
  const d = median(dirhams);
  const m = median(mazanes);
  if (o === null || d === null || m === null) {
    return { summary: null, reason: "داده کافی برای محاسبه حباب در دسترس نیست" };
  }
  const summary = computeGoldBubble(o, d, m);
  return {
    summary,
    reason: summary ? null : "داده کافی برای محاسبه حباب در دسترس نیست"
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

  const dollarSources = [
    buildDollarSourceCard("navasan", "نوسان", fxQuotes),
    buildDollarSourceCard("bonbast", "بن‌بست", fxQuotes)
  ];
  const goldSources = [
    buildGoldSourceCard("navasan", "نوسان", goldQuotes, fxQuotes),
    buildGoldSourceCard("bonbast", "بن‌بست", goldQuotes, fxQuotes),
    buildGoldSourceCard("talavest", "Talavest", goldQuotes, fxQuotes)
  ];

  const dollarSum = dollarSummaryFromCards(dollarSources);
  const goldSum = goldSummaryFromCards(goldSources);

  const health: BubbleSourceHealth[] = [
    ...dollarSources.map((s) => s.health),
    ...goldSources.map((s) => s.health)
  ];

  return {
    lastUpdated: latestIso([
      fx?.lastUpdated,
      gold?.lastUpdated,
      ...dollarSources.map((s) => s.health.lastUpdated),
      ...goldSources.map((s) => s.health.lastUpdated)
    ]),
    notes,
    dollar: {
      summary: dollarSum.summary,
      summaryUnavailableReason: dollarSum.reason,
      sources: dollarSources
    },
    gold: {
      summary: goldSum.summary,
      summaryUnavailableReason: goldSum.reason,
      sources: goldSources
    },
    health
  };
}

export function bubbleSignLabel(sign: BubbleSign | null | undefined): string {
  if (sign === "positive") return "حباب مثبت";
  if (sign === "negative") return "حباب منفی / تخفیف نسبت به ارزش محاسباتی";
  if (sign === "near_zero") return "تقریباً بدون حباب";
  return "نامشخص";
}

export function bubbleSignTone(sign: BubbleSign | null | undefined): "danger" | "good" | "warn" | "muted" {
  if (sign === "positive") return "danger";
  if (sign === "negative") return "good";
  if (sign === "near_zero") return "muted";
  return "warn";
}

// re-export for tests convenience
export { classifyBubble };
