import { NextResponse } from "next/server";
import { isSession } from "@/lib/requireApiAuth";
import { requireAdminSession } from "@/lib/requireAdmin";
import {
  getObservation,
  loadLatestCapitalApproval,
  loadLatestCapitalPlan,
  loadLatestAccountConfirmations,
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
import { loadEffectiveFees } from "@/lib/shadowArbitrage/effectiveFees";
import { loadRiskPolicyValues } from "@/db/repositories/shadowLive";
import { loadLastMatrix } from "@/lib/shadowArbitrage/store";
import { buildPolicyState } from "@/lib/shadowArbitrage/live/policy";
import {
  computeAllRouteSizes,
  SIZING_REQUIRED_POLICIES
} from "@/lib/shadowArbitrage/paper/sizing";
import { venueCapacity, type QuoteCapacityInput } from "@/lib/shadowArbitrage/paper/liquidity";
import {
  applyProposal,
  fingerprint,
  listDecisions,
  listProposals,
  recordProposal,
  type Fingerprints
} from "@/db/repositories/shadowAllocation";
import {
  buildLiquidityAwarePlan,
  type RouteObservation
} from "@/lib/shadowArbitrage/paper/allocation";
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

/**
 * Everything both allocation actions need, derived once from live evidence.
 *
 * The fingerprints are taken here so a proposal and a later apply are compared
 * against the same four facts — books, fees, account evidence and the policy
 * caps. Any drift between them makes the proposal stale, which is what stops an
 * allocation computed against a market that no longer exists from being applied.
 */
async function buildAllocationContext(): Promise<
  | { ok: false; messageFa: string }
  | {
      ok: true;
      totalCapitalToman: number;
      valuationPriceToman: number;
      venueIds: string[];
      observations: RouteObservation[];
      capacityBySource: Map<string, ReturnType<typeof venueCapacity>>;
      fingerprints: Fingerprints;
      appliedPolicyCaps: Record<string, number>;
      unsetPolicyCaps: string[];
      sessionId: string | null;
    }
> {
  const [snap, lastMatrix, fees, accounts, policyValues] = await Promise.all([
    snapshot(null),
    loadLastMatrix(),
    loadEffectiveFees(Date.now()),
    loadLatestAccountConfirmations(),
    loadRiskPolicyValues()
  ]);

  const readiness = buildAllReadiness(
    fees.overrides,
    Date.now(),
    Object.values(accounts),
    fees.blocks
  );
  const venues = classifyAllVenues(readiness).filter((v) => v.executable);
  if (!venues.length) return { ok: false, messageFa: "هیچ صرافی اجراپذیری وجود ندارد." };

  const sources = lastMatrix?.sources ?? [];
  const snapshotById = new Map(sources.map((x) => [x.sourceId as string, x]));
  const price =
    snap.session?.valuationPriceToman ??
    deriveValuationPrice(await loadLatestSourceSnapshots());
  if (!price || price <= 0) {
    return { ok: false, messageFa: "قیمت مبنای تتر در دسترس نیست؛ بدون آن تخصیص انجام نمی‌شود." };
  }

  const total = snap.session?.totalCapitalToman ?? DEFAULT_CAPITAL_TOMAN;
  const balances = (snap.balances ?? []).map((b) => ({
    sourceId: b.sourceId,
    irtToman: b.irtToman,
    usdtMicros: usdtToMicros(b.usdt)
  }));
  const shareBySource = new Map<string, number>(
    (snap.session?.openingAllocations ?? []).map((a) => [
      a.sourceId as string,
      Math.round(a.irtToman + a.usdtUnits * price)
    ])
  );

  const policies = buildPolicyState(policyValues);
  const orderSize = policies.find((p) => p.definition.key === "max_order_size_usdt");
  const orderSizeMicros = orderSize?.configured ? usdtToMicros(orderSize.value as number) : null;

  const capacityBySource = new Map<string, ReturnType<typeof venueCapacity>>();
  for (const v of venues) {
    const sn = snapshotById.get(v.sourceId);
    const bal = balances.find((b) => b.sourceId === v.sourceId);
    capacityBySource.set(
      v.sourceId,
      venueCapacity({
        sourceId: v.sourceId,
        marketModel: sn?.marketModel ?? "ORDER_BOOK",
        bookBids: sn?.bookBids ?? null,
        bookAsks: sn?.bookAsks ?? null,
        // Why the book is absent, not merely that it is.
        sourceFailureFa: sn?.errorReason ?? sn?.degradedReason ?? null,
        irtToman: bal?.irtToman ?? null,
        usdtMicros: bal?.usdtMicros ?? null,
        feeBps: readiness.find((r) => r.sourceId === v.sourceId)?.takerFeeBps ?? null,
        buyFeeAsset: settlementFor(v.sourceId as ShadowSourceId, "buy").feeAsset,
        sellFeeAsset: settlementFor(v.sourceId as ShadowSourceId, "sell").feeAsset,
        capitalShareToman: shareBySource.get(v.sourceId) ?? null,
        policyOrderSizeMicros: orderSizeMicros,
        policyExposureMicros: null
      })
    );
  }

  /*
   * Observations drive the role split. Only FILLED history is used — a route
   * the desk actually captured profit on is evidence; a route that merely
   * looked good is not.
   */
  const byRoute = new Map<string, RouteObservation>();
  for (const t of snap.trades ?? []) {
    const key = `${t.buySourceId}->${t.sellSourceId}`;
    const prev = byRoute.get(key);
    const pnl = Number(t.riskAdjustedPnlToman ?? 0);
    if (prev) {
      prev.occurrences += 1;
      prev.riskAdjustedPnlToman += pnl;
    } else {
      byRoute.set(key, {
        buySourceId: t.buySourceId,
        sellSourceId: t.sellSourceId,
        occurrences: 1,
        riskAdjustedPnlToman: pnl,
        capacityUsdtMicros: capacityBySource.get(t.buySourceId)?.buy.capacityUsdtMicros ?? 0
      });
    }
  }

  const appliedPolicyCaps: Record<string, number> = {};
  const unsetPolicyCaps: string[] = [];
  for (const p of policies) {
    if (p.configured && p.value !== null) appliedPolicyCaps[p.definition.key] = p.value;
    else unsetPolicyCaps.push(p.definition.key);
  }

  return {
    ok: true,
    totalCapitalToman: total,
    valuationPriceToman: price,
    venueIds: venues.map((v) => v.sourceId),
    observations: [...byRoute.values()].sort((a, b) =>
      `${a.buySourceId}->${a.sellSourceId}`.localeCompare(`${b.buySourceId}->${b.sellSourceId}`)
    ),
    capacityBySource,
    fingerprints: {
      books: fingerprint(
        sources
          .map((x) => ({ id: x.sourceId, bids: x.bookBids, asks: x.bookAsks }))
          .sort((a, b) => a.id.localeCompare(b.id))
      ),
      fees: fingerprint(fees),
      accounts: fingerprint(accounts),
      policy: fingerprint({ applied: appliedPolicyCaps, unset: [...unsetPolicyCaps].sort() })
    },
    appliedPolicyCaps,
    unsetPolicyCaps,
    sessionId: snap.session?.id ?? null
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
    loadEffectiveFees(Date.now()),
    loadLatestAccountConfirmations(),
    loadLatestCapitalPlan()
  ]);
  const wizardReadiness = buildAllReadiness(
    wizardFees.overrides,
    Date.now(),
    Object.values(wizardAccounts),
    wizardFees.blocks
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
  const maxQuoteAgePolicy = policies.find((p) => p.definition.key === "max_quote_age_ms");
  const maxQuoteAgeMsPolicy = maxQuoteAgePolicy?.configured
    ? ((maxQuoteAgePolicy.value as number) ?? null)
    : null;
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
        sourceFailureFa: snapshot?.errorReason ?? snapshot?.degradedReason ?? null,
        irtToman: balance?.irtToman ?? null,
        usdtMicros: balance?.usdtMicros ?? null,
        feeBps: feeBpsById.get(v.sourceId) ?? null,
        buyFeeAsset: settlementFor(v.sourceId as ShadowSourceId, "buy").feeAsset,
        sellFeeAsset: settlementFor(v.sourceId as ShadowSourceId, "sell").feeAsset,
        capitalShareToman: allocationTomanBySource.get(v.sourceId) ?? null,
        policyOrderSizeMicros,
        // Exposure is a portfolio-level ceiling, not a per-venue one; it is
        // applied per route where the current exposure is known.
        policyExposureMicros: null,
        // Order-book venues leave this undefined; a dealer is measured from it.
        quote:
          snapshot?.marketModel === "OTC_QUOTE"
            ? {
                userBuyPriceToman: snapshot.userBuyPriceToman,
                userSellPriceToman: snapshot.userSellPriceToman,
                maxExecutableUsdt: snapshot.maxExecutableUsdt,
                ageMs: snapshot.ageMs,
                stale: snapshot.stale,
                maxQuoteAgeMs: maxQuoteAgeMsPolicy
              }
            : undefined
      }),
      nameFa: v.nameFa
    };
  });

  const latestProposalRows =
    ((await listProposals(1))[0]?.rows as Array<{ sourceId: string; role: string }> | undefined) ?? [];

  /** Dealer quotes, built once and shared by capacity and route sizing. */
  const quoteBySource = new Map<string, QuoteCapacityInput>();
  for (const v of wizard.eligibleVenues) {
    const sn = snapshotById.get(v.sourceId);
    if (sn?.marketModel !== "OTC_QUOTE") continue;
    quoteBySource.set(v.sourceId, {
      userBuyPriceToman: sn.userBuyPriceToman,
      userSellPriceToman: sn.userSellPriceToman,
      maxExecutableUsdt: sn.maxExecutableUsdt,
      ageMs: sn.ageMs,
      stale: sn.stale,
      maxQuoteAgeMs: maxQuoteAgeMsPolicy
    });
  }

  const sizingRoutes = computeAllRouteSizes({
    venueIds: wizard.eligibleVenues.map((v) => v.sourceId),
    snapshotById,
    feeBpsById,
    settlementFor: (id, side) => settlementFor(id as ShadowSourceId, side),
    balances: sizingBalances,
    allocationTomanBySource,
    portfolioValueToman,
    exposureTomanBySource,
    policies,
    slippageBufferBps: SLIPPAGE_BUFFER_BPS,
    quoteBySource
  });

  /*
   * Four DIFFERENT facts, counted separately.
   *
   * "9/9 executable" collapsed all of them into one number and implied a
   * readiness nobody established: KYC says who we are, capacity says whether
   * the market data supports sizing, the role says what the plan funds it for,
   * and route-usable says whether it can actually take a trade this cycle. A
   * venue can be first without being last.
   */
  const venueSemantics = (() => {
    /*
     * Usability is PER LEG. Arbitrage needs one venue to buy on and another to
     * sell on; a venue that can only buy is still a full participant. Requiring
     * both directions of the same venue was the mistake that excluded a dealer
     * whose buy leg was perfectly usable.
     *
     * Usability is also NOT profitability: a leg is usable when the cycle can
     * size it, whether or not the resulting trade happens to be worth taking.
     */
    const buyUsable = new Set<string>();
    const sellUsable = new Set<string>();
    for (const r of sizingRoutes) {
      if (!r.sizing.candidates.length) continue;
      buyUsable.add(r.buySourceId);
      sellUsable.add(r.sellSourceId);
    }

    const matrix = wizardReadiness.map((r) => {
      const cap = venueCapacities.find((v) => v.sourceId === r.sourceId);
      const role =
        latestProposalRows.find((x) => x.sourceId === r.sourceId)?.role ?? null;
      const buyOk = buyUsable.has(r.sourceId);
      const sellOk = sellUsable.has(r.sourceId);
      return {
        sourceId: r.sourceId,
        nameFa: r.nameFa,
        dataType: cap?.marketModel === "OTC_QUOTE" ? "EXECUTABLE_QUOTE" : "ORDER_BOOK",
        kycComplete: r.kycComplete,
        accountEligible: r.executionEligible,
        feeConfirmed: r.takerFeeBps !== null,
        buyCapacityUsdtMicros: cap?.buy.capacityUsdtMicros ?? null,
        sellCapacityUsdtMicros: cap?.sell.capacityUsdtMicros ?? null,
        buyLimiter: cap?.buy.limitingCap ?? null,
        sellLimiter: cap?.sell.limitingCap ?? null,
        buyReason: cap?.buy.reason ?? "no_balance_record",
        sellReason: cap?.sell.reason ?? "no_balance_record",
        buyLegUsable: buyOk,
        sellLegUsable: sellOk,
        // One valid leg is enough to participate in arbitrage.
        participates: buyOk || sellOk,
        allocationRole: role,
        blockerFa:
          buyOk || sellOk
            ? null
            : (cap?.buy.reasonFa ?? "هیچ مسیری با این صرافی در این چرخه قابل اندازه‌گیری نبود")
      };
    });

    return {
      total: wizardReadiness.length,
      kycConfirmed: wizardReadiness.filter((r) => r.kycComplete).length,
      accountEligible: wizardReadiness.filter((r) => r.executionEligible).length,
      buyCapacityMeasurable: matrix.filter((m) => m.buyCapacityUsdtMicros !== null).length,
      sellCapacityMeasurable: matrix.filter((m) => m.sellCapacityUsdtMicros !== null).length,
      buyLegUsable: matrix.filter((m) => m.buyLegUsable).length,
      sellLegUsable: matrix.filter((m) => m.sellLegUsable).length,
      participating: matrix.filter((m) => m.participates).length,
      quoteOnly: matrix
        .filter((m) => m.dataType === "EXECUTABLE_QUOTE")
        .map((m) => ({ sourceId: m.sourceId, buyReason: m.buyReason, sellReason: m.sellReason })),
      unverified: matrix
        .filter((m) => m.buyCapacityUsdtMicros === null && m.sellCapacityUsdtMicros === null)
        .map((m) => ({ sourceId: m.sourceId, reason: m.buyReason, reasonFa: m.blockerFa ?? "" })),
      matrix
    };
  })();

  const sizing = {
    requiredPolicies: SIZING_REQUIRED_POLICIES,
    venueSemantics,
    venueCapacities,
    missingPolicies: SIZING_REQUIRED_POLICIES.filter(
      (k) => !policies.find((p) => p.definition.key === k)?.configured
    ),
    probeSizesUsdt: SHADOW_TRADE_SIZES,
    routes: sizingRoutes
  };

  /*
   * Phase 8C-5 — the latest persisted proposal and what was decided about it.
   * Loaded on every read so a refresh shows the same proposal, status and
   * audit result rather than an empty panel.
   */
  const [latestProposals, latestDecisions] = await Promise.all([
    listProposals(1),
    listDecisions(undefined, 1)
  ]);
  const latestProposal = latestProposals[0] ?? null;
  const latestDecision =
    latestProposal && latestDecisions[0]?.proposalId === latestProposal.id
      ? latestDecisions[0]
      : ((await listDecisions(latestProposal?.id, 1))[0] ?? null);

  /*
   * Scenario caps are recorded in the note as `SCENARIO {...}`. Parsing them
   * back means the controls repopulate after a hard reload instead of silently
   * resetting to UNSET, which would misrepresent what the proposal was built on.
   */
  let scenarioCaps: Record<string, number> | null = null;
  const scenarioMatch = latestProposal?.note?.match(/^SCENARIO (\{.*?\})/);
  if (scenarioMatch) {
    try {
      scenarioCaps = JSON.parse(scenarioMatch[1]) as Record<string, number>;
    } catch {
      scenarioCaps = null;
    }
  }

  const allocation = {
    proposal: latestProposal ? { ...latestProposal, scenarioCaps } : null,
    decision: latestDecision
      ? {
          decision: latestDecision.decision,
          detailFa: latestDecision.detailFa,
          decidedBy: latestDecision.decidedBy,
          decidedAt: String(latestDecision.decidedAt)
        }
      : null,
    /** What the engine would apply right now — for the staleness banner. */
    currentFingerprintsAvailable: true
  };

  return new NextResponse(JSON.stringify(envelope({ ...snap, history, wizard, sizing, allocation })), {
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
  if (
    !["create", "start", "pause", "resume", "stop", "propose_allocation", "apply_allocation"].includes(
      action
    )
  ) {
    return bad("عملیات نامعتبر است");
  }

  /*
   * Phase 8C-5 — allocation proposals.
   *
   * `propose_allocation` only computes and stores; it never changes a balance.
   * `apply_allocation` is the single explicit step that does, and it refuses a
   * proposal whose evidence has moved. Neither can place an order.
   */
  if (action === "propose_allocation" || action === "apply_allocation") {
    const ctx = await buildAllocationContext();
    if (!ctx.ok) return bad(ctx.messageFa, "allocation_unavailable");

    if (action === "propose_allocation") {
      /*
       * Scenario caps let an administrator ask "what would this look like if
       * the limit were X" WITHOUT approving X. A proposal built on them is
       * marked PREVIEW and can never be applied — applying a plan shaped by an
       * unapproved limit would launder a guess into the active allocation.
       *
       * `null` means UNSET (not applied); an explicit 0 is a real value and
       * stays distinct from it.
       */
      const raw = (body.scenarioCaps ?? {}) as Record<string, unknown>;
      const scenarioCaps: Record<string, number> = {};
      for (const [k, v] of Object.entries(raw)) {
        if (v === null || v === undefined || v === "") continue;
        const n = Number(v);
        if (Number.isFinite(n) && n >= 0) scenarioCaps[k] = n;
      }
      const isScenario = Object.keys(scenarioCaps).length > 0;

      const plan = buildLiquidityAwarePlan({
        totalCapitalToman: ctx.totalCapitalToman,
        valuationPriceToman: ctx.valuationPriceToman,
        venueIds: ctx.venueIds,
        observations: ctx.observations
      });
      if (plan.residualToman !== 0) {
        return bad(`پیشنهاد حفظ سرمایه را نقض کرد: باقی‌مانده ${plan.residualToman}`);
      }
      const stored = await recordProposal({
        totalCapitalToman: plan.totalCapitalToman,
        valuationPriceToman: plan.valuationPriceToman,
        allocatedToman: plan.allocatedToman,
        residualToman: plan.residualToman,
        rows: plan.rows.map((r) => {
          const cap = ctx.capacityBySource.get(r.sourceId);
          return {
            sourceId: r.sourceId,
            role: r.role,
            irtToman: r.irtToman,
            usdtUnits: r.usdtUnits,
            valueToman: r.valueToman,
            sharePercent: r.sharePercent,
            buyCapacityUsdtMicros: cap?.buy.capacityUsdtMicros ?? null,
            sellCapacityUsdtMicros: cap?.sell.capacityUsdtMicros ?? null,
            buyLimiter: cap?.buy.limitingCap ?? null,
            sellLimiter: cap?.sell.limitingCap ?? null,
            buyReason: cap?.buy.reason ?? "no_balance_record",
            sellReason: cap?.sell.reason ?? "no_balance_record",
            reasonFa: r.reasonFa
          };
        }),
        fingerprints: ctx.fingerprints,
        appliedPolicyCaps: { ...ctx.appliedPolicyCaps, ...scenarioCaps },
        unsetPolicyCaps: ctx.unsetPolicyCaps.filter((k) => !(k in scenarioCaps)),
        observations: ctx.observations,
        createdBy: session.u ?? "admin",
        status: isScenario ? "PREVIEW" : "PROPOSED",
        scenarioCaps: isScenario ? scenarioCaps : null,
        note: typeof body.note === "string" ? body.note.slice(0, 500) : null
      });
      return new NextResponse(
        JSON.stringify(envelope({ proposal: stored, warningsFa: plan.errorsFa })),
        { status: 200, headers: SHADOW_NO_STORE }
      );
    }

    const proposalId = String(body.proposalId ?? "");
    const idempotencyKey = String(body.idempotencyKey ?? "");
    if (!proposalId || !idempotencyKey) {
      return bad("شناسهٔ پیشنهاد و کلید یکتاسازی الزامی است");
    }
    if (!ctx.sessionId) return bad("برای اعمال تخصیص، یک نشست کاغذی لازم است");

    const outcome = await applyProposal({
      proposalId,
      sessionId: ctx.sessionId,
      idempotencyKey,
      currentFingerprints: ctx.fingerprints,
      decidedBy: session.u ?? "admin"
    });
    return new NextResponse(JSON.stringify(envelope({ outcome })), {
      status: outcome.ok || outcome.idempotentReplay ? 200 : 409,
      headers: SHADOW_NO_STORE
    });
  }

  if (action === "create") {
    const mode: PaperSessionMode =
      body.mode === "APPROVED_PLAN" ? "APPROVED_PLAN" : "PROVISIONAL_EVALUATION";

    const [latestFees, snapshots, observation, savedPlan, approvalRow] = await Promise.all([
      loadEffectiveFees(Date.now()),
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
      latestFees.overrides,
      Date.now(),
      Object.values(accountEvidence),
      latestFees.blocks
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
