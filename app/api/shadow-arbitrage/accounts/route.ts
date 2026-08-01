import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  loadFeeConfirmations,
  loadLatestAccountConfirmations,
  loadLatestFeeConfirmations,
  recordFeeConfirmation
} from "@/db/repositories/shadowArbitrage";
import { FEE_REVERIFY_DAYS, buildAllReadiness } from "@/lib/shadowArbitrage/accounts";
import { SHADOW_BANNER, SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 4 — admin-only account and fee readiness.
 *
 * Read-only with respect to exchanges. This endpoint never asks for, receives or
 * stores API keys or credentials; it records published fee evidence only.
 */
export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const [latest, history, accountEvidence] = await Promise.all([
    loadLatestFeeConfirmations(),
    loadFeeConfirmations(),
    loadLatestAccountConfirmations()
  ]);
  const readiness = buildAllReadiness(
    Object.values(latest),
    Date.now(),
    Object.values(accountEvidence)
  );

  return new NextResponse(
    JSON.stringify({
      banner: SHADOW_BANNER,
      shadowMode: true,
      serverNow: new Date().toISOString(),
      feeReverifyDays: FEE_REVERIFY_DAYS,
      venues: readiness,
      auditHistory: history
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}

/**
 * Record an admin-confirmed fee tier. Append-only: every confirmation becomes a
 * new audit row. Credentials are explicitly not accepted.
 */
export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return new NextResponse(JSON.stringify({ error: "bad_request", message: "بدنهٔ JSON نامعتبر" }), {
      status: 400,
      headers: SHADOW_NO_STORE
    });
  }

  // Hard refusal: this phase must never carry secrets.
  const forbidden = ["apiKey", "api_key", "secret", "apiSecret", "token", "password", "passphrase"];
  if (forbidden.some((k) => k in body)) {
    return new NextResponse(
      JSON.stringify({
        error: "forbidden_field",
        message: "این مرحله هیچ کلید API یا اطلاعات محرمانه‌ای نمی‌پذیرد."
      }),
      { status: 400, headers: SHADOW_NO_STORE }
    );
  }

  const sourceId = String(body.sourceId ?? "");
  const validId = SHADOW_SOURCES.some((s) => s.id === sourceId);
  if (!validId) {
    return new NextResponse(
      JSON.stringify({ error: "bad_request", message: "صرافی نامعتبر است" }),
      { status: 400, headers: SHADOW_NO_STORE }
    );
  }

  const bps = Number(body.takerFeeBps);
  if (!Number.isFinite(bps) || bps < 0 || bps > 1000) {
    return new NextResponse(
      JSON.stringify({
        error: "bad_request",
        message: "کارمزد باید عددی بین ۰ تا ۱۰۰۰ در ده‌هزار باشد"
      }),
      { status: 400, headers: SHADOW_NO_STORE }
    );
  }

  try {
    const saved = await recordFeeConfirmation({
      sourceId: sourceId as ShadowSourceId,
      takerFeeBps: bps,
      feeTier: typeof body.feeTier === "string" ? body.feeTier.slice(0, 80) : null,
      sourceUrl: typeof body.sourceUrl === "string" ? body.sourceUrl.slice(0, 300) : null,
      confirmedBy: session.u ?? "admin",
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null
    });
    const latest = await loadLatestFeeConfirmations();
    return new NextResponse(
      JSON.stringify({
        banner: SHADOW_BANNER,
        saved,
        venues: buildAllReadiness(
          Object.values(latest),
          Date.now(),
          Object.values(await loadLatestAccountConfirmations())
        )
      }),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  } catch (error) {
    return new NextResponse(
      JSON.stringify({
        error: "unavailable",
        message: error instanceof Error ? error.message : "ثبت کارمزد ممکن نشد"
      }),
      { status: 503, headers: SHADOW_NO_STORE }
    );
  }
}
