/**
 * Official public Tether/USDT–Toman pages for Iranian exchanges.
 * Keyed by stable provider exchangeId (same IDs as settings / domestic providers).
 *
 * Only URLs verified on the official domain as public USDT price / buy-sell pages
 * are listed. Providers without a verified direct URL are omitted (unlinked in UI).
 */
export const EXCHANGE_PUBLIC_USDT_URLS: Readonly<Record<string, string>> = {
  nobitex: "https://nobitex.ir/price/usdt/",
  wallex: "https://wallex.ir/price/usdt",
  bitpin: "https://bitpin.ir/coin/USDT/",
  tabdeal: "https://tabdeal.org/usdt-price",
  ramzinex: "https://ramzinex.com/sell-and-buy/tether-usdt/",
  abantether: "https://abantether.com/coin/USDT",
  ompfinex: "https://www.ompfinex.com/coin/usdt",
  exir: "https://www.exir.io/usdt/",
  // Homepage hosts the public USDT/TMN market board (order book + rates).
  tetherland: "https://tetherland.com/",
  bit24: "https://bit24.cash/coins/usdt/",
  okex_ir: "https://ok-ex.io/buy-and-sell/USDT/",
  // Public marketing site (arzinja.info); arzinja.ir/tether was unavailable (504) at verify time.
  arzinja: "https://arzinja.info/tether"
};

export function getExchangePublicUsdtUrl(exchangeId: string): string | null {
  const url = EXCHANGE_PUBLIC_USDT_URLS[exchangeId];
  return url ?? null;
}
