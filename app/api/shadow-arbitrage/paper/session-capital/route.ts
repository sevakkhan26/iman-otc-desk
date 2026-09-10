/**
 * Admin-only Paper session setup (Step 6).
 *
 * GET  — active session + limits + last setup config (read-only).
 * POST action=preview — capital, duration, order-cap choice; residual must be 0.
 * POST action=apply   — confirm required; archive active; one new RUNNING session.
 *
 * Never silently mutates or extends the current session. Paper only.
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
  PAPER_POLICY_MIN_USDT,
  PAPER_POLICY_MIN_KEY,
  bindingFromSessionSetupPreview,
  buildSessionSetupPreview,
  computeSessionEndsAt,
  formatSessionSetupNote,
  parseDurationDays,
  parseManualOrderCapUsdt,
  parseSessionSetupNote,
  parseWholeTomanCapital,
  type SessionOrderCapChoice,
  type SessionSetupConfig
} from "@/lib/shadowArbitrage/paper/sessionCapital";
import {
  PREVIEW_TOKEN_TTL_MS,
  loadSessionCapitalPreview,
  persistSessionCapitalPreview,
  requestMatchesPreviewBinding
} from "@/lib/shadowArbitrage/paper/sessionCapitalPreviewStore";
import { portfolioValueToman } from "@/lib/shadowArbitrage/paper/portfolio";
import { SHADOW_NO_STORE } from "@/lib/shadowArbitrage/httpHeaders";
import { loadRiskPolicyValues, recordRiskPolicy } from "@/db/repositories/shadowLive";
import { buildPolicyState } from "@/lib/shadowArbitrage/live/policy";
import { buildOpeningAllocationEvidence } from "@/lib/shadowArbitrage/paper/allocation";
import type { BookLevel } from "@/lib/shadowArbitrage/types";

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

function openingAllocationEvidence(
  snapshots: Awaited<ReturnType<typeof loadLatestSourceSnapshots>>
) {
  return buildOpeningAllocationEvidence(
    snapshots.map((s) => {
      const payload = s.payload ?? {};
      const feeBps = Number(payload.feeBps);
      return {
        sourceId: s.sourceId,
        stale: s.stale,
        health: s.health,
        executionEligible: s.certStatus === "LIVE_VERIFIED",
        // LIVE_VERIFIED cert evidence is what confirms the route's fee tier.
        feeCertain: s.certStatus === "LIVE_VERIFIED" && Number.isFinite(feeBps),
        feeBps: Number.isFinite(feeBps) ? feeBps : null,
        userBuyToman: s.userBuy,
        userSellToman: s.userSell,
        bookAsks: (payload.bookAsks as BookLevel[] | null | undefined) ?? null,
        bookBids: (payload.bookBids as BookLevel[] | null | undefined) ?? null
      };
    })
  );
}

function parseOrderCapChoice(raw: unknown): SessionOrderCapChoice | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (s === "AUTO_CAPITAL_DERIVED" || s === "AUTO" || s === "CAPITAL_DERIVED") {
    return "AUTO_CAPITAL_DERIVED";
  }
  if (s === "MANUAL" || s === "EXPLICIT") return "MANUAL";
  return null;
}

export async function GET() {
  const session = await requireAdminSession();
  if (!isSession(session)) return session;

  const [active, actives, snapshots, policyRows] = await Promise.all([
    getActivePaperSession(),
    listActivePaperSessions(),
    loadLatestSourceSnapshots(),
    loadRiskPolicyValues()
  ]);
  const mark = deriveValuationPrice(snapshots);
  const policyState = buildPolicyState(policyRows, Date.now());
  const orderPol = policyState.find((p) => p.definition.key === "max_order_size_usdt");
  const setup = active ? parseSessionSetupNote(active.note) : null;

  return new NextResponse(
    JSON.stringify({
      unit: "toman",
      paperPolicyMinUsdt: PAPER_POLICY_MIN_USDT,
      paperPolicyMinKey: PAPER_POLICY_MIN_KEY,
      limits: {
        minCapitalToman: MIN_CAPITAL_TOMAN,
        maxCapitalToman: MAX_CAPITAL_TOMAN,
        minDurationDays: 1,
        maxDurationDays: 365
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
            startedAt: active.startedAt,
            note: active.note,
            setup
          }
        : null,
      currentOrderCap: orderPol?.configured
        ? {
            valueUsdt: orderPol.value as number,
            setBy: orderPol.setBy,
            mode:
              (orderPol.setBy ?? "").startsWith("capital-derived") || !orderPol.setBy
                ? "AUTO_CAPITAL_DERIVED"
                : "MANUAL"
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

  const durationParsed = parseDurationDays(
    body.durationDays !== undefined && body.durationDays !== null ? body.durationDays : 4
  );
  if (!durationParsed.ok) {
    return bad(durationParsed.messageFa, "bad_duration", 400);
  }

  const orderCapChoice =
    parseOrderCapChoice(body.orderCapMode ?? body.orderCapChoice) ?? "AUTO_CAPITAL_DERIVED";

  let manualOrderCapUsdt: number | null = null;
  if (orderCapChoice === "MANUAL") {
    const m = parseManualOrderCapUsdt(body.manualOrderCapUsdt ?? body.orderCapUsdt);
    if (!m.ok) return bad(m.messageFa, "bad_order_cap", 400);
    manualOrderCapUsdt = m.value;
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

  const clockMs = Date.now();

  if (action === "preview") {
    const allocationEvidence = openingAllocationEvidence(snapshots);
    let preview;
    try {
      preview = buildSessionSetupPreview({
        totalCapitalToman: parsed.value,
        valuationPriceToman: mark,
        venueIds: venueIds(),
        eligibleVenueIds: allocationEvidence.eligibleVenueIds,
        allocationObservations: allocationEvidence.observations,
        activeSessionId: active?.id ?? null,
        oldCapitalToman: active?.totalCapitalToman ?? null,
        currentOrderCap,
        orderCapChoice,
        manualOrderCapUsdt,
        durationDays: durationParsed.value,
        clockMs
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
    const binding = bindingFromSessionSetupPreview(preview, {
      activeSessionId: active?.id ?? null,
      orderCapChoice,
      manualOrderCapUsdt,
      durationDays: durationParsed.value
    });
    const createdAt = new Date(clockMs).toISOString();
    const expiresAt = new Date(clockMs + PREVIEW_TOKEN_TTL_MS).toISOString();
    await persistSessionCapitalPreview({
      version: 1,
      previewToken: preview.previewToken,
      createdAt,
      expiresAt,
      binding,
      startedAt: preview.startedAt,
      endsAt: preview.endsAt,
      orderCapChoice: preview.orderCapChoice,
      paperPolicyMinUsdt: preview.paperPolicyMinUsdt,
      smartSizeCeilingUsdt: preview.smartSizeCeilingUsdt,
      usableCapitalToman: preview.usableCapitalToman,
      reserveCapitalToman: preview.reserveCapitalToman,
      limits: preview.limits
    });
    return new NextResponse(
      JSON.stringify({
        unit: "toman",
        action: "preview",
        paperPolicyMinUsdt: PAPER_POLICY_MIN_USDT,
        paperPolicyMinKey: PAPER_POLICY_MIN_KEY,
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
          unallocatedReserveToman: preview.unallocatedReserveToman,
          allocationValid: preview.allocationValid,
          allocationErrorsFa: preview.allocationErrorsFa,
          perVenue: preview.perVenue,
          limits: preview.limits,
          usableCapitalToman: preview.usableCapitalToman,
          reserveCapitalToman: preview.reserveCapitalToman,
          orderCap: {
            ...preview.orderCap,
            choice: preview.orderCapChoice
          },
          orderCapChoice: preview.orderCapChoice,
          durationDays: preview.durationDays,
          startedAt: preview.startedAt,
          endsAt: preview.endsAt,
          paperPolicyMinUsdt: preview.paperPolicyMinUsdt,
          smartSizeCeilingUsdt: preview.smartSizeCeilingUsdt,
          previewToken: preview.previewToken,
          expiresAt
        },
        requiresConfirmation: true,
        neverSilentExtend: true
      }),
      { status: 200, headers: SHADOW_NO_STORE }
    );
  }

  // apply
  if (body.confirm !== true) {
    return bad("اعمال نشست نیازمند confirm: true است", "confirmation_required", 400);
  }
  const token = typeof body.previewToken === "string" ? body.previewToken : "";
  const applyClock = Date.now();
  const stored = token ? await loadSessionCapitalPreview(token, applyClock) : null;
  /*
   * Apply must bind to the frozen preview plan. Rebuilding from live books here
   * caused invalid_preview_token whenever depth/eligibility drifted between
   * preview and apply. Missing/expired/mismatched binding → exact 409.
   */
  if (!stored) {
    return bad(
      "previewToken نامعتبر یا منقضی است — دوباره پیش‌نمایش بگیرید",
      "invalid_preview_token",
      409
    );
  }
  if (
    !requestMatchesPreviewBinding({
      binding: stored.binding,
      totalCapitalToman: parsed.value,
      valuationPriceToman: mark,
      durationDays: durationParsed.value,
      orderCapChoice,
      manualOrderCapUsdt,
      activeSessionId: active?.id ?? null
    })
  ) {
    return bad(
      "previewToken نامعتبر یا منقضی است — دوباره پیش‌نمایش بگیرید",
      "invalid_preview_token",
      409
    );
  }
  if (!stored.binding.allocationValid) {
    return bad(
      "تخصیص نقش‌محور اجراپذیر نیست",
      "allocation_not_operable",
      409
    );
  }

  const bound = stored.binding;
  const startedAt = new Date(applyClock).toISOString();
  const endsAt = computeSessionEndsAt(applyClock, bound.durationDays ?? durationParsed.value);

  const setupConfig: SessionSetupConfig = {
    version: 1,
    durationDays: bound.durationDays ?? durationParsed.value,
    endsAt,
    startedAt,
    orderCapChoice,
    orderCapUsdt: bound.effectiveMaxOrderUsdt,
    paperPolicyMinUsdt: PAPER_POLICY_MIN_USDT,
    totalCapitalToman: bound.totalCapitalToman,
    valuationPriceToman: bound.valuationPriceToman,
    previewToken: token
  };

  const sessionNote = formatSessionSetupNote(setupConfig, [
    `actor=${session.u ?? "admin"}`,
    `previewToken=${token.slice(0, 16)}`,
    `unit=toman`
  ].join("; "));

  const result = await replaceActivePaperSessionCapital({
    totalCapitalToman: bound.totalCapitalToman,
    valuationPriceToman: bound.valuationPriceToman,
    openingAllocations: bound.allocations,
    createdBy: session.u ?? "admin",
    previewToken: token,
    name:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim().slice(0, 80)
        : `نشست کاغذی ${bound.totalCapitalToman.toLocaleString("en-US")} · ${setupConfig.durationDays}d`,
    sessionNote
  });

  /*
   * Always write order-cap policy for setup choices:
   * AUTO → capital-derived actor; MANUAL → admin actor with fixed USDT.
   * Never skip silently when choice was provided.
   */
  let orderCapPolicy: {
    written: boolean;
    mode: string;
    choice: SessionOrderCapChoice;
    valueUsdt: number;
  } | null = null;

  if (!result.reused) {
    if (orderCapChoice === "AUTO_CAPITAL_DERIVED") {
      await recordRiskPolicy({
        policyKey: "max_order_size_usdt",
        value: bound.effectiveMaxOrderUsdt,
        setBy: ORDER_CAP_DERIVED_ACTOR,
        validForDays: 30,
        note: `AUTO_CAPITAL_DERIVED equity=${bound.totalCapitalToman} mark=${bound.valuationPriceToman} session=${result.newSession.id}`
      });
      orderCapPolicy = {
        written: true,
        mode: "capital_derived",
        choice: "AUTO_CAPITAL_DERIVED",
        valueUsdt: bound.effectiveMaxOrderUsdt
      };
    } else {
      await recordRiskPolicy({
        policyKey: "max_order_size_usdt",
        value: bound.effectiveMaxOrderUsdt,
        setBy: session.u ?? "admin",
        validForDays: 30,
        note: `MANUAL order cap ${bound.effectiveMaxOrderUsdt} USDT session=${result.newSession.id}`
      });
      orderCapPolicy = {
        written: true,
        mode: "explicit_admin",
        choice: "MANUAL",
        valueUsdt: bound.effectiveMaxOrderUsdt
      };
    }
  } else {
    orderCapPolicy = {
      written: false,
      mode: bound.mode,
      choice: orderCapChoice,
      valueUsdt: bound.effectiveMaxOrderUsdt
    };
  }

  const bals = await loadPaperBalances(result.newSession.id);
  const balanceMarked = bals.reduce(
    (s, b) => s + b.irtToman + Math.round((b.usdtMicros / 1e6) * bound.valuationPriceToman),
    0
  );
  const activesAfter = await listActivePaperSessions();
  const history = await listPaperSessions(10);
  const persistedSetup = parseSessionSetupNote(result.newSession.note);

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
        openingAllocations: result.newSession.openingAllocations,
        startedAt: result.newSession.startedAt,
        note: result.newSession.note,
        setup: persistedSetup
      },
      setup: setupConfig,
      endsAt: setupConfig.endsAt,
      durationDays: setupConfig.durationDays,
      allocationSumToman: portfolioValueToman(
        bound.allocations,
        bound.valuationPriceToman
      ),
      residualToman: 0,
      balanceMarkedTotalToman: balanceMarked,
      oldCapitalToman: bound.oldCapitalToman,
      limits: stored.limits,
      usableCapitalToman: stored.usableCapitalToman,
      reserveCapitalToman: stored.reserveCapitalToman,
      smartSizeCeilingUsdt: stored.smartSizeCeilingUsdt,
      paperPolicyMinUsdt: PAPER_POLICY_MIN_USDT,
      orderCap: orderCapPolicy,
      activeSessionCount: activesAfter.length,
      history: history.map((h) => ({
        id: h.id,
        status: h.status,
        totalCapitalToman: h.totalCapitalToman,
        createdAt: h.createdAt,
        stoppedAt: h.stoppedAt,
        setup: parseSessionSetupNote(h.note)
      })),
      paperOnly: true,
      realOrders: false
    }),
    { status: 200, headers: SHADOW_NO_STORE }
  );
}
