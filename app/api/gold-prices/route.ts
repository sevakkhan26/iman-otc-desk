import { NextResponse } from "next/server";
import { getGoldMarketPrices } from "@/lib/providers/goldMarket";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { getSettings } from "@/lib/settings";
import type { GoldMarketQuote, GoldPricesApiItem, GoldPricesApiResponse } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function hasValidPrice(item: Pick<GoldPricesApiItem, "buy" | "sell" | "mid">): boolean {
  return item.buy !== null || item.sell !== null || item.mid !== null;
}

function toApiItem(quote: GoldMarketQuote): GoldPricesApiItem {
  return {
    source: quote.sourceId,
    instrument: quote.instrument,
    unit: quote.unit,
    buy: quote.buyPrice,
    sell: quote.sellPrice,
    mid: quote.midPrice,
    lastUpdated: quote.lastUpdated ?? "",
    status: "ok"
  };
}

export async function GET() {
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  try {
    const settings = await getSettings();
    const data = await getGoldMarketPrices(settings);
    const items = data.quotes.map(toApiItem).filter((item) => item.status === "ok" && hasValidPrice(item));
    const serverNow = new Date().toISOString();
    const response: GoldPricesApiResponse = {
      items,
      lastUpdated: data.lastUpdated ?? undefined,
      notes: items.length ? (data.stale ? data.notes : undefined) : data.notes,
      providers: data.providers,
      serverNow,
      generatedAt: data.lastUpdated ?? serverNow
    };
    return jsonUtf8(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطای نامشخص منبع";
    const serverNow = new Date().toISOString();
    const response: GoldPricesApiResponse = {
      items: [],
      notes: [message],
      serverNow,
      generatedAt: serverNow
    };
    return jsonUtf8(response);
  }
}

function jsonUtf8(body: GoldPricesApiResponse) {
  return new NextResponse(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}