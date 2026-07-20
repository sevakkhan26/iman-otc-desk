import { authenticateV1Request, v1JsonError, v1JsonOk } from "@/lib/apiKeys/v1Http";
import { buildMarketPricesResponse } from "@/lib/apiKeys/marketSections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 45;

/**
 * GET /api/v1/market-prices
 * Returns only sections authorized by the key's scopes (no unauthorized keys in `data`).
 */
export async function GET(request: Request) {
  const auth = await authenticateV1Request(request);
  if (auth instanceof Response) return auth;

  try {
    const body = await buildMarketPricesResponse(auth.scopes);
    return v1JsonOk(body);
  } catch {
    return v1JsonError(503, "unavailable", "سرویس قیمت موقتاً در دسترس نیست");
  }
}
