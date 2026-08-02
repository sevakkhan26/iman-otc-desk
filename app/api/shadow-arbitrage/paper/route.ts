import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  getObservation,
  loadLatestCapitalApproval,
  loadLatestCapitalPlan,
  loadLatestAccountConfirmations,
  loadLatestFeeConfirmations,
  loadLatestSourceSnapshots
} from "@/db/repositories/shadowArbitrage";
import {
  createPaperSession,
  getActivePaperSession,
  getPaperSession,
  listPaperSessions,
  loadCandidateStates,
  loadCycleSummaries,
  loadPaperBalances,
  loadPaperLedger,
  loadPaperStats,
  loadReasonBreakdown,
  setPaperSessionStatus,
  type PaperSessionMode
} from "@/db/repositories/shadowPaper";
import { buildAllReadiness } from "@/lib/shadowArbitrage/accounts";
import {
  validateAllocation,
  type VenueAllocation
} from "@/lib/shadowArbitrage/paper/portfolio";
import {
  DEFAULT_CAPITAL_TOMAN,
  buildOptimizedPlan,
  classifyAllVenues,
  evaluateRecommendation,
  planFingerprint,
  readinessFingerprint,
  type CapitalPlanInput
} from "@/lib/shadowArbitrage/capital";
import { SHADOW_BANNER, SHADOW_SOURCES, SHADOW_TRADE_SIZES, SLIPPAGE_BUFFER_BPS } from "@/lib/shadowArbitrage/config";
import { loadRiskPolicyValues } from "@/db/repositories/shadowLive";
import { loadLastMatrix } from "@/lib/shadowArbitrage/store";
import { buildPolicyState } from "@/lib/shadowArbitrage/live/policy";
import {
  computeAllRouteSizes,
  SIZING_REQUIRED_POLICIES
} from "@/lib/shadowArbitrage/paper/sizing";
import { venueCapacity } from "@/lib/shadowArbitrage/paper/liquidity";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import { PAPER_FEE_SETTLEMENT, microsToUsdt, settlementFor, usdtToMicros } from "@/lib/shadowArbitrage/paper/broker";

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

