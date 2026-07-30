import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  getObservation,
  loadLatestCapitalApproval,
  loadLatestCapitalPlan,
  loadLatestFeeConfirmations,
  loadLatestSourceSnapshots
} from "@/db/repositories/shadowArbitrage";
import {
  createPaperSession,
  getActivePaperSession,
  getPaperSession,
  listPaperSessions,
  loadPaperBalances,
  loadPaperLedger,
  loadPaperStats,
  setPaperSessionStatus,
  type PaperSessionMode
} from "@/db/repositories/shadowPaper";
import { buildAllReadiness } from "@/lib/shadowArbitrage/accounts";
import {
  DEFAULT_CAPITAL_TOMAN,
  buildOptimizedPlan,
  classifyAllVenues,
  evaluateRecommendation,
  planFingerprint,
  readinessFingerprint,
  type CapitalPlanInput
} from "@/lib/shadowArbitrage/capital";
import { SHADOW_BANNER, SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import { PAPER_FEE_BASIS, microsToUsdt } from "@/lib/shadowArbitrage/paper/broker";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 6 — admin-only paper execution control surface.
 *
 * Paper trading only. This endpoint creates and controls a SIMULATED session:
 * it has no exchange client, accepts no credentials, and contains no code path
 * that can place an order or move funds. Every balance it reports is virtual.
 */

// Route files may only export Next.js route fields, so these stay module-local.
const PAPER_BANNER_FA = "اجرای کاغذی — بدون سفارش واقعی و بدون انتقال وجه";
const PAPER_BANNER_EN = "PAPER EXECUTION — NO REAL ORDERS OR TRANSFERS";

/** Any of these in a request body is an immediate refusal. */
const FORBIDDEN_FIELDS = [
  "apiKey",
  "api_key",
  "secret",
  "apiSecret",
  "token",
  "password",
  "passphrase",
  "privateKey",
  "mnemonic"
];

const VALID_IDS = new Set<string>(SHADOW_SOURCES.map((s) => s.id));

function bad(message: string, error = "bad_request", status = 400) {
  return new NextResponse(JSON.stringify({ error, message }), {
    status,
    headers: SHADOW_NO_STORE
  });
}

/** Median mid-price across venues that reported both sides this cycle. */
function deriveValuationPrice(
  snapshots: Array<{ userBuy: number | null; userSell: number | null; stale: boolean }>
): number | null {
  const mids = snapshots
    .filter((s) => !s.stale && s.userBuy !== null && s.userSell !== null)
    .map((s) => ((s.userBuy as number) + (s.userSell as number)) / 2)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (!mids.length) return null;
  const mid = Math.floor(mids.length / 2);
  return Math.round(mids.length % 2 ? mids[mid] : (mids[mid - 1] + mids[mid]) / 2);
}

async function snapshot() {
  const session = await getActivePaperSession();
  if (!session) {
    return {
      session: null,
      balances: [],
      trades: [],
      skipped: [],
      stats: null
    };
  }
  const [balances, trades, skipped, stats] = await Promise.all([
    loadPaperBalances(session.id),
    loadPaperLedger(session.id, { outcome: "FILLED", limit: 200 }),
    loadPaperLedger(session.id, { outcome: "SKIPPED", limit: 200 }),
    loadPaperStats(session.id)
  ]);

  // Inventory drift: where the virtual book stands versus how it opened.
  const opening = new Map(
    session.openingAllocations.map((a) => [
      a.sourceId,
      { irtToman: Math.round(a.irtToman), usdtMicros: Math.round(a.usdtUnits * 1_000_000) }
    ])
  );
  const drift = balances.map((b) => {
    const o = opening.get(b.sourceId) ?? { irtToman: 0, usdtMicros: 0 };
    return {
      sourceId: b.sourceId,
      irtTomanDelta: b.irtToman - o.irtToman,
      usdtDelta: microsToUsdt(b.usdtMicros - o.usdtMicros)
    };
  });

  const evaluated = stats.filled + stats.skipped;
  return {
    session,
    balances: balances.map((b) => ({
      sourceId: b.sourceId,
      irtToman: b.irtToman,
      usdt: microsToUsdt(b.usdtMicros),
      feeBasis: PAPER_FEE_BASIS[b.sourceId as keyof typeof PAPER_FEE_BASIS] ?? "UNKNOWN"
    })),
    trades,
    skipped,
    stats: {
      ...stats,
      feeUsdtTotal: microsToUsdt(stats.feeUsdtMicrosTotal),
      /** Filled ÷ every candidate the engine considered. */
      opportunityCaptureRatePercent:
        evaluated > 0 ? Math.round((stats.filled / evaluated) * 10_000) / 100 : null,
      drift
    }
  };
}

function envelope(extra: Record<string, unknown>) {
  return {
    banner: SHADOW_BANNER,
    paperBanner: PAPER_BANNER_EN,
    paperBannerFa: PAPER_BANNER_FA,
    shadowMode: true,
    paperOnly: true,
    realOrders: false,
    serverNow: new Date().toISOString(),
    ...extra
  };
}

export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const [snap, history] = await Promise.all([snapshot(), listPaperSessions(20)]);
  return new NextResponse(JSON.stringify(envelope({ ...snap, history })), {
    status: 200,
    headers: SHADOW_NO_STORE
  });
}

/**
 * Actions: `create`, `start`, `pause`, `resume`, `stop`.
 * None of them can trade — `start` only flips a database status so the engine
 * begins evaluating cycles that already happened.
 */
