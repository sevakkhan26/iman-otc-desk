/**
 * Pure Impact News pipeline: Iran relevance, impact scoring, retention, dedupe.
 * No I/O — unit-tested without network.
 */

import { createHash } from "node:crypto";
import type { AssetTag, NewsCategory, NewsGroup, Severity } from "@/lib/types";

export const VISIBLE_WINDOW_MS = 72 * 60 * 60 * 1000;
export const HIGH_IMPACT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const IRAN_RELEVANCE_THRESHOLD = 42;
export const MAX_VISIBLE_ARTICLES = 40;

export type RawNewsArticle = {
  title: string;
  url?: string;
  source: string;
  publishedAt: string | null;
  sourceId: string;
  snippet?: string;
};

export type ScoredNewsArticle = {
  id: string;
  title: string;
  normalizedTitle: string;
  source: string;
  url?: string;
  publishedAt: string | null;
  fetchedAt: string;
  category: NewsCategory;
  categoryLabel: string;
  group: NewsGroup;
  assets: AssetTag[];
  severity: Severity;
  impactScore: number;
  impactReason: string;
  iranRelevanceScore: number;
  impactOnUsdtIrt: string;
  recommendedAction: string;
  status: "active";
};

/* ---------- normalization ---------- */

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeUrl(url: string | undefined): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    u.hash = "";
    // strip common tracking params
    ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"].forEach((k) =>
      u.searchParams.delete(k)
    );
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.toLowerCase()}${path}`.toLowerCase();
  } catch {
    return url.toLowerCase().split("?")[0] ?? "";
  }
}

export function idForArticle(title: string, url?: string): string {
  const key = `${normalizeTitle(title)}|${normalizeUrl(url)}`;
  return createHash("sha1").update(key).digest("hex").slice(0, 16);
}

/* ---------- keyword tables ---------- */

const IRAN_STRONG = [
  "ایران",
  "جمهوری اسلامی",
  "تهران",
  "بانک مرکزی",
  "تحریم",
  "fatf",
  "برجام",
  "سپاه",
  "صادرات نفت",
  "نرخ ارز",
  "دلار آزاد",
  "بازار ارز",
  "صرافی ایرانی",
  "رمزارز در ایران",
  "محدودیت بانکی",
  "انتقال پول",
  "swift",
  "iran",
  "iranian",
  "tehran",
  "sanctions",
  "nuclear deal",
  "jcpoa",
  "oil export",
  "banking restriction",
  "iranian exchange",
  "ofac",
  "irgc",
  "cbi"
];

const IRAN_SOFT = [
  "ریال",
  "تومان",
  "irt",
  "rial",
  "toman",
  "persian gulf",
  "خلیج فارس",
  "نفت ایران",
  "iran oil"
];

const USDT_CRYPTO_IRAN_BRIDGE = [
  "usdt",
  "tether",
  "stablecoin",
  "استیبل",
  "تتر",
  "depeg",
  "freeze",
  "wallet block",
  "sanctions compliance",
  "crypto regulation",
  "رمزارز",
  "کریپتو",
  "صرافی",
  "binance",
  "liquidity",
  "reserve report"
];

const NOISE = [
  "meme coin",
  "memecoin",
  "nft",
  "airdrop",
  "giveaway",
  "contest",
  "sponsored",
  "promotion",
  "token launch",
  "gamefi",
  "how to buy",
  "price prediction",
  "opinion:",
  "op-ed"
];

const HIGH_IMPACT_PATTERNS: Array<{ re: RegExp; reason: string; score: number }> = [
  { re: /\b(sanction|sanctions|ofac|تحریم)\b/i, reason: "تحریم یا محدودیت بین‌المللی مرتبط با ایران", score: 92 },
  { re: /\b(tether|usdt).{0,40}(freeze|freez|block|blacklist)|wallet.{0,20}(freeze|block)/i, reason: "انسداد/فریز کیف‌پول تتر", score: 95 },
  { re: /\b(swift|banking restriction|محدودیت بانکی|قطع.*سوئیفت)\b/i, reason: "محدودیت بانکی/SWIFT", score: 90 },
  { re: /\b(depeg|lost (its )?peg|reserves? crisis)\b/i, reason: "ریسک depeg یا ذخیره استیبل‌کوین", score: 88 },
  { re: /\b(central bank|بانک مرکزی).{0,30}(fx|currency|ارز|نرخ|policy)/i, reason: "سیاست ارزی بانک مرکزی", score: 86 },
  { re: /\b(nuclear|برجام|jcpoa|escalation|حمله|missile).{0,40}(iran|ایران)/i, reason: "تشدید ژئوپلیتیک مرتبط با ایران", score: 88 },
  { re: /\b(crypto|رمزارز).{0,30}(ban|restriction|ممنوع|محدود).{0,30}(iran|ایران|user)/i, reason: "محدودیت رمزارز برای کاربران ایرانی", score: 87 },
  { re: /\b(oil export|صادرات نفت).{0,30}(iran|ایران|disrupt)/i, reason: "اختلال صادرات نفت و اثر ارزی", score: 85 },
  { re: /\b(binance|okx|bybit|kraken).{0,40}(iran|sanction|restrict|delist iran)/i, reason: "محدودیت دسترسی صرافی جهانی برای ایران", score: 86 }
];

const MEDIUM_IMPACT_PATTERNS: Array<{ re: RegExp; reason: string; score: number }> = [
  { re: /\bfatf\b|اف‌ای‌تی‌اف|گروه ویژه/i, reason: "توسعه مرتبط با FATF", score: 62 },
  { re: /\b(regulat|regulation|رگولاتور|لایحه|پیشنهاد قانونی)\b/i, reason: "پیشنهاد یا مقررات جدید", score: 58 },
  { re: /\b(compliance|kyc|aml)\b/i, reason: "سیاست انطباق صرافی/استیبل‌کوین", score: 55 },
  { re: /\b(regional|middle east|خاورمیانه).{0,30}(tension|tensions|بحران)/i, reason: "تحولات سیاسی منطقه‌ای متوسط", score: 52 },
  { re: /\b(interest rate|فدرال|fed|cpi|تورم)\b/i, reason: "تحول کلان با اثر غیرمستقیم بر دلار/تتر", score: 50 }
];

const LOW_IMPACT_PATTERNS: Array<{ re: RegExp; reason: string; score: number }> = [
  { re: /\b(opinion|analysis|explainer|what is|چیست|آموزش|نظر)\b/i, reason: "تحلیل/آموزش عمومی بدون اثر فوری", score: 28 },
  { re: /\b(price prediction|market update|weekly)\b/i, reason: "به‌روزرسانی عمومی بازار", score: 25 }
];

/* ---------- scoring ---------- */

function containsAny(hay: string, needles: string[]): string[] {
  const hits: string[] = [];
  for (const n of needles) {
    if (hay.includes(n.toLowerCase())) hits.push(n);
  }
  return hits;
}

export function scoreIranRelevance(title: string, snippet = ""): number {
  const text = `${title} ${snippet}`.toLowerCase();
  if (NOISE.some((n) => text.includes(n))) return 0;

  let score = 0;
  const strong = containsAny(text, IRAN_STRONG);
  const soft = containsAny(text, IRAN_SOFT);
  const bridge = containsAny(text, USDT_CRYPTO_IRAN_BRIDGE);

  score += Math.min(70, strong.length * 28);
  score += Math.min(20, soft.length * 10);
  score += Math.min(25, bridge.length * 8);

  // Crypto-only without Iran context: weak
  const hasCryptoOnly =
    bridge.length > 0 &&
    strong.length === 0 &&
    soft.length === 0 &&
    !/\b(iran|iranian|tehran|ایران|تهران|تحریم|sanction)\b/i.test(text);

  if (hasCryptoOnly) {
    // Keep only if stablecoin/tether operational risk (global liquidity still matters for OTC)
    const tetherOps =
      /\b(usdt|tether|stablecoin|depeg|freeze|reserve)\b/i.test(text) &&
      /\b(freeze|depeg|reserve|blacklist|sanction|compliance|halt|suspend)\b/i.test(text);
    score = tetherOps ? Math.max(score, 48) : Math.min(score, 30);
  }

  // Generic "crypto market" alone → reject
  if (
    /\b(crypto|bitcoin|btc|ethereum)\b/i.test(text) &&
    strong.length === 0 &&
    soft.length === 0 &&
    !/\b(usdt|tether|stablecoin|sanction|iran|ایران)\b/i.test(text)
  ) {
    score = Math.min(score, 20);
  }

  return Math.max(0, Math.min(100, score));
}

export function classifyImpact(title: string, snippet = ""): {
  severity: Severity;
  impactScore: number;
  impactReason: string;
} {
  const text = `${title} ${snippet}`;

  for (const rule of HIGH_IMPACT_PATTERNS) {
    if (rule.re.test(text)) {
      return { severity: "high", impactScore: rule.score, impactReason: rule.reason };
    }
  }
  for (const rule of MEDIUM_IMPACT_PATTERNS) {
    if (rule.re.test(text)) {
      return { severity: "medium", impactScore: rule.score, impactReason: rule.reason };
    }
  }
  for (const rule of LOW_IMPACT_PATTERNS) {
    if (rule.re.test(text)) {
      return { severity: "low", impactScore: rule.score, impactReason: rule.reason };
    }
  }

  // Default by relevance signals
  const iran = scoreIranRelevance(title, snippet);
  if (iran >= 70) {
    return { severity: "medium", impactScore: 55, impactReason: "مرتبط با ایران؛ اثر متوسط محتمل" };
  }
  if (iran >= IRAN_RELEVANCE_THRESHOLD) {
    return { severity: "low", impactScore: 35, impactReason: "مرتبط با بازار ایران؛ اثر فوری محدود" };
  }
  return { severity: "low", impactScore: 20, impactReason: "اثر عملیاتی مستقیم مشخص نیست" };
}

export function buildImpactNote(severity: Severity, title: string, snippet = ""): string {
  const text = `${title} ${snippet}`.toLowerCase();
  if (/\b(depeg|peg)\b/.test(text)) return "احتمال افزایش تقاضای تتر و فشار بر نرخ دلار";
  if (/\b(freeze|block|blacklist)\b/.test(text) && /\b(tether|usdt|wallet)\b/.test(text)) {
    return "ریسک محدودیت دسترسی کاربران ایرانی";
  }
  if (/\b(sanction|تحریم|ofac)\b/.test(text)) {
    return "احتمال افزایش پرمیوم USDT/IRT و فشار نقدشوندگی";
  }
  if (/\b(swift|bank|بانک|banking)\b/.test(text)) {
    return "ریسک مسیرهای پرداخت و انتقال؛ پایش نقدینگی";
  }
  if (severity === "high") return "احتمال اثر مستقیم روی قیمت‌گذاری تتر و مدیریت ریسک";
  if (severity === "medium") return "اثر مستقیم محدود؛ نیازمند پایش";
  return "اثر احتمالی کم؛ پایش عمومی بازار";
}

export function buildRecommendedAction(severity: Severity): string {
  if (severity === "high") {
    return "Spread و Max Order بازبینی شود؛ LP و مسیر نقدینگی با احتیاط مدیریت شود.";
  }
  if (severity === "medium") {
    return "خبر در مانیتورینگ بماند؛ آستانه‌ها و اتصال منابع بررسی شود.";
  }
  return "ثبت برای پایش؛ بدون داده تکمیلی اقدام قیمتی قطعی نشود.";
}

export function categorizeArticle(title: string, snippet = ""): {
  category: NewsCategory;
  categoryLabel: string;
  group: NewsGroup;
  assets: AssetTag[];
} {
  const text = `${title} ${snippet}`.toLowerCase();
  const assets: AssetTag[] = [];

  if (/\b(usdt|tether|stablecoin|تتر|استیبل)\b/.test(text)) assets.push("USDT");
  if (/\b(btc|bitcoin|بیت\s?کوین)\b/.test(text)) assets.push("BTC");
  if (/\b(eth|ethereum|اتریوم)\b/.test(text)) assets.push("ETH");
  if (
    /\b(iran|ایران|sanction|تحریم|fatf|oil|نفت|fx|دلار|بانک|swift|geopolit|جنگ)\b/.test(text)
  ) {
    assets.push("MACRO");
  }
  if (!assets.length) assets.push("MACRO");

  let categoryLabel = "کلان / مالی";
  if (/\b(usdt|tether|stablecoin|تتر)\b/.test(text)) categoryLabel = "تتر / استیبل‌کوین";
  else if (/\b(sanction|تحریم|ofac|iran|ایران)\b/.test(text)) categoryLabel = "ایران / تحریم";
  else if (/\b(dollar|fx|currency|دلار|ارز|نرخ ارز)\b/.test(text)) categoryLabel = "دلار / ارز";
  else if (/\b(regulat|crypto ban|رمزارز|regulation)\b/.test(text)) categoryLabel = "مقررات رمزارز";
  else if (/\b(war|missile|nuclear|ژئو|geopolit|برجام)\b/.test(text)) categoryLabel = "ژئوپلیتیک";
  else if (/\b(bank|swift|payment|بانک|پرداخت)\b/.test(text)) categoryLabel = "بانکداری / پرداخت";
  else if (/\b(oil|نفت|energy|انرژی)\b/.test(text)) categoryLabel = "نفت / انرژی";

  const group: NewsGroup =
    /\b(iran|iranian|tehran|ایران|تهران|تحریم|sanction)\b/.test(text)
      ? "iran"
      : /\b(withdrawal|deposit|outage|maintenance|api|صرافی|واریز|برداشت)\b/.test(text)
        ? "lp"
        : "global";

  const category: NewsCategory = assets.some((a) => a === "USDT" || a === "BTC" || a === "ETH") ? "asset" : "macro";

  return { category, categoryLabel, group, assets: Array.from(new Set(assets)) };
}

export function scoreAndBuildArticle(raw: RawNewsArticle, fetchedAt = new Date().toISOString()): ScoredNewsArticle | null {
  const title = raw.title.trim();
  if (!title) return null;

  const snippet = raw.snippet ?? "";
  const iranRelevanceScore = scoreIranRelevance(title, snippet);
  if (iranRelevanceScore < IRAN_RELEVANCE_THRESHOLD) return null;

  const impact = classifyImpact(title, snippet);
  const cats = categorizeArticle(title, snippet);
  const impactOnUsdtIrt = buildImpactNote(impact.severity, title, snippet);

  return {
    id: idForArticle(title, raw.url),
    title,
    normalizedTitle: normalizeTitle(title),
    source: raw.source,
    url: raw.url,
    publishedAt: raw.publishedAt,
    fetchedAt,
    category: cats.category,
    categoryLabel: cats.categoryLabel,
    group: cats.group,
    assets: cats.assets,
    severity: impact.severity,
    impactScore: impact.impactScore,
    impactReason: impact.impactReason,
    iranRelevanceScore,
    impactOnUsdtIrt,
    recommendedAction: buildRecommendedAction(impact.severity),
    status: "active"
  };
}

/* ---------- retention ---------- */

export function isWithinRetention(
  publishedAt: string | null,
  severity: Severity,
  nowMs = Date.now()
): boolean {
  if (!publishedAt) return false;
  const t = new Date(publishedAt).getTime();
  if (!Number.isFinite(t)) return false;
  const age = nowMs - t;
  if (age < 0) return true; // clock skew: treat as fresh
  if (severity === "high") return age <= HIGH_IMPACT_WINDOW_MS;
  return age <= VISIBLE_WINDOW_MS;
}

export function filterByRetention<T extends { publishedAt: string | null; severity: Severity }>(
  items: T[],
  nowMs = Date.now()
): T[] {
  return items.filter((item) => isWithinRetention(item.publishedAt, item.severity, nowMs));
}

/* ---------- dedupe ---------- */

function titleTokens(normalized: string): Set<string> {
  return new Set(normalized.split(" ").filter((t) => t.length > 2));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const SOURCE_WEIGHT: Record<string, number> = {
  reuters: 10,
  "associated press": 10,
  bloomberg: 9,
  "financial times": 9,
  "wall street journal": 9,
  bbc: 8,
  "al jazeera": 7,
  coindesk: 6,
  cointelegraph: 5,
  "google news": 3
};

function sourceWeight(source: string): number {
  const s = source.toLowerCase();
  for (const [key, w] of Object.entries(SOURCE_WEIGHT)) {
    if (s.includes(key)) return w;
  }
  return 4;
}

function articleStrength(item: ScoredNewsArticle): number {
  return (
    item.impactScore * 2 +
    item.iranRelevanceScore +
    sourceWeight(item.source) * 3 +
    (item.publishedAt ? new Date(item.publishedAt).getTime() / 1e12 : 0)
  );
}

export function dedupeArticles(items: ScoredNewsArticle[]): ScoredNewsArticle[] {
  const byUrl = new Map<string, ScoredNewsArticle>();
  const noUrl: ScoredNewsArticle[] = [];

  for (const item of items) {
    const nu = normalizeUrl(item.url);
    if (nu) {
      const prev = byUrl.get(nu);
      if (!prev || articleStrength(item) > articleStrength(prev)) byUrl.set(nu, item);
    } else {
      noUrl.push(item);
    }
  }

  const merged = [...byUrl.values(), ...noUrl];
  const kept: ScoredNewsArticle[] = [];

  for (const item of merged.sort((a, b) => articleStrength(b) - articleStrength(a))) {
    const tokens = titleTokens(item.normalizedTitle);
    const t = item.publishedAt ? new Date(item.publishedAt).getTime() : 0;
    const duplicate = kept.some((other) => {
      const otherTokens = titleTokens(other.normalizedTitle);
      const sim = jaccard(tokens, otherTokens);
      const ot = other.publishedAt ? new Date(other.publishedAt).getTime() : 0;
      const closeTime = t && ot ? Math.abs(t - ot) < 36 * 60 * 60 * 1000 : true;
      return sim >= 0.55 && closeTime;
    });
    if (!duplicate) kept.push(item);
  }

  return kept;
}

/* ---------- sort ---------- */

const SEVERITY_RANK: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

export function sortArticlesForDisplay<
  T extends { severity: Severity; publishedAt: string | null; impactScore?: number; source?: string }
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const sr = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (sr !== 0) return sr;
    const is = (b.impactScore ?? 0) - (a.impactScore ?? 0);
    if (is !== 0) return is;
    const ta = new Date(a.publishedAt ?? 0).getTime();
    const tb = new Date(b.publishedAt ?? 0).getTime();
    if (tb !== ta) return tb - ta;
    return sourceWeight(b.source ?? "") - sourceWeight(a.source ?? "");
  });
}

export function tickerEligible<T extends { severity: Severity; publishedAt: string | null }>(
  items: T[],
  nowMs = Date.now()
): T[] {
  return filterByRetention(
    items.filter((i) => i.severity === "high" || i.severity === "medium"),
    nowMs
  );
}
