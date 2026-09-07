/**
 * Phase 6 — orchestration between one collection cycle and the paper engine.
 *
 * This is the only Phase 6 file that touches the database. It still cannot
 * trade: it reads a cycle that already happened, asks the pure engine what a
 * paper session would have done, and writes the result. There is no exchange
 * client, no credential, no order and no transfer anywhere in the path.
 *
 * The whole entry point is wrapped so a paper failure can never take down the
 * collector — the observation must keep running no matter what happens here.
 */
import { loadLatestAccountConfirmations } from "@/db/repositories/shadowArbitrage";
import {
  commitPaperCycle,
  getActivePaperSession,
  loadFilledLifecycleIds,
  loadPaperBalances,
  setPaperSessionStatus,
  type PaperFillRecord,
  type PaperSessionRow,
  type PaperSkipRecord
} from "@/db/repositories/shadowPaper";
import { loadRiskPolicyValues } from "@/db/repositories/shadowLive";
import { buildAllReadiness } from "@/lib/shadowArbitrage/accounts";
import { classifyAllVenues } from "@/lib/shadowArbitrage/capital";
import { SLIPPAGE_BUFFER_BPS } from "@/lib/shadowArbitrage/config";
import { loadEffectiveFees } from "@/lib/shadowArbitrage/effectiveFees";
import { buildPolicyState } from "@/lib/shadowArbitrage/live/policy";
import { mulPriceSizeToman } from "@/lib/shadowArbitrage/money";
import { describeRebalance, evaluateCycle } from "@/lib/shadowArbitrage/paper/engine";
import { targetsFromAllocations, type InventoryModel } from "@/lib/shadowArbitrage/paper/inventory";
import { microsToUsdt, type VenueBalance } from "@/lib/shadowArbitrage/paper/broker";
import type { QuoteCapacityInput } from "@/lib/shadowArbitrage/paper/liquidity";
import type { PaperPortfolioTelemetry } from "@/lib/shadowArbitrage/paper/portfolioAllocator";
import { OpportunitySurvivalTracker } from "@/lib/shadowArbitrage/paper/opportunitySurvival";
import type { NormalizedSourceSnapshot, ShadowOpportunity, ShadowSourceId } from "@/lib/shadowArbitrage/types";

export type PaperCycleOutcome = {
  ran: boolean;
  reason?: "no_session" | "not_running" | "cycle_not_successful" | "error";
  sessionId?: string;
  filled?: number;
  skipped?: number;
  duplicates?: number;
  eligibleCandidates?: number;
  /** Machine-readable economic liveness supervisor payload (non-authoritative terminal). */
  economicLiveness?: Record<string, unknown> | null;
  portfolio?: PaperPortfolioTelemetry | null;
  marketData?: {
    decisionTimestampMs: number;
    decisionCompletedTimestampMs: number;
    coherentRouteCount: number;
    blockedRouteCount: number;
    sourceEventLatencyMs: number[];
    receiveAgeMs: number[];
    ingestToDecisionLatencyMs: number[];
    eventToDecisionLatencyMs: number[];
    venues: Array<{
      sourceId: string;
      transport: string;
      sourceEventAgeMs: number;
      latencyEstimateMs: number | null;
      jitterMs: number | null;
      reconnectCount: number;
      gapCount: number;
      resyncCount: number;
      resyncProvenance: string | null;
      snapshotResyncState: string;
      sourceEventLatencyMs: number | null;
      receiveAgeAtDecisionMs: number | null;
    }>;
  };
  /** Detailed rows this cycle wrote — normally 0 once the market is steady. */
  detailedEventsWritten?: number;
  error?: string;
};

/** In-process Paper evidence is isolated per immutable session id. */
const survivalTrackersBySession = new Map<string, OpportunitySurvivalTracker>();

