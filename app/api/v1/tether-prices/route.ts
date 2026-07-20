import { authorizeV1Request, v1JsonError, v1JsonOk } from "@/lib/apiKeys/v1Http";
import { buildTetherSection } from "@/lib/apiKeys/marketSections";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

/** GET /api/v1/tether-prices — requires tether:read */
export async function GET(request: Request) {
  const auth = await authorizeV1Request(request, "tether:read");
  if (auth instanceof Response) return auth;

  try {
    const body = await buildTetherSection();
    return v1JsonOk(body);
  } catch {
    return v1JsonError(503, "unavailable", "سرویس قیمت موقتاً در دسترس نیست");
  }
}
