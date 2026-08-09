/**
 * Admin-only Paper session capital replace (Step 1).
 *
 * GET  — current active session + limits (read-only).
 * POST action=preview — allocation preview, residual must be 0 (no write).
 * POST action=apply   — archive active session, save capital plan, open one RUNNING session.
 *
 * Paper only. No credentials, real orders, or fund transfers.
 */
import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import { loadLatestSourceSnapshots } from "@/db/repositories/shadowArbitrage";
import {
  getActivePaperSession,
  listActivePaperSessions,
  listPaperSessions,
  loadPaperBalances,
  replaceActivePaperSessionCapital
} from "@/db/repositories/shadowPaper";
import { SHADOW_SOURCES } from "@/lib/shadowArbitrage/config";
import {
  MAX_CAPITAL_TOMAN,
  MIN_CAPITAL_TOMAN,
  ORDER_CAP_DERIVED_ACTOR,
  buildSessionCapitalPreview,
  parseWholeTomanCapital
} from "@/lib/shadowArbitrage/paper/sessionCapital";
import { portfolioValueToman } from "@/lib/shadowArbitrage/paper/portfolio";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import { loadRiskPolicyValues, recordRiskPolicy } from "@/db/repositories/shadowLive";
import { buildPolicyState } from "@/lib/shadowArbitrage/live/policy";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
  return Math.round(mids.length % 2 ? mids[mid]! : (mids[mid - 1]! + mids[mid]!) / 2);
}

function venueIds(): string[] {
  return SHADOW_SOURCES.map((s) => s.id);
}

export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const [active, actives, snapshots] = await Promise.all([
    getActivePaperSession(),
    listActivePaperSessions(),
    loadLatestSourceSnapshots()
  ]);
  const mark = deriveValuationPrice(snapshots);

  return new NextResponse(
    JSON.stringify({
      unit: "toman",
      limits: {
        minCapitalToman: MIN_CAPITAL_TOMAN,
        maxCapitalToman: MAX_CAPITAL_TOMAN
      },
      valuationPriceToman: mark,
      activeSession: active
        ? {
            id: active.id,
            name: active.name,
            status: active.status,
            totalCapitalToman: active.totalCapitalToman,
            valuationPriceToman: active.valuationPriceToman,
            createdAt: active.createdAt,
            startedAt: active.startedAt
          }
        : null,
      activeSessionCount: actives.length,
      paperOnly: true,
      realOrders: false
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}

export async function POST(request: Request) {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return bad("بدنهٔ درخواست نامعتبر است");
  }

  for (const k of FORBIDDEN_FIELDS) {
    if (k in body) {
      return bad("این endpoint اعتبارنامه یا سفارش واقعی نمی‌پذیرد", "forbidden_field", 400);
    }
  }

  const action = String(body.action ?? "");
  if (action !== "preview" && action !== "apply") {
    return bad("action باید preview یا apply باشد");
  }

  const parsed = parseWholeTomanCapital(body.totalCapitalToman);
  if (!parsed.ok) {
    return bad(parsed.messageFa, parsed.code, 400);
  }

  const snapshots = await loadLatestSourceSnapshots();
  const markFromMarket = deriveValuationPrice(snapshots);
  const markOverride = body.valuationPriceToman;
  let mark = markFromMarket;
  if (markOverride !== undefined && markOverride !== null && markOverride !== "") {
    const m = Number(markOverride);
    if (!Number.isFinite(m) || m <= 0 || !Number.isInteger(m)) {
      return bad("قیمت مبنای تتر باید تومان صحیح و مثبت باشد", "bad_mark", 400);
    }
    mark = m;
  }
  if (mark === null || mark <= 0) {
    // Fail-closed without inventing a live market price: allow only explicit mark.
    return bad(
      "قیمت مبنای تتر در دسترس نیست؛ برای پیش‌نمایش/اعمال، valuationPriceToman را به تومان صحیح بفرستید",
      "mark_unavailable",
      409
    );
  }

  const active = await getActivePaperSession();
  const policyState = buildPolicyState(await loadRiskPolicyValues(), Date.now());
  const orderPol = policyState.find((p) => p.definition.key === "max_order_size_usdt");
  const currentOrderCap =
    orderPol?.configured && orderPol.value !== null && orderPol.value !== undefined
      ? { value: orderPol.value as number, setBy: orderPol.setBy ?? null }
      : null;

  let preview;
  try {
    preview = buildSessionCapitalPreview({
      totalCapitalToman: parsed.value,
      valuationPriceToman: mark,
      venueIds: venueIds(),
      activeSessionId: active?.id ?? null,
      oldCapitalToman: active?.totalCapitalToman ?? null,
      currentOrderCap
    });
  } catch (e) {
    return bad(
      e instanceof Error ? e.message : "ساخت تخصیص ناموفق بود",
      "allocation_failed",
      400
    );
  }

  if (preview.residualToman !== 0) {
    return bad("باقیماندهٔ تخصیص باید دقیقاً صفر باشد", "residual_nonzero", 400);
  }

  if (action === "preview") {
    return new NextResponse(
      JSON.stringify({
        unit: "toman",
        action: "preview",
        activeSession: active
          ? {
              id: active.id,
              totalCapitalToman: active.totalCapitalToman,
              status: active.status
            }
          : null,
        preview: {
          oldCapitalToman: preview.oldCapitalToman,
          totalCapitalToman: preview.totalCapitalToman,
          valuationPriceToman: preview.valuationPriceToman,
          allocations: preview.allocations,
          allocationSumToman: preview.allocationSumToman,
          residualToman: preview.residualToman,
          perVenue: preview.perVenue,
          limits: preview.limits,
          orderCap: preview.orderCap,
          previewToken: preview.previewToken
        },
        requiresConfirmation: true
      }),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  }

  // apply
  if (body.confirm !== true) {
    return bad("اعمال سرمایه نیازمند confirm: true است", "confirmation_required", 400);
  }
  const token = typeof body.previewToken === "string" ? body.previewToken : "";
  if (!token || token !== preview.previewToken) {
    return bad(
      "previewToken نامعتبر یا منقضی است — دوباره پیش‌نمایش بگیرید",
      "invalid_preview_token",
      409
    );
  }

  const result = await replaceActivePaperSessionCapital({
    totalCapitalToman: preview.totalCapitalToman,
    valuationPriceToman: preview.valuationPriceToman,
    openingAllocations: preview.allocations,
    createdBy: session.u ?? "admin",
    previewToken: preview.previewToken,
    name:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 80)
        : undefined
  });

  /*
   * Immutable order-cap snapshot when capital-derived.
   * Explicit admin caps (e.g. max_order_size_usdt=500) are never overwritten.
   */
  let orderCapPolicy: { written: boolean; mode: string; valueUsdt: number } | null = null;
  if (preview.orderCap.willWritePolicy && !result.reused) {
    await recordRiskPolicy({
      policyKey: "max_order_size_usdt",
      value: preview.orderCap.derivedMaxOrderUsdt,
      setBy: ORDER_CAP_DERIVED_ACTOR,
      validForDays: 30,
      note: `capital-derived from equity=${preview.totalCapitalToman} mark=${preview.valuationPriceToman} util≤${preview.limits.maxUtilizationPercent}% reserve≥${preview.limits.minReservePercent}% route≤${preview.limits.maxRouteCapitalPercent}% venue≤${preview.limits.maxVenueExposurePercent}% session=${result.newSession.id}`
    });
    orderCapPolicy = {
      written: true,
      mode: preview.orderCap.mode,
      valueUsdt: preview.orderCap.derivedMaxOrderUsdt
    };
  } else {
    orderCapPolicy = {
      written: false,
      mode: preview.orderCap.mode,
      valueUsdt: preview.orderCap.effectiveMaxOrderUsdt
    };
  }

  const bals = await loadPaperBalances(result.newSession.id);
  const balanceMarked = bals.reduce(
    (s, b) => s + b.irtToman + Math.round((b.usdtMicros / 1e6) * preview.valuationPriceToman),
    0
  );
  const activesAfter = await listActivePaperSessions();
  const history = await listPaperSessions(10);

  return new NextResponse(
    JSON.stringify({
      unit: "toman",
      action: "apply",
      reused: result.reused,
      audit: result.audit,
      capitalPlanId: result.capitalPlanId,
      session: {
        id: result.newSession.id,
        name: result.newSession.name,
        status: result.newSession.status,
        totalCapitalToman: result.newSession.totalCapitalToman,
        valuationPriceToman: result.newSession.valuationPriceToman,
        openingAllocations: result.newSession.openingAllocations
      },
      allocationSumToman: portfolioValueToman(
        preview.allocations,
        preview.valuationPriceToman
      ),
      residualToman: 0,
      balanceMarkedTotalToman: balanceMarked,
      oldCapitalToman: preview.oldCapitalToman,
      limits: preview.limits,
      orderCap: orderCapPolicy,
      activeSessionCount: activesAfter.length,
      history: history.map((h) => ({
        id: h.id,
        status: h.status,
        totalCapitalToman: h.totalCapitalToman,
        createdAt: h.createdAt,
        stoppedAt: h.stoppedAt
      })),
      paperOnly: true,
      realOrders: false
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