/**
 * Run the paper engine for one completed collection cycle.
 *
 * Only a RUNNING session executes: a session that was created but never started
 * — the state right after a deployment — is left alone, and a paused one stays
 * paused. Session state lives entirely in the database, so a restarted
 * container picks the same session back up with the same balances and the same
 * filled-lifecycle memory.
 */
export async function runPaperExecutionForCycle(input: {
  runId: string | null;
  occurredAt: string;
  cycleStatus: "success" | "partial" | "failed";
  sources: NormalizedSourceSnapshot[];
  opportunities: ShadowOpportunity[];
}): Promise<PaperCycleOutcome> {
  // Only a successful cycle carries a market picture worth acting on.
  if (input.cycleStatus === "failed") {
    return { ran: false, reason: "cycle_not_successful" };
  }

  const session: PaperSessionRow | null = await getActivePaperSession();
  if (!session) return { ran: false, reason: "no_session" };
  if (session.status !== "RUNNING") return { ran: false, reason: "not_running", sessionId: session.id };

  /*
   * Session-setup duration gate: immutable endsAt from note (paper_session_setup_v1).
   * Never extends endsAt on restart — only archives when elapsed.
   */
  try {
    const { parseSessionSetupNote } = await import(
      "@/lib/shadowArbitrage/paper/sessionCapital"
    );
    const setup = parseSessionSetupNote(session.note);
    if (setup?.endsAt) {
      const endsMs = Date.parse(setup.endsAt);
      if (Number.isFinite(endsMs) && Date.now() >= endsMs) {
        await setPaperSessionStatus(session.id, "STOPPED");
        return { ran: false, reason: "not_running", sessionId: session.id };
      }
    }
  } catch {
    /* ignore parse errors — fail open to experiment gate below */
  }

  /*
   * Four-day experiment gate: while an ACTIVE experiment exists, new Paper
   * trades only open before endsAt. After endsAt, complete the experiment and
   * leave the collector running without new fills.
   */
  try {
    const { getActiveExperiment, experimentIsOpen, completeExperiment } = await import(
      "@/db/repositories/shadowExperiments"
    );
    const { loadPaperStats } = await import("@/db/repositories/shadowPaper");
    const exp = await getActiveExperiment();
    if (exp) {
      const nowMs = Date.now();
      if (!experimentIsOpen(exp, nowMs)) {
        const stats = await loadPaperStats(session.id);
        await completeExperiment(exp.id, {
          completedReason: "duration_elapsed",
          completedAt: new Date(nowMs).toISOString(),
          filled: stats.filled,
          skipped: stats.skipped,
          economicNetPnlToman: stats.economicNetPnlToman
        });
        await setPaperSessionStatus(session.id, "STOPPED");
        return { ran: false, reason: "not_running", sessionId: session.id };
      }
    }
  } catch {
    /* experiment module optional if migration not yet applied */
  }

  const [effectiveFees, accountEvidence, balanceRows, filledIds, policyValues] = await Promise.all([
    loadEffectiveFees(Date.now()),
    loadLatestAccountConfirmations(),
    loadPaperBalances(session.id),
    loadFilledLifecycleIds(session.id),
    loadRiskPolicyValues()
  ]);

  /*
   * Phase 8E-B — the paper engine prices and settles with the same effective
   * fee the collector validated the opportunity with. A venue whose evidence
   * did not match arrives as a block, so it carries no rate here either and
   * never becomes executable on a fallback number.
   */
  const venueStates = classifyAllVenues(
    buildAllReadiness(
      effectiveFees.overrides,
      Date.now(),
      Object.values(accountEvidence),
      effectiveFees.blocks
    )
  );
  const balances: VenueBalance[] = balanceRows.map((b) => ({
    sourceId: b.sourceId as ShadowSourceId,
    irtToman: b.irtToman,
    usdtMicros: b.usdtMicros
  }));

  /*
   * Phase 8C-3 — the risk context dynamic sizing needs.
   *
   * The session's own valuation price marks the portfolio and each venue's
   * share, so exposure is measured the same way the session was opened. The
   * capital plan comes from the session's opening allocations rather than the
   * latest saved plan: a running session must be sized against the money it
   * actually started with, not against a plan edited after it began.
   */
  const valuationPriceToman = session.valuationPriceToman;
  const exposureTomanBySource = new Map<string, number>(
    balances.map((b) => [
      b.sourceId as string,
      b.irtToman + mulPriceSizeToman(valuationPriceToman, microsToUsdt(b.usdtMicros))
    ])
  );
  const allocationTomanBySource = new Map<string, number>(
    session.openingAllocations.map((a) => [
      a.sourceId as string,
      Math.round(a.irtToman + mulPriceSizeToman(valuationPriceToman, a.usdtUnits))
    ])
  );
  const allocatedPortfolioValueToman = [...exposureTomanBySource.values()].reduce(
    (s, v) => s + v,
    0
  );
  // Session equity includes the deliberately unallocated global reserve. Venue
  // balances do not, so the reserve is counted once rather than reserving 20%
  // again from an already reserve-reduced opening book.
  const portfolioValueToman =
    session.totalCapitalToman > 0 ? session.totalCapitalToman : allocatedPortfolioValueToman;

  const policies = buildPolicyState(policyValues);

  /*
   * The inventory band, measured against the shares the SESSION opened with.
   *
   * The target is the approved opening allocation, not a house view and not an
   * average of anything — a target nobody approved is a limit nobody reviewed.
   * An unset deviation policy leaves `maxDeviationPoints` null, and sizing then
   * fails closed on the exact key rather than trading against no band at all.
   */
  const inventoryDeviationPolicy = policies.find(
    (p) => p.definition.key === "max_inventory_deviation_percent"
  );
  const inventoryModel: InventoryModel = {
    valuationPriceToman,
    targets: targetsFromAllocations(session.openingAllocations, valuationPriceToman),
    maxDeviationPoints: inventoryDeviationPolicy?.configured
      ? ((inventoryDeviationPolicy.value as number) ?? null)
      : null
  };

  const maxQuoteAgePolicy = policies.find((p) => p.definition.key === "max_quote_age_ms");
  const quoteBySource = new Map<string, QuoteCapacityInput>();
  for (const snap of input.sources) {
    if (snap.marketModel !== "OTC_QUOTE") continue;
    quoteBySource.set(snap.sourceId as string, {
      userBuyPriceToman: snap.userBuyPriceToman,
      userSellPriceToman: snap.userSellPriceToman,
      maxExecutableUsdt: snap.maxExecutableUsdt,
      ageMs: snap.ageMs,
      stale: snap.stale,
      maxQuoteAgeMs: maxQuoteAgePolicy?.configured
        ? ((maxQuoteAgePolicy.value as number) ?? null)
        : null
    });
  }

  /*
   * Portfolio limits are ALWAYS attached on the Paper execution path.
   * New-session defaults: util ≤90%, reserve ≥10%; venue concentration is a
   * dynamic cap with a 65% fail-safe ceiling. Stored experiments override
   * these values, preserving historical policy snapshots.
   * The stored route percentage is historical comparison metadata only.
   * An open experiment may override the percents; it never removes the layer.
   * Missing session capital / mark fails closed (enabled with zero equity is
   * rejected inside evaluateCycle).
   */
  const {
    PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
    PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT,
    PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT,
    PAPER_PORTFOLIO_MIN_RESERVE_PERCENT
  } = await import("@/lib/shadowArbitrage/paper/experimentPolicy");
  let portfolioLimits: {
    enabled: boolean;
    equityToman: number;
    markPriceToman: number;
    maxUtilizationPercent: number;
    minReservePercent: number;
    maxRouteCapitalPercent: number;
    maxVenueExposurePercent: number;
  } = {
    enabled: true,
    equityToman: portfolioValueToman > 0 ? portfolioValueToman : 0,
    markPriceToman: valuationPriceToman > 0 ? valuationPriceToman : 0,
    maxUtilizationPercent: PAPER_PORTFOLIO_MAX_UTILIZATION_PERCENT,
    minReservePercent: PAPER_PORTFOLIO_MIN_RESERVE_PERCENT,
    maxRouteCapitalPercent: PAPER_4D_MAX_ROUTE_CAPITAL_PERCENT,
    maxVenueExposurePercent: PAPER_PORTFOLIO_FAILSAFE_VENUE_PERCENT
  };
  let activeExperimentId: string | null = null;
  try {
    const { getActiveExperiment, experimentIsOpen } = await import(
      "@/db/repositories/shadowExperiments"
    );
    const exp = await getActiveExperiment();
    if (exp && experimentIsOpen(exp, Date.now())) {
      activeExperimentId = exp.id;
      portfolioLimits = {
        enabled: true,
        equityToman:
          session.totalCapitalToman > 0 ? session.totalCapitalToman : exp.initialCapitalToman,
        markPriceToman: valuationPriceToman > 0 ? valuationPriceToman : portfolioLimits.markPriceToman,
        maxUtilizationPercent: exp.maxUtilizationPercent,
        minReservePercent: exp.minReservePercent,
        maxRouteCapitalPercent: exp.maxRouteCapitalPercent,
        maxVenueExposurePercent: exp.maxVenueExposurePercent
      };
    }
  } catch {
    /* migration not yet applied — keep hard-coded defaults above */
  }

  const survivalTracker =
    survivalTrackersBySession.get(session.id) ?? new OpportunitySurvivalTracker();
  survivalTrackersBySession.set(session.id, survivalTracker);
  const observedAtMs = Date.parse(input.occurredAt);
  survivalTracker.observeCycle(
    input.opportunities.map((opportunity) => ({
      routeKey: opportunity.routeKey,
      active: opportunity.isActive
    })),
    Number.isFinite(observedAtMs) ? observedAtMs : Date.now()
  );
  /*
   * PAPER-V2 Phase 1A — runtime fee-horizon monitor. Does not invent fees or
   * extend validity; marks ECONOMICS_INVALID / DEGRADED_FROM_TIMESTAMP when
   * required evidence expires mid-run.
   * Economic liveness (NO-FILL / FEE-BLOCK / dropout) is assessed after commit.
   */
  let priorEconomicsValidity: Record<string, unknown> | null = null;
  let priorEconomicLiveness: Record<string, unknown> | null = null;
  try {
    const {
      assessRuntimeFeeHorizon,
      toEconomicsValidityAudit
    } = await import("@/lib/shadowArbitrage/paper/feeHorizon");
    const requiredIds = session.openingAllocations.map((a) => a.sourceId);
    const activeExp = activeExperimentId
      ? await import("@/db/repositories/shadowExperiments").then((m) =>
          m.getActiveExperiment()
        )
      : null;
    const cfg = (activeExp?.config ?? null) as Record<string, unknown> | null;
    priorEconomicsValidity =
      (cfg?.economicsValidity as Record<string, unknown> | undefined) ?? null;
    priorEconomicLiveness =
      (cfg?.economicLiveness as Record<string, unknown> | undefined) ?? null;
    const priorDegraded =
      priorEconomicsValidity &&
      typeof priorEconomicsValidity.degradedFromTimestamp === "string"
        ? (priorEconomicsValidity.degradedFromTimestamp as string)
        : null;
    const runtime = assessRuntimeFeeHorizon({
      venues: effectiveFees.venues,
      nowMs: Date.now(),
      requiredSourceIds: requiredIds,
      priorDegradedFromTimestamp: priorDegraded
    });
    if (runtime.warnings.length) {
      console.warn("[shadow-paper] fee expiry warnings", {
        sessionId: session.id,
        warnings: runtime.warnings
      });
    }
    if (activeExperimentId) {
      const { patchExperimentEconomicsValidity } = await import(
        "@/db/repositories/shadowExperiments"
      );
      await patchExperimentEconomicsValidity(
        activeExperimentId,
        toEconomicsValidityAudit(runtime, Date.now()) as unknown as Record<string, unknown>
      );
    }
  } catch (e) {
    console.warn("[shadow-paper] fee horizon monitor failed", e);
  }

  const evaluation = evaluateCycle({
    opportunities: input.opportunities,
    sources: input.sources,
    venueStates,
    executedLifecycleIds: filledIds,
    balances,
    sizing: {
      policies,
      allocationTomanBySource,
      portfolioValueToman,
      exposureTomanBySource,
      slippageBufferBps: SLIPPAGE_BUFFER_BPS,
      inventoryModel,
      /*
       * Dealer quotes for OTC venues, built from THIS cycle's snapshots.
       *
       * Without them the sizer has no ladder for a quote venue and refuses it,
       * which meant an OTC dealer could be sized in the read-only preview and
       * yet never fill in paper execution — the screen and the engine
       * disagreeing about the same venue.
       */
      quoteBySource
    },
    portfolioLimits,
    // The decision clock starts after cycle collection/DB reads and completes
    // inside evaluateCycle; source receive timestamps remain the ingest origin.
    decisionTimestampMs: Date.now(),
    paperExecutionRealism: true,
    survivalTracker,
    feeEvidenceByVenue: effectiveFees.byVenue
  });

  const fills: PaperFillRecord[] = [];
  const skips: PaperSkipRecord[] = [];

  for (const d of evaluation.decisions) {
    if (d.kind === "EXECUTE") {
      fills.push({
        lifecycleId: d.candidate.lifecycleId,
        routeKey: d.candidate.routeKey,
        buySourceId: d.candidate.buySourceId,
        sellSourceId: d.candidate.sellSourceId,
        sizeUsdt: d.candidate.sizeUsdt,
        buyVwapToman: d.plan.buyLeg.vwapToman,
        sellVwapToman: d.plan.sellLeg.vwapToman,
        buyNotionalToman: d.plan.buyLeg.notionalToman,
        sellNotionalToman: d.plan.sellLeg.notionalToman,
        buyFeeBps: d.plan.buyLeg.feeBps,
        sellFeeBps: d.plan.sellLeg.feeBps,
        buyFeeAsset: d.plan.buyLeg.settlement.feeAsset,
        buyFeeDebitMode: d.plan.buyLeg.settlement.debitMode,
        buyFeeProvenance: d.plan.buyLeg.settlement.provenance,
        sellFeeAsset: d.plan.sellLeg.settlement.feeAsset,
        sellFeeDebitMode: d.plan.sellLeg.settlement.debitMode,
        sellFeeProvenance: d.plan.sellLeg.settlement.provenance,
        feeTomanTotal: d.plan.totalFeeToman,
        feeUsdtMicrosTotal: d.plan.totalFeeUsdtMicros,
        slippageBufferToman: d.plan.slippageBufferToman,
        grossSpreadToman: d.plan.grossSpreadToman,
        markPriceToman: d.plan.markPriceToman,
        cashPnlIrtToman: d.plan.cashPnlIrtToman,
        inventoryDeltaUsdtMicros: d.plan.inventoryDeltaUsdtMicros,
        sellFeeValueToman: d.plan.sellFeeValueToman,
        economicNetPnlToman: d.plan.economicNetPnlToman,
        riskAdjustedPnlToman: d.plan.riskAdjustedPnlToman,
        balancesAfter: d.balancesAfter.map((b) => ({
          sourceId: b.sourceId,
          irtToman: b.irtToman,
          usdtMicros: b.usdtMicros
        })),
        /*
         * Why this size and not a larger one, recorded next to the fill it
         * decided. Reconstructing it later is impossible — the books have moved
         * on — so if it is not written now it is gone.
         */
        sizing:
          d.sizing.selection && d.sizing.capacity
            ? {
                policy: d.sizing.policy,
                reason: d.sizing.selection.reasonFa,
                limitingSide: d.sizing.capacity.limitingSide,
                limitingSourceId: d.sizing.capacity.limitingSourceId,
                limitingUsableUsdtMicros: d.sizing.capacity.limitingUsableMicros,
                capitalCapUsdtMicros: d.sizing.capacity.capitalCapMicros,
                depthCapUsdtMicros: d.sizing.capacity.depthCapMicros,
                bindingConstraint: d.sizing.bindingConstraint,
                riskAdjustedReturnBps: d.sizing.economics?.riskAdjustedReturnBps ?? 0,
                selectedPercentOfUsable: d.sizing.selection.selectedPercentOfUsable,
                inventoryImpactPoints: d.sizing.inventory?.impactPoints ?? null,
                nextLargerSizeUsdt:
                  d.sizing.selection.nextLarger === null
                    ? null
                    : microsToUsdt(d.sizing.selection.nextLarger.sizeUsdtMicros),
                nextLargerRejectionCode: d.sizing.selection.nextLarger?.code ?? null,
                nextLargerRejectionReason: d.sizing.selection.nextLarger?.detailFa ?? null,
                nextLargerMarginalPnlToman:
                  d.sizing.selection.nextLarger?.marginalPnlToman ?? null,
                /** Complete restart-stable audit (never alters execution if write fails). */
                audit: d.sizing.audit ?? null
              }
            : undefined
      });
      continue;
    }
    // Skips are recorded too: why a candidate did not trade is evidence.
    skips.push({
      lifecycleId: d.candidate.lifecycleId,
      routeKey: d.candidate.routeKey,
      buySourceId: d.candidate.buySourceId,
      sellSourceId: d.candidate.sellSourceId,
      sizeUsdt: d.candidate.sizeUsdt,
      rejectionCode: d.code,
      reasonCodes: d.codes,
      rejectionReason: d.reasonFa,
      requiredRebalance: describeRebalance(d.requiredRebalance),
      diagnostics: (d.diagnostics as unknown as Record<string, unknown> | null) ?? null,
      buyVwapToman: d.candidate.buyVwapToman ?? null,
      sellVwapToman: d.candidate.sellVwapToman ?? null,
      buyFeeBps: d.candidate.buyFeeBps ?? null,
      sellFeeBps: d.candidate.sellFeeBps ?? null,
      grossSpreadToman:
        Number.isFinite(d.candidate.sellVwapToman) && Number.isFinite(d.candidate.buyVwapToman)
          ? Math.round(d.candidate.sellVwapToman - d.candidate.buyVwapToman)
          : null,
      economicNetPnlToman: d.diagnostics?.economics?.economicNetPnlToman ?? null,
      riskAdjustedPnlToman: d.diagnostics?.economics?.riskAdjustedPnlToman ?? null
    });
  }

  const committed = await commitPaperCycle({
    sessionId: session.id,
    runId: input.runId,
    occurredAt: input.occurredAt,
    fills,
    skips
  });

  // Persist cycle utilization sample for average/peak on the experiment row.
  if (activeExperimentId && evaluation.peakUtilizationPercent !== null) {
    try {
      const { recordUtilizationSample } = await import("@/db/repositories/shadowExperiments");
      await recordUtilizationSample(activeExperimentId, evaluation.peakUtilizationPercent);
    } catch {
      /* non-fatal reporting */
    }
  }

  /*
   * Append-only decision trace (observability). Written AFTER evaluation and
   * commit so it cannot influence ranking, sizing or fills. Failures are
   * swallowed and must never alter the paper outcome. Gated by
   * SHADOW_DECISION_TRACE / non-production default.
   */
  try {
    const { decisionTraceEnabled, appendDecisionTrace } = await import(
      "@/db/repositories/shadowDecisionTraces"
    );
    if (decisionTraceEnabled()) {
      const { buildCandidateTraces, cycleOutcomeFromTraces } = await import(
        "@/lib/shadowArbitrage/paper/decisionTraceCapture"
      );
      const filledIds = new Set(fills.map((f) => f.lifecycleId));
      const candidates = buildCandidateTraces({
        decisions: evaluation.decisions,
        evaluation,
        filledLifecycleIds: filledIds,
        venueCount: input.sources.length
      });
      const { outcome, reasonFa } = cycleOutcomeFromTraces(candidates, committed.filled);
      const selected = candidates.find((c) => c.selected);
      const routes = new Set(candidates.map((c) => c.routeKey)).size;
      const sizes = new Set(candidates.map((c) => c.sizeUsdt)).size;
      let releaseVersion: string | null = null;
      let policyFingerprint: string | null = null;
      try {
        const appVersion = (await import("../../../../version.json")).default as {
          appVersion: string;
        };
        releaseVersion = appVersion.appVersion;
      } catch {
        /* optional */
      }
      if (activeExperimentId) {
        try {
          const { getActiveExperiment } = await import("@/db/repositories/shadowExperiments");
          const exp = await getActiveExperiment();
          policyFingerprint = exp?.policyFingerprint ?? null;
          if (exp?.releaseVersion) releaseVersion = exp.releaseVersion;
        } catch {
          /* optional */
        }
      }
      const written = await appendDecisionTrace({
        sessionId: session.id,
        runId: input.runId,
        occurredAt: input.occurredAt,
        venuesAvailable: input.sources.length,
        routesEvaluated: routes,
        sizesEvaluated: sizes,
        candidates,
        selectedLifecycleId: selected?.lifecycleId ?? null,
        filledCount: committed.filled,
        outcome,
        outcomeReasonFa: reasonFa,
        snapshotRef: input.runId,
        releaseVersion,
        policyFingerprint,
        traceComplete: true
      });
      if ("error" in written) {
        // Visible only in logs — never mutates the decision.
        console.warn("[shadow-paper] decision trace append failed", written.error);
      }
    }
  } catch {
    /* never take down paper execution */
  }

  /*
   * PAPER-V2 economic liveness — infra/data/econ split + no-fill / fee-block /
   * positive-net dropout. Terminal logs are non-authoritative; supervisor
   * payload is persisted on experiment config when an ACTIVE experiment exists.
   */
  let economicLivenessPayload: Record<string, unknown> | null = null;
  try {
    const {
      assessEconomicLiveness,
      buildCycleFunnel,
      aggregateMarketDataHealth,
      emptyPersistedState
    } = await import("@/lib/shadowArbitrage/paper/economicLiveness");
    const { toEconomicsValidityAudit, assessRuntimeFeeHorizon } = await import(
      "@/lib/shadowArbitrage/paper/feeHorizon"
    );
    const requiredIds = session.openingAllocations.map((a) => a.sourceId);
    const funnel = buildCycleFunnel({
      opportunities: input.opportunities.map((o) => ({
        buyVwapToman: o.buyVwapToman,
        sellVwapToman: o.sellVwapToman,
        netProfitToman: o.netProfitToman,
        feeUnknown: o.feeUnknown,
        isActive: o.isActive
      })),
      decisions: evaluation.decisions.map((d) =>
        d.kind === "EXECUTE"
          ? { kind: "EXECUTE" as const }
          : {
              kind: "SKIP" as const,
              code: d.code,
              codes: d.codes,
              buyVwapToman: d.candidate.buyVwapToman,
              sellVwapToman: d.candidate.sellVwapToman,
              netProfitToman: d.candidate.netProfitToman
            }
      ),
      filledCount: committed.filled
    });
    const marketDataHealth = aggregateMarketDataHealth(
      input.sources.map((s) => s.health ?? null)
    );
    const priorFeeDegraded =
      priorEconomicsValidity &&
      typeof priorEconomicsValidity.degradedFromTimestamp === "string"
        ? (priorEconomicsValidity.degradedFromTimestamp as string)
        : null;
    const priorLiv =
      priorEconomicLiveness &&
      priorEconomicLiveness.version === "economic_liveness_v1"
        ? (priorEconomicLiveness as unknown as import("@/lib/shadowArbitrage/paper/economicLiveness").EconomicLivenessPersistedState)
        : emptyPersistedState();
    // Prefer persisted lastFillAt; fall back to session paper stats when absent.
    let lastFillAt = priorLiv.lastFillAt;
    if (!lastFillAt) {
      try {
        const { loadPaperStats } = await import("@/db/repositories/shadowPaper");
        const stats = await loadPaperStats(session.id);
        lastFillAt = stats.lastFillAt;
      } catch {
        /* optional */
      }
    }
    const assessment = assessEconomicLiveness({
      nowMs: Date.now(),
      infraHealth: "healthy", // collector reached this path; Docker infra is separate
      marketDataHealth,
      candidateEvaluationContinuing: true,
      lastFillAt,
      filledThisCycle: committed.filled,
      funnel,
      venues: effectiveFees.venues,
      requiredSourceIds: requiredIds,
      prior: priorLiv,
      priorFeeDegradedFromTimestamp: priorFeeDegraded
    });
    economicLivenessPayload = assessment.supervisorPayload as unknown as Record<
      string,
      unknown
    >;
    if (assessment.alerts.length) {
      console.warn("[shadow-paper] economic liveness alerts", {
        sessionId: session.id,
        economicLiveness: assessment.health.economicLiveness,
        validityState: assessment.validityState,
        firstDegradedAt: assessment.firstDegradedAt,
        alerts: assessment.alerts.map((a) => ({ code: a.code, severity: a.severity }))
      });
    }
    if (activeExperimentId) {
      const { patchExperimentEconomicLiveness } = await import(
        "@/db/repositories/shadowExperiments"
      );
      const feeRuntime = assessRuntimeFeeHorizon({
        venues: effectiveFees.venues,
        nowMs: Date.now(),
        requiredSourceIds: requiredIds,
        priorDegradedFromTimestamp: priorFeeDegraded
      });
      await patchExperimentEconomicLiveness(activeExperimentId, {
        economicLiveness: assessment.nextPersisted as unknown as Record<string, unknown>,
        supervisorPayload: assessment.supervisorPayload as unknown as Record<
          string,
          unknown
        >,
        economicsValidity: toEconomicsValidityAudit(
          feeRuntime,
          Date.now()
        ) as unknown as Record<string, unknown>
      });
    }
  } catch (e) {
    console.warn("[shadow-paper] economic liveness monitor failed", e);
  }

  return {
    ran: true,
    sessionId: session.id,
    filled: committed.filled,
    skipped: committed.skipped,
    duplicates: committed.duplicates,
    detailedEventsWritten: committed.detailedEventsWritten,
    eligibleCandidates: evaluation.eligibleCandidates,
    portfolio: evaluation.portfolio,
    marketData: evaluation.marketData,
    economicLiveness: economicLivenessPayload
  };
}

/**
 * Isolated wrapper used by the collector.
 *
 * Never throws and never rejects. A paper-execution problem is reported and
 * swallowed so the collection cycle, the heartbeat and the 14-day observation
 * continue exactly as they would without Phase 6.
 */
export async function runPaperExecutionIsolated(
  input: Parameters<typeof runPaperExecutionForCycle>[0],
  log: (message: string, extra?: unknown) => void = () => undefined
): Promise<PaperCycleOutcome> {
  try {
    return await runPaperExecutionForCycle(input);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    log("[shadow-paper] cycle failed — collector unaffected", error);
    return { ran: false, reason: "error", error };
  }
}
