/**
 * Impact News RSS / public feed definitions (server-side only).
 */

export type NewsFeedDef = {
  id: string;
  name: string;
  url: string;
  reliability: number;
  timeoutMs: number;
};

function gnews(query: string, hl = "en-US", gl = "US"): string {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${hl}&gl=${gl}&ceid=${gl}:${hl.split("-")[0]}`;
}

/** Targeted feeds — multi-source; no single fragile dependency. */
export const NEWS_FEEDS: NewsFeedDef[] = [
  {
    id: "gnews-iran-sanctions",
    name: "Google News · Iran sanctions",
    url: gnews("(Iran OR Iranian) AND (sanctions OR OFAC OR SWIFT OR banking)"),
    reliability: 7,
    timeoutMs: 12_000
  },
  {
    id: "gnews-iran-crypto",
    name: "Google News · Iran crypto",
    url: gnews("(Iran OR Iranian OR Tehran) AND (crypto OR cryptocurrency OR bitcoin OR exchange)"),
    reliability: 7,
    timeoutMs: 12_000
  },
  {
    id: "gnews-tether-stablecoin",
    name: "Google News · Tether/USDT",
    url: gnews("(USDT OR Tether OR stablecoin) AND (freeze OR depeg OR reserve OR sanction OR regulation OR blacklist)"),
    reliability: 8,
    timeoutMs: 12_000
  },
  {
    id: "gnews-iran-oil-fx",
    name: "Google News · Iran oil/FX",
    url: gnews("(Iran OR Iranian) AND (oil OR rial OR \"foreign exchange\" OR FX OR dollar)"),
    reliability: 7,
    timeoutMs: 12_000
  },
  {
    id: "gnews-fa-iran",
    name: "Google News · فارسی ایران",
    url: gnews("ایران تحریم OR تتر OR رمزارز OR بانک مرکزی OR نرخ ارز", "fa", "IR"),
    reliability: 8,
    timeoutMs: 12_000
  },
  {
    id: "coindesk-rss",
    name: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    reliability: 6,
    timeoutMs: 12_000
  },
  {
    id: "cointelegraph-rss",
    name: "Cointelegraph",
    url: "https://cointelegraph.com/rss",
    reliability: 5,
    timeoutMs: 12_000
  }
];
