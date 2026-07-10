import { fetchJson, numeric } from "@/lib/http";
import { createProviderCache, ttlFromMinutes } from "@/lib/providerCache";
import type { GlobalPrice } from "@/lib/types";

const nowIso = () => new Date().toISOString();

function unavailable(symbol: GlobalPrice["symbol"], source: string, errorMessage: string): GlobalPrice {
  return {
    symbol,
    price: null,
    source,
    sourceStatus: "unavailable",
    lastUpdated: null,
    errorMessage
  };
}

async function gateTicker(pair: string, symbol: GlobalPrice["symbol"]): Promise<GlobalPrice> {
  try {
    const data = await fetchJson<Array<{ last?: string; currency_pair?: string }>>(
      `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`,
      9_000
    );
    const price = numeric(data[0]?.last);
    if (price === null) {
      return unavailable(symbol, "Gate.io", "داده قیمت دریافت نشد");
    }
    return {
      symbol,
      price,
      source: "Gate.io",
      sourceStatus: "available",
      lastUpdated: nowIso()
    };
  } catch (error) {
    return unavailable(symbol, "Gate.io", error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function tetherUsd(): Promise<GlobalPrice> {
  const gate = await gateTicker("USDT_USD", "USDT/USD");
  if (gate.sourceStatus === "available") {
    return gate;
  }

  try {
    const data = await fetchJson<{ tether?: { usd?: number } }>(
      "https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd",
      9_000
    );
    const price = numeric(data.tether?.usd);
    if (price === null) {
      return gate;
    }
    return {
      symbol: "USDT/USD",
      price,
      source: "CoinGecko",
      sourceStatus: "available",
      lastUpdated: nowIso()
    };
  } catch {
    return gate;
  }
}

const globalMarketCache = createProviderCache<GlobalPrice[]>();

async function fetchGlobalPrices(): Promise<GlobalPrice[]> {
  return Promise.all([gateTicker("BTC_USDT", "BTC/USDT"), gateTicker("ETH_USDT", "ETH/USDT"), tetherUsd()]);
}

export async function getGlobalPrices(refreshMinutes = 1): Promise<GlobalPrice[]> {
  const ttlMs = ttlFromMinutes(refreshMinutes);
  return globalMarketCache.get(`global:${refreshMinutes}`, ttlMs, fetchGlobalPrices);
}
