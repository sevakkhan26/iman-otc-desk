import { NextResponse } from "next/server";
import { checkReadiness } from "@/lib/ops/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Container readiness probe. Unauthenticated by necessity, so it returns only
 * check names and short non-sensitive details — never a connection string,
 * hostname, worker id, migration name or count of business rows.
 *
 * 200 when the database is reachable, every migration on disk is applied and a
 * collector lease is held with a fresh heartbeat; 503 otherwise. Full
 * diagnostics remain admin-only at /api/shadow-arbitrage/health.
 */
export async function GET() {
  const result = await checkReadiness();
  return NextResponse.json(result, {
    status: result.status === "ready" ? 200 : 503,
    headers: { "cache-control": "no-store" }
  });
}
