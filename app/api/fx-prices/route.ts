import { NextResponse } from "next/server";
import { getFxStreetPrices } from "@/lib/providers/fxStreet";
import { getSettings } from "@/lib/settings";
import type { FxPricesApiItem, FxPricesApiResponse, FxPricesApiSource, FxStreetQuote } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function hasValidPrice(item: Pick<FxPricesApiItem, "buy" | "sell" | "mid">): boolean {
  return item.buy !== null || item.sell !== null || item.mid !== null;
}

function toApiItem(quote: FxStreetQuote): FxPricesApiItem {
  return {
    source: quote.sourceId as FxPricesApiSource,
    asset: quote.assetType,
    buy: quote.buyPrice,
    sell: quote.sellPrice,
    mid: quote.midPrice,
    lastUpdated: quote.lastUpdated ?? "",
    status: "ok"
  };
}

export async function GET() {
  try {
    const settings = await getSettings();
    const data = await getFxStreetPrices(settings);
    const items = data.quotes.map(toApiItem).filter((item) => item.status === "ok" && hasValidPrice(item));
    const response: FxPricesApiResponse = {
      items,
      lastUpdated: data.lastUpdated ?? undefined,
      notes: items.length ? (data.stale ? data.notes : undefined) : data.notes
    };
    return jsonUtf8(response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "خطای نامشخص منبع";
    const response: FxPricesApiResponse = {
      items: [],
      notes: [message]
    };
    return jsonUtf8(response);
  }
}

function jsonUtf8(body: FxPricesApiResponse) {
  return new NextResponse(JSON.stringify(body), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}