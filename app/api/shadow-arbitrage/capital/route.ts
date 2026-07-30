import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  loadCapitalPlans,
  loadLatestCapitalPlan,
  loadLatestFeeConfirmations,
  loadLatestSourceSnapshots,
  getObservation,
  loadRouteMetrics,
  saveCapitalPlan
} from "@/db/repositories/shadowArbitrage";
import { buildAllReadiness } from "@/lib/shadowArbitrage/accounts";
import {
  DEFAULT_CAPITAL_TOMAN,
  MAX_CAPITAL_TOMAN,
  MIN_CAPITAL_TOMAN,
  buildOptimizedPlan,
  classifyAllVenues,
  simulateCapitalPlan,
  smallestFundableSizeUsdt,
  type CapitalAllocation,
  type CapitalPlanInput,
  type RouteEvidence
} from "@/lib/shadowArbitrage/capital";
import { SHADOW_BANNER, SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import type { ShadowSourceId } from "@/lib/shadowArbitrage/types";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Phase 5 — admin-only capital allocation simulator.
 *
 * Every balance this endpoint reads or writes is virtual. It never contacts an
 * exchange, never accepts credentials, and has no code path that places an
 * order or moves funds. Automatic paper execution is deliberately out of scope
 * (Phase 6); nothing here schedules or simulates order flow.
 */

const VALID_IDS = new Set<string>(SHADOW_SOURCES.map((s) => s.id));

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

function bad(message: string, error = "bad_request", status = 400) {
  return new NextResponse(JSON.stringify({ error, message }), {
    status,
    headers: SHADOW_NO_STORE
  });
}

/**
 * Valuation price for USDT balances: the median mid-price across venues that
 * reported both sides this cycle. Null when the market data cannot support it —
 * the simulator then refuses to value USDT rather than guessing a price.
 */
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
  const value = mids.length % 2 ? mids[mid] : (mids[mid - 1] + mids[mid]) / 2;
  return Math.round(value);
}

function toRouteEvidence(rows: Awaited<ReturnType<typeof loadRouteMetrics>>): RouteEvidence[] {
  return rows.map((r) => ({
    routeKey: r.routeKey,
    buySourceId: r.buySourceId,
    sellSourceId: r.sellSourceId,
    sizeUsdt: r.sizeUsdt,
    samples: r.samples,
    positiveNetSamples: r.positiveNetSamples,
    positiveRawSamples: r.positiveRawSamples,
    feeUnknown: r.feeUnknown
  }));
}

/** Reject anything that is not a clean, non-negative virtual balance. */
function parseAllocations(raw: unknown): { ok: true; value: CapitalAllocation[] } | { ok: false; message: string } {
  if (!Array.isArray(raw)) return { ok: false, message: "فهرست تخصیص نامعتبر است" };
  if (raw.length > SHADOW_SOURCES.length) {
    return { ok: false, message: "تعداد تخصیص‌ها بیش از تعداد صرافی‌های مجاز است" };
  }
  const out: CapitalAllocation[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") return { ok: false, message: "ردیف تخصیص نامعتبر است" };
    const rec = item as Record<string, unknown>;
    const sourceId = String(rec.sourceId ?? "");
    if (!VALID_IDS.has(sourceId)) {
      return { ok: false, message: `صرافی «${sourceId}» در آربیتراژ آزمایشی مجاز نیست` };
    }
    const irt = Number(rec.irtToman ?? 0);
    const usdt = Number(rec.usdtUnits ?? 0);
    if (!Number.isFinite(irt) || !Number.isFinite(usdt) || irt < 0 || usdt < 0) {
      return { ok: false, message: "موجودی منفی یا نامعتبر پذیرفته نمی‌شود" };
    }
    out.push({ sourceId: sourceId as ShadowSourceId, irtToman: irt, usdtUnits: usdt });
  }
  return { ok: true, value: out };
}

async function buildContext() {
  const [latestFees, snapshots, routeRows, observation, savedPlan, history] = await Promise.all([
    loadLatestFeeConfirmations(),
    loadLatestSourceSnapshots(),
    loadRouteMetrics(),
    getObservation(),
    loadLatestCapitalPlan(),
    loadCapitalPlans(25)
  ]);

  const readiness = buildAllReadiness(Object.values(latestFees));
  const routes = toRouteEvidence(routeRows);
  const valuationPriceToman = deriveValuationPrice(snapshots);
  const observedWindowMs = observation?.elapsedMs ?? 0;

  return {
    readiness,
    venueStates: classifyAllVenues(readiness),
    routes,
    valuationPriceToman,
    observation: observation
      ? { status: observation.status, successCoveragePercent: observation.successCoveragePercent }
      : null,
    observationId: observation?.id ?? null,
    observedWindowMs,
    savedPlan,
    history
  };
}

type Ctx = Awaited<ReturnType<typeof buildContext>>;

function runSimulation(ctx: Ctx, plan: CapitalPlanInput) {
  const simulation = simulateCapitalPlan({
    plan,
    readiness: ctx.readiness,
    routes: ctx.routes,
    observation: ctx.observation,
    observedWindowMs: ctx.observedWindowMs,
    // No confirmed transfer cost exists yet, so the monthly figure stays UNKNOWN.
    perTransferCostToman: null,
    perTransferCostConfirmed: false
  });
  return {
    simulation,
    smallestFundableSizeUsdt: smallestFundableSizeUsdt(simulation.venues, plan.valuationPriceToman)
  };
}

function envelope(ctx: Ctx, extra: Record<string, unknown>) {
  return {
    banner: SHADOW_BANNER,
    shadowMode: true,
    paperExecution: false,
    serverNow: new Date().toISOString(),
    defaults: {
      capitalToman: DEFAULT_CAPITAL_TOMAN,
      minCapitalToman: MIN_CAPITAL_TOMAN,
      maxCapitalToman: MAX_CAPITAL_TOMAN
    },
    observationId: ctx.observationId,
    valuationPriceToman: ctx.valuationPriceToman,
    venues: ctx.venueStates,
    ...extra
  };
}

/** Current plan (or a provisional optimized proposal) plus its simulation. */
export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const ctx = await buildContext();

  if (ctx.valuationPriceToman === null) {
    return new NextResponse(
      JSON.stringify(
        envelope(ctx, {
          plan: null,
          simulation: null,
          history: ctx.history,
          unavailableReason:
            "قیمت ارزش‌گذاری تتر از آخرین چرخهٔ جمع‌آوری قابل استخراج نیست؛ تا زمان وجود دادهٔ تازه، شبیه‌سازی انجام نمی‌شود."
        })
      ),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  }

  const plan: CapitalPlanInput = ctx.savedPlan
    ? {
        totalCapitalToman: ctx.savedPlan.totalCapitalToman,
        valuationPriceToman: ctx.valuationPriceToman,
        allocations: ctx.savedPlan.allocations.filter((a) => VALID_IDS.has(a.sourceId)) as CapitalAllocation[],
        mode: ctx.savedPlan.mode
      }
    : buildOptimizedPlan({
        totalCapitalToman: DEFAULT_CAPITAL_TOMAN,
        valuationPriceToman: ctx.valuationPriceToman,
        readiness: ctx.readiness,
        routes: ctx.routes
      }).plan;

  const result = runSimulation(ctx, plan);
  return new NextResponse(
    JSON.stringify(
      envelope(ctx, {
        plan,
        planSource: ctx.savedPlan ? "SAVED" : "PROVISIONAL_OPTIMIZED",
        savedPlanId: ctx.savedPlan?.id ?? null,
        history: ctx.history,
        ...result
      })
    ),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}

/**
 * Actions: `simulate` (stateless), `optimize` (propose a provisional split),
 * `save` (append the plan). None of them can trade.
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
    return bad(
      "شبیه‌ساز سرمایه هیچ کلید API یا اطلاعات محرمانه‌ای نمی‌پذیرد.",
      "forbidden_field"
    );
  }

  const action = String(body.action ?? "simulate");
  if (!["simulate", "optimize", "save"].includes(action)) {
    return bad("عملیات نامعتبر است");
  }

  const ctx = await buildContext();
  if (ctx.valuationPriceToman === null) {
    return bad(
      "قیمت ارزش‌گذاری تتر در دسترس نیست؛ شبیه‌سازی بدون آن انجام نمی‌شود.",
      "unavailable",
      503
    );
  }

  const totalCapitalToman = Number(body.totalCapitalToman ?? DEFAULT_CAPITAL_TOMAN);
  if (
    !Number.isFinite(totalCapitalToman) ||
    totalCapitalToman < MIN_CAPITAL_TOMAN ||
    totalCapitalToman > MAX_CAPITAL_TOMAN
  ) {
    return bad("سرمایهٔ واردشده خارج از بازهٔ مجاز است");
  }

  if (action === "optimize") {
    const reservePercent = Number(body.reservePercent ?? 0);
    if (!Number.isFinite(reservePercent) || reservePercent < 0 || reservePercent > 90) {
      return bad("درصد ذخیره باید بین ۰ تا ۹۰ باشد");
    }
    const optimized = buildOptimizedPlan({
      totalCapitalToman,
      valuationPriceToman: ctx.valuationPriceToman,
      readiness: ctx.readiness,
      routes: ctx.routes,
      reservePercent
    });
    const result = runSimulation(ctx, optimized.plan);
    return new NextResponse(
      JSON.stringify(
        envelope(ctx, {
          plan: optimized.plan,
          planSource: "PROVISIONAL_OPTIMIZED",
          optimization: {
            basis: optimized.basis,
            basisFa: optimized.basisFa,
            status: optimized.status,
            reasonFa: optimized.reasonFa,
            venueWeights: optimized.venueWeights
          },
          history: ctx.history,
          ...result
        })
      ),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  }

  const parsed = parseAllocations(body.allocations ?? []);
  if (!parsed.ok) return bad(parsed.message);

  const plan: CapitalPlanInput = {
    totalCapitalToman,
    valuationPriceToman: ctx.valuationPriceToman,
    allocations: parsed.value,
    mode: body.mode === "OPTIMIZED" ? "OPTIMIZED" : "MANUAL"
  };
  const result = runSimulation(ctx, plan);

  if (action === "simulate") {
    return new NextResponse(
      JSON.stringify(envelope(ctx, { plan, planSource: "DRAFT", history: ctx.history, ...result })),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  }

  // save — refuse to persist a plan that violates conservation or balances.
  if (!result.simulation.ok) {
    return new NextResponse(
      JSON.stringify({
        error: "invalid_plan",
        message: "طرح تخصیص معتبر نیست و ذخیره نشد.",
        violations: result.simulation.violations
      }),
      { status: 400, headers: SHADOW_NO_STORE }
    );
  }

  try {
    const saved = await saveCapitalPlan({
      name: typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 80) : "طرح تخصیص سرمایه",
      mode: plan.mode,
      totalCapitalToman: plan.totalCapitalToman,
      valuationPriceToman: plan.valuationPriceToman,
      reservePercent: 0,
      allocations: plan.allocations,
      createdBy: session.u ?? "admin",
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null
    });
    const history = await loadCapitalPlans(25);
    return new NextResponse(
      JSON.stringify(
        envelope(ctx, { plan, planSource: "SAVED", savedPlanId: saved.id, history, ...result })
      ),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  } catch (error) {
    return new NextResponse(
      JSON.stringify({
        error: "unavailable",
        message: error instanceof Error ? error.message : "ذخیرهٔ طرح ممکن نشد"
      }),
      { status: 503, headers: SHADOW_NO_STORE }
    );
  }
}
