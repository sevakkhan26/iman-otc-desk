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
import { loadLatestFeeConfirmations } from "@/db/repositories/shadowArbitrage";
import {
  commitPaperCycle,
  getActivePaperSession,
  loadFilledLifecycleIds,
  loadPaperBalances,
  type PaperFillRecord,
  type PaperSessionRow,
  type PaperSkipRecord
} from "@/db/repositories/shadowPaper";
import { buildAllReadiness } from "@/lib/shadowArbitrage/accounts";
import { classifyAllVenues } from "@/lib/shadowArbitrage/capital";
import { describeRebalance, evaluateCycle } from "@/lib/shadowArbitrage/paper/engine";
import type { VenueBalance } from "@/lib/shadowArbitrage/paper/broker";
import type { NormalizedSourceSnapshot, ShadowOpportunity, ShadowSourceId } from "@/lib/shadowArbitrage/types";

export type PaperCycleOutcome = {
  ran: boolean;
  reason?: "no_session" | "not_running" | "cycle_not_successful" | "error";
  sessionId?: string;
  filled?: number;
  skipped?: number;
  duplicates?: number;
  eligibleCandidates?: number;
  /** Detailed rows this cycle wrote — normally 0 once the market is steady. */
  detailedEventsWritten?: number;
  error?: string;
};

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

  const [latestFees, balanceRows, filledIds] = await Promise.all([
    loadLatestFeeConfirmations(),
    loadPaperBalances(session.id),
    loadFilledLifecycleIds(session.id)
  ]);

  const venueStates = classifyAllVenues(buildAllReadiness(Object.values(latestFees)));
  const balances: VenueBalance[] = balanceRows.map((b) => ({
    sourceId: b.sourceId as ShadowSourceId,
    irtToman: b.irtToman,
    usdtMicros: b.usdtMicros
  }));

  const evaluation = evaluateCycle({
    opportunities: input.opportunities,
    sources: input.sources,
    venueStates,
    executedLifecycleIds: filledIds,
    balances
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
        }))
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
      requiredRebalance: describeRebalance(d.requiredRebalance)
    });
  }

  const committed = await commitPaperCycle({
    sessionId: session.id,
    runId: input.runId,
    occurredAt: input.occurredAt,
    fills,
    skips
  });

  return {
    ran: true,
    sessionId: session.id,
    filled: committed.filled,
    skipped: committed.skipped,
    duplicates: committed.duplicates,
    detailedEventsWritten: committed.detailedEventsWritten,
    eligibleCandidates: evaluation.eligibleCandidates
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
