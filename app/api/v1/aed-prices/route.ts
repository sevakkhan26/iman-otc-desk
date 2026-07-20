import { authorizeV1Request, v1JsonError, v1JsonOk } from "@/lib/apiKeys/v1Http";
import { buildAedPricesResponse } from "@/lib/apiKeys/marketSections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

/** GET /api/v1/aed-prices — requires aed:read */
export async function GET(request: Request) {
  const auth = await authorizeV1Request(request, "aed:read");
  if (auth instanceof Response) return auth;

  try {
    return v1JsonOk(await buildAedPricesResponse());
  } catch {
    return v1JsonError(503, "unavailable", "سرویس قیمت موقتاً در دسترس نیست");
  }
}
