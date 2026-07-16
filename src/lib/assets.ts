import type { AssetTag } from "@/lib/types";

const matchers: Array<{ tag: AssetTag; pattern: RegExp }> = [
  { tag: "USDT", pattern: /\busdt\b|tether|stablecoin|usdc|پایدار|تتر/i },
  { tag: "BTC", pattern: /\bbtc\b|bitcoin|بیت\s?کوین/i },
  { tag: "ETH", pattern: /\beth\b|ethereum|اتر(?:یوم| )/i },
  {
    tag: "MACRO",
    pattern:
      /\bfomc\b|\bcpi\b|interest rate|\bfed\b|inflation|\boil\b|\bdollar\b|sanction|regulat|\bbank\b|\bwar\b|geopolit|نرخ بهره|تورم|نفت|دلار|تحریم|رگولاتوری|بانک|جنگ|ایران|iran/i
  }
];

export function detectAssets(text: string): AssetTag[] {
  const tags = matchers.filter((matcher) => matcher.pattern.test(text)).map((matcher) => matcher.tag);
  return tags.length ? Array.from(new Set(tags)) : ["MACRO"];
}

const assetSpecific: AssetTag[] = ["USDT", "BTC", "ETH"];

export function newsCategoryFromAssets(assets: AssetTag[]): "macro" | "asset" {
  return assets.some((asset) => assetSpecific.includes(asset)) ? "asset" : "macro";
}

/** General UI labels (dashboard tags, alerts, etc.). */
const assetLabels: Record<AssetTag, string> = {
  USDT: "تتر / استیبل",
  BTC: "بیت‌کوین",
  ETH: "اتریوم",
  MACRO: "کلان / مالی"
};

/**
 * Impact-news column + filter labels.
 * Desktop RTL visual order (right → left): اقتصادی, بیت‌کوین, ETH, تتر
 * = array order first → last in an RTL grid.
 */
export type NewsLabelGroupKey = AssetTag;

export const NEWS_LABEL_GROUPS: Array<{ key: NewsLabelGroupKey; title: string }> = [
  { key: "MACRO", title: "اقتصادی" },
  { key: "BTC", title: "بیت‌کوین" },
  { key: "ETH", title: "ETH" },
  { key: "USDT", title: "تتر" }
];

/** Specific assets first so multi-tag articles land in one primary column. */
const PRIMARY_LABEL_ORDER: AssetTag[] = ["USDT", "BTC", "ETH", "MACRO"];

export function assetLabel(asset: AssetTag): string {
  return assetLabels[asset];
}

/** Impact-news display label for a category/asset tag. */
export function newsCategoryLabel(asset: AssetTag): string {
  return NEWS_LABEL_GROUPS.find((group) => group.key === asset)?.title ?? assetLabels[asset];
}

/** Primary column for impact-news grouping (exactly one column per article). */
export function primaryNewsGroup(assets: AssetTag[]): NewsLabelGroupKey {
  if (!assets.length) return "MACRO";
  return PRIMARY_LABEL_ORDER.find((tag) => assets.includes(tag)) ?? "MACRO";
}