async function snapshot(reasonFilter: string | null = null) {
  const session = await getActivePaperSession();
  if (!session) {
    return {
      session: null,
      balances: [],
      trades: [],
      transitions: [],
      candidates: [],
      reasonBreakdown: [],
      cycleSummaries: [],
      stats: null
    };
  }
  const [balances, trades, transitions, stats, reasonBreakdown, candidates, cycleSummaries] =
    await Promise.all([
      loadPaperBalances(session.id),
      loadPaperLedger(session.id, { outcome: "FILLED", limit: 200 }),
      // Only state transitions are stored now, so this list is already compact.
      loadPaperLedger(session.id, { outcome: "SKIPPED", limit: 100 }),
      loadPaperStats(session.id),
      loadReasonBreakdown(session.id),
      loadCandidateStates(session.id, {
        reason: reasonFilter ?? undefined,
        openOnly: true,
        limit: 200
      }),
      loadCycleSummaries(session.id, 60)
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
    balances: balances.map((b) => {
      // Settlement is reported per side, never collapsed into one currency.
      const st = PAPER_FEE_SETTLEMENT[b.sourceId as keyof typeof PAPER_FEE_SETTLEMENT];
      return {
        sourceId: b.sourceId,
        irtToman: b.irtToman,
        usdt: microsToUsdt(b.usdtMicros),
        buySettlement: st?.buy ?? { feeAsset: "UNKNOWN", debitMode: "UNKNOWN", provenance: "UNKNOWN" },
        sellSettlement: st?.sell ?? { feeAsset: "UNKNOWN", debitMode: "UNKNOWN", provenance: "UNKNOWN" }
      };
    }),
    trades,
    transitions,
    candidates,
    reasonBreakdown,
    cycleSummaries,
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

export async function GET(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  // Optional server-side filter so a large session never ships every candidate.
  const reason = new URL(request.url).searchParams.get("reason");
  const [snap, history] = await Promise.all([snapshot(reason), listPaperSessions(20)]);
  /*
   * The wizard needs two facts it must not invent: today's mark price and which
   * venues may hold capital. Both are derived here, on the server, from the same
   * evidence the engine uses.
   */
  const [wizardSnapshots, wizardFees, wizardAccounts, latestPlan] = await Promise.all([
    loadLatestSourceSnapshots(),
    loadLatestFeeConfirmations(),
    loadLatestAccountConfirmations(),
    loadLatestCapitalPlan()
  ]);
  const wizardReadiness = buildAllReadiness(
    Object.values(wizardFees),
    Date.now(),
    Object.values(wizardAccounts)
  );
  const wizard = {
    markPriceToman: deriveValuationPrice(wizardSnapshots),
    eligibleVenues: classifyAllVenues(wizardReadiness)
      .filter((v) => v.executable)
      .map((v) => ({ sourceId: v.sourceId, nameFa: v.nameFa })),
    capitalPlan: latestPlan
      ? {
          id: latestPlan.id,
          name: latestPlan.name,
          totalCapitalToman: latestPlan.totalCapitalToman,
          createdAt: latestPlan.createdAt,
          allocations: latestPlan.allocations
        }
      : null
  };

  /*
   * Phase 8C-3 — the dynamic size, recomputed read-only for every eligible
   * route so the screen can show what would trade right now and, when nothing
   * would, exactly which policy or piece of evidence is missing. Same pure
   * function the engine uses; this endpoint still cannot trade.
   */
  const [policyValues, lastMatrix] = await Promise.all([loadRiskPolicyValues(), loadLastMatrix()]);
  const policies = buildPolicyState(policyValues);
  // Normalized snapshots — the same cached cycle the matrix serves, so the size
  // shown here is computed from exactly the evidence the engine last saw.
  const snapshotById = new Map((lastMatrix?.sources ?? []).map((s) => [s.sourceId as string, s]));
  const feeBpsById = new Map<string, number | null>(
    Object.values(wizardReadiness).map((r) => [r.sourceId as string, r.takerFeeBps ?? null])
  );
  const sizingBalances = (snap.balances ?? []).map((b) => ({
    sourceId: b.sourceId as ShadowSourceId,
    irtToman: b.irtToman,
    usdtMicros: usdtToMicros(b.usdt)
  }));
  const valuationPriceToman = snap.session?.valuationPriceToman ?? null;
  const exposureTomanBySource = new Map<string, number>();
  const allocationTomanBySource = new Map<string, number>();
  if (valuationPriceToman !== null && valuationPriceToman > 0) {
    for (const b of sizingBalances) {
      exposureTomanBySource.set(
        b.sourceId as string,
        b.irtToman + Math.round(microsToUsdt(b.usdtMicros) * valuationPriceToman)
      );
    }
    for (const a of snap.session?.openingAllocations ?? []) {
      allocationTomanBySource.set(
        a.sourceId as string,
        Math.round(a.irtToman + a.usdtUnits * valuationPriceToman)
      );
    }
  }
  const portfolioValueToman = exposureTomanBySource.size
    ? [...exposureTomanBySource.values()].reduce((s, v) => s + v, 0)
    : null;

  /*
   * Phase 8C-5 — per-venue capacity, answered independently for every venue so
   * two unrelated causes can never be reported as one. An OTC dealer that
   * publishes no ladder and a book venue that missed a cycle are different
   * facts with different operator actions.
   */
  const policyOrderSizeUsdt = policies.find((p) => p.definition.key === "max_order_size_usdt");
  const policyOrderSizeMicros = policyOrderSizeUsdt?.configured
    ? usdtToMicros(policyOrderSizeUsdt.value as number)
    : null;

  const venueCapacities = wizard.eligibleVenues.map((v) => {
    const snapshot = snapshotById.get(v.sourceId);
    const balance = sizingBalances.find((b) => (b.sourceId as string) === v.sourceId);
    return {
      ...venueCapacity({
        sourceId: v.sourceId,
        marketModel: snapshot?.marketModel ?? "ORDER_BOOK",
        bookBids: snapshot?.bookBids ?? null,
        bookAsks: snapshot?.bookAsks ?? null,
        irtToman: balance?.irtToman ?? null,
        usdtMicros: balance?.usdtMicros ?? null,
        feeBps: feeBpsById.get(v.sourceId) ?? null,
        buyFeeAsset: settlementFor(v.sourceId as ShadowSourceId, "buy").feeAsset,
        sellFeeAsset: settlementFor(v.sourceId as ShadowSourceId, "sell").feeAsset,
        capitalShareToman: allocationTomanBySource.get(v.sourceId) ?? null,
        policyOrderSizeMicros,
        // Exposure is a portfolio-level ceiling, not a per-venue one; it is
        // applied per route where the current exposure is known.
        policyExposureMicros: null
      }),
      nameFa: v.nameFa
    };
  });

  const sizing = {
    requiredPolicies: SIZING_REQUIRED_POLICIES,
    venueCapacities,
    missingPolicies: SIZING_REQUIRED_POLICIES.filter(
      (k) => !policies.find((p) => p.definition.key === k)?.configured
    ),
    probeSizesUsdt: SHADOW_TRADE_SIZES,
    routes: computeAllRouteSizes({
      venueIds: wizard.eligibleVenues.map((v) => v.sourceId),
      snapshotById,
      feeBpsById,
      settlementFor: (id, side) => settlementFor(id as ShadowSourceId, side),
      balances: sizingBalances,
      allocationTomanBySource,
      portfolioValueToman,
      exposureTomanBySource,
      policies,
      slippageBufferBps: SLIPPAGE_BUFFER_BPS
    })
  };

  return new NextResponse(JSON.stringify(envelope({ ...snap, history, wizard, sizing })), {
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

    const accountEvidence = await loadLatestAccountConfirmations();
    const readiness = buildAllReadiness(
      Object.values(latestFees),
      Date.now(),
      Object.values(accountEvidence)
    );
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
    } else if (Array.isArray(body.allocations)) {
      /*
       * A snapshot of the capital plan the admin just reviewed.
       *
       * The client proposes; the server re-checks everything that matters: the
       * venues must be execution-eligible, and the allocation must conserve the
       * stated total exactly at the mark price derived here, not at whatever
       * price the client happened to see. A residual of even one toman is
       * refused rather than rounded away.
       */
      const eligibleIds = venueStates.filter((v) => v.executable).map((v) => v.sourceId);
      const allocations = (body.allocations as VenueAllocation[]).map((a) => ({
        sourceId: String(a.sourceId),
        irtToman: Math.round(Number(a.irtToman) || 0),
        usdtUnits: Number(a.usdtUnits) || 0
      }));
      const totalCapitalToman = Math.round(Number(body.totalCapitalToman) || 0);

      const validation = validateAllocation({
        totalCapitalToman,
        allocations,
        markPriceToman: valuationPriceToman,
        eligibleVenueIds: eligibleIds
      });
      if (!validation.ok) {
        return new NextResponse(
          JSON.stringify({
            error: "invalid_allocation",
            message: validation.errorsFa.join(" "),
            validation
          }),
          { status: 400, headers: SHADOW_NO_STORE }
        );
      }

      plan = {
        totalCapitalToman,
        valuationPriceToman,
        allocations: allocations.filter((a) =>
          VALID_IDS.has(a.sourceId)
        ) as CapitalPlanInput["allocations"],
        mode: "MANUAL"
      };
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
