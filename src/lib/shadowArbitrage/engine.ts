import { runCollectionCycle } from "@/lib/shadowArbitrage/collector";
import { loadLastMatrix } from "@/lib/shadowArbitrage/store";
import {
  SHADOW_BANNER,
  SHADOW_POLL_INTERVAL_MS,
  SHADOW_TRADE_SIZES
} from "@/lib/shadowArbitrage/config";
import type { ShadowMatrixResponse } from "@/lib/shadowArbitrage/types";

export { buildOpportunities } from "@/lib/shadowArbitrage/calculate";

function matrixFromCache(cached: {
  serverNow: string;
  sources: ShadowMatrixResponse["sources"];
  opportunities: ShadowMatrixResponse["opportunities"];
}): ShadowMatrixResponse {
  return {
    serverNow: cached.serverNow,
    shadowMode: true,
    banner: SHADOW_BANNER,
    sizes: SHADOW_TRADE_SIZES,
    sources: cached.sources,
    opportunities: cached.opportunities,
    generatedAt: cached.serverNow,
    pollIntervalMs: SHADOW_POLL_INTERVAL_MS
  };
}

/**
 * Read path for the admin API.
 *
 * The background worker is the collection mechanism; this only reads what the
 * worker persisted. `manualRefresh` may trigger one rate-limited, single-flight
 * cycle — and if that is throttled or contended we serve the cache rather than
 * hammering the venues.
 */
export async function runShadowMatrix(manualRefresh = false): Promise<ShadowMatrixResponse> {
  if (!manualRefresh) {
    const cached = await loadLastMatrix();
    if (cached?.sources?.length) return matrixFromCache(cached);
  }

  const cycle = await runCollectionCycle({
    workerId: `api-${process.pid}`,
    manual: true,
    force: false
  });
  if (cycle.matrix) return cycle.matrix;

  const cached = await loadLastMatrix();
  if (cached?.sources?.length) return matrixFromCache(cached);

  throw new Error(
    cycle.error ??
      (cycle.skipped === "rate_limited"
        ? "بروزرسانی دستی محدود شده است — منتظر چرخهٔ worker بمانید"
        : "هنوز هیچ چرخهٔ جمع‌آوری ثبت نشده است — worker را اجرا کنید")
  );
}
