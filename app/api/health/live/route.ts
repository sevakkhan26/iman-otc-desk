import { NextResponse } from "next/server";
import { checkLiveness } from "@/lib/ops/health";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Container liveness probe. Unauthenticated by necessity — Docker cannot log
 * in — so it answers exactly one question and exposes nothing else: no version,
 * host, database, worker id or configuration.
 *
 * Full diagnostics remain admin-only at /api/shadow-arbitrage/health.
 */
export function GET() {
  const result = checkLiveness();
  return NextResponse.json(result, {
    status: 200,
    headers: { "cache-control": "no-store" }
  });
}
