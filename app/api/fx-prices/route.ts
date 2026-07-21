import { NextResponse } from "next/server";
import { getFxStreetPrices } from "@/lib/providers/fxStreet";
import { isSession, requireApiSession } from "@/lib/requireApiAuth";
import { getSettings } from "@/lib/settings";
import { serveSwr, withDeadline } from "@/lib/swrServe";
import type { FxPricesApiItem, FxPricesApiResponse, FxPricesApiSource, FxStreetQuote } from "@/lib/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 20;

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
  const session = await requireApiSession();
  if (!isSession(session)) return session;
  try {
    const response = await serveSwr(
      "api:fx-prices",
      20_000,
      10 * 60_000,
      async () => {
        const settings = await getSettings();
        const data = await withDeadline(getFxStreetPrices(settings), 10_000, "fx");
        const items = data.quotes.map(toApiItem).filter((item) => item.status === "ok" && hasValidPrice(item));
        const body: FxPricesApiResponse = {
          items,
          lastUpdated: data.lastUpdated ?? undefined,
          notes: items.length ? (data.stale ? data.notes : undefined) : data.notes
        };
        return body;
      }
    );
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