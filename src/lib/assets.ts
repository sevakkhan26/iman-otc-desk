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

const assetLabels: Record<AssetTag, string> = {
  USDT: "تتر / استیبل",
  BTC: "بیت‌کوین",
  ETH: "اتریوم",
  MACRO: "کلان / مالی"
};

export function assetLabel(asset: AssetTag): string {
  return assetLabels[asset];
}