export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("بدنهٔ JSON نامعتبر");
  }

  if (FORBIDDEN_FIELDS.some((k) => k in body)) {
    return bad("اجرای کاغذی هیچ کلید API یا اطلاعات محرمانه‌ای نمی‌پذیرد.", "forbidden_field");
  }

  const action = String(body.action ?? "");
  if (!["create", "start", "pause", "resume", "stop"].includes(action)) {
    return bad("عملیات نامعتبر است");
  }

  if (action === "create") {
    const mode: PaperSessionMode =
      body.mode === "APPROVED_PLAN" ? "APPROVED_PLAN" : "PROVISIONAL_EVALUATION";

    const [latestFees, snapshots, observation, savedPlan, approvalRow] = await Promise.all([
      loadLatestFeeConfirmations(),
      loadLatestSourceSnapshots(),
      getObservation(),
      loadLatestCapitalPlan(),
      loadLatestCapitalApproval()
    ]);

    const valuationPriceToman = deriveValuationPrice(snapshots);
    if (valuationPriceToman === null) {
      return bad(
        "قیمت ارزش‌گذاری تتر در دسترس نیست؛ نشست کاغذی بدون آن ساخته نمی‌شود.",
        "unavailable",
        503
      );
    }

    const readiness = buildAllReadiness(Object.values(latestFees));
    const venueStates = classifyAllVenues(readiness);

    let plan: CapitalPlanInput;
    let approvalFingerprint: string | null = null;

    if (mode === "APPROVED_PLAN") {
      // Only a Phase 5 approval that still holds may back a session.
      if (!savedPlan || !approvalRow) {
        return bad("هیچ طرح تأییدشده‌ای برای شروع نشست وجود ندارد.", "not_eligible", 409);
      }
      plan = {
        totalCapitalToman: savedPlan.totalCapitalToman,
        valuationPriceToman,
        allocations: savedPlan.allocations.filter((a) =>
          VALID_IDS.has(a.sourceId)
        ) as CapitalPlanInput["allocations"],
        mode: savedPlan.mode
      };
      const recommendation = evaluateRecommendation({
        plan,
        states: venueStates,
        observation: observation
          ? {
              status: observation.status,
              successCoveragePercent: observation.successCoveragePercent,
              elapsedMs: observation.elapsedMs,
              targetDurationMs: observation.targetDurationMs
            }
          : null,
        approval: {
          approvedBy: approvalRow.approvedBy,
          approvedAt: approvalRow.approvedAt,
          readinessFingerprint: approvalRow.readinessFingerprint,
          planFingerprint: approvalRow.planFingerprint
        }
      });
      if (recommendation.status !== "APPROVED_SIMULATION_PLAN") {
        return new NextResponse(
          JSON.stringify({
            error: "not_eligible",
            message: `تأیید معتبر فاز ۵ وجود ندارد. ${recommendation.reasonFa}`,
            recommendation
          }),
          { status: 409, headers: SHADOW_NO_STORE }
        );
      }
      approvalFingerprint = `${planFingerprint(plan)}|${readinessFingerprint(venueStates)}`;
    } else {
      // Provisional evaluation runs on a draft 50,000,000-toman virtual plan.
      plan = buildOptimizedPlan({
        totalCapitalToman: DEFAULT_CAPITAL_TOMAN,
        valuationPriceToman,
        readiness,
        routes: []
      }).plan;
      if (!plan.allocations.length) {
        return bad(
          "هیچ صرافی اجراپذیری برای ساخت طرح آزمایشی وجود ندارد.",
          "not_eligible",
          409
        );
      }
    }

    const created = await createPaperSession({
      observationId: observation?.id ?? null,
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim().slice(0, 80)
          : mode === "APPROVED_PLAN"
            ? "نشست کاغذی طرح تأییدشده"
            : "ارزیابی موقت کاغذی",
      mode,
      totalCapitalToman: plan.totalCapitalToman,
      valuationPriceToman,
      openingAllocations: plan.allocations.map((a) => ({
        sourceId: a.sourceId,
        irtToman: a.irtToman,
        usdtUnits: a.usdtUnits
      })),
      approvalFingerprint,
      createdBy: session.u ?? "admin",
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null
    });

    return new NextResponse(
      JSON.stringify(
        envelope({
          created: created.id,
          // Creating never starts it: an admin must press start.
          started: false,
          ...(await snapshot()),
          history: await listPaperSessions(20)
        })
      ),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  }

  const sessionId = typeof body.sessionId === "string" ? body.sessionId : null;
  const target = sessionId ? await getPaperSession(sessionId) : await getActivePaperSession();
  if (!target) return bad("نشست کاغذی یافت نشد.", "not_found", 404);
  if (target.status === "STOPPED") return bad("این نشست پایان یافته است.", "conflict", 409);

  const next =
    action === "start" || action === "resume"
      ? "RUNNING"
      : action === "pause"
        ? "PAUSED"
        : "STOPPED";

  if (action === "resume" && target.status !== "PAUSED") {
    return bad("فقط نشست متوقف‌شده را می‌توان ادامه داد.", "conflict", 409);
  }
  if (action === "pause" && target.status !== "RUNNING") {
    return bad("فقط نشست در حال اجرا را می‌توان متوقف کرد.", "conflict", 409);
  }

  await setPaperSessionStatus(target.id, next);
  return new NextResponse(
    JSON.stringify(envelope({ ...(await snapshot()), history: await listPaperSessions(20) })),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
