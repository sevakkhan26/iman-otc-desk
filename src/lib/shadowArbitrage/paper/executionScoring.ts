import type { SurvivalEstimate } from "@/lib/shadowArbitrage/paper/opportunitySurvival";

export type ExecutionScoringPolicy = {
  freshnessBudgetMs: number;
  latencyBudgetMs: number;
  jitterBudgetMs: number;
  defaultFillConfidence: number;
  defaultPartialFillRisk: number;
  provenance: string;
};

export const DEFAULT_EXECUTION_SCORING_POLICY: ExecutionScoringPolicy = {
  freshnessBudgetMs: 90_000,
  latencyBudgetMs: 2_000,
  jitterBudgetMs: 1_000,
  defaultFillConfidence: 0.75,
  defaultPartialFillRisk: 0.25,
  provenance: "PAPER_POLICY_V1:configurable conservative execution priors"
};

export type InventoryShadowPrice = {
  sourceId: string;
  asset: "IRT" | "USDT_MICRO";
  priceTomanPerUnit: number;
  scarcityFactor: number;
  confidence: number;
  futureSamples: number;
  provenance: string;
};

export type FutureInventoryDemand = {
  sourceId: string;
  asset: "IRT" | "USDT_MICRO";
  requiredUnits: number;
  canonicalRiskAdjustedPnlToman: number;
  captureConfidence: number;
};

/**
 * Shadow prices come only from supplied Paper/replay demand evidence. With no
 * future samples the price is zero and confidence is explicit—not invented.
 */
export function deriveInventoryShadowPrices(input: {
  availableUnits: Map<string, number>;
  futureDemand: FutureInventoryDemand[];
}): InventoryShadowPrice[] {
  const grouped = new Map<string, FutureInventoryDemand[]>();
  for (const row of input.futureDemand) {
    if (!(row.requiredUnits > 0) || !(row.canonicalRiskAdjustedPnlToman > 0)) {
      continue;
    }
    const key = `${row.sourceId}|${row.asset}`;
    const list = grouped.get(key);
    if (list) list.push(row);
    else grouped.set(key, [row]);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const [sourceId, asset] = key.split("|") as [
        string,
        "IRT" | "USDT_MICRO"
      ];
      const required = rows.reduce((sum, row) => sum + row.requiredUnits, 0);
      const available = Math.max(0, input.availableUnits.get(key) ?? 0);
      const scarcityFactor =
        required > 0 ? Math.max(0, Math.min(1, 1 - available / required)) : 0;
      const expectedRa = rows.reduce(
        (sum, row) =>
          sum +
          row.canonicalRiskAdjustedPnlToman *
            Math.max(0, Math.min(1, row.captureConfidence)),
        0
      );
      const confidence =
        rows.length > 0
          ? rows.reduce(
              (sum, row) =>
                sum + Math.max(0, Math.min(1, row.captureConfidence)),
              0
            ) / rows.length
          : 0;
      return {
        sourceId,
        asset,
        priceTomanPerUnit:
          required > 0 ? (expectedRa / required) * scarcityFactor : 0,
        scarcityFactor,
        confidence,
        futureSamples: rows.length,
        provenance: "REPLAY_FUTURE_MARGINAL_RA_PER_REQUIRED_UNIT"
      };
    });
}

export type CandidateScoreBreakdown = {
  canonicalRiskAdjustedPnlToman: number;
  expectedCapturePnlToman: number;
  captureAdjustmentToman: number;
  executionAdjustmentToman: number;
  inventoryOpportunityCostToman: number;
  adjustedObjectiveToman: number;
  captureFactor: number;
  captureConfidence: number;
  fillConfidence: number;
  partialFillRisk: number;
  freshnessFactor: number;
  latencyFactor: number;
  jitterFactor: number;
  executionConfidence: number;
  inventoryShadowPrices: InventoryShadowPrice[];
  inventoryRepairing: boolean;
  policy: ExecutionScoringPolicy;
  provenance: {
    capture: string;
    fill: string;
    partialFill: string;
    inventory: string;
  };
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function budgetFactor(observed: number, budget: number): number {
  if (!(budget > 0)) return 0;
  return clamp01(1 - Math.max(0, observed) / budget);
}

/**
 * Canonical fees/slippage are untouched. Adjustments are capture probability,
 * execution quality and opportunity cost, each separately auditable.
 */
export function scorePaperCandidate(input: {
  canonicalRiskAdjustedPnlToman: number;
  survival: SurvivalEstimate;
  fillConfidence?: number;
  fillConfidenceProvenance?: string;
  partialFillRisk?: number;
  partialFillRiskProvenance?: string;
  sourceAgeMs: number;
  venueLatencyMs: number;
  venueJitterMs: number;
  buyIrtRequiredToman: number;
  sellUsdtMicros: number;
  buySourceId: string;
  sellSourceId: string;
  inventoryImpactPoints: number;
  shadowPrices?: InventoryShadowPrice[];
  policy?: ExecutionScoringPolicy;
}): CandidateScoreBreakdown {
  const policy = input.policy ?? DEFAULT_EXECUTION_SCORING_POLICY;
  const raw = input.canonicalRiskAdjustedPnlToman;
  const captureFactor = clamp01(input.survival.captureFactor);
  const fillConfidence = clamp01(
    input.fillConfidence ?? policy.defaultFillConfidence
  );
  const partialFillRisk = clamp01(
    input.partialFillRisk ?? policy.defaultPartialFillRisk
  );
  const freshnessFactor = budgetFactor(
    input.sourceAgeMs,
    policy.freshnessBudgetMs
  );
  const latencyFactor = budgetFactor(
    input.venueLatencyMs,
    policy.latencyBudgetMs
  );
  const jitterFactor = budgetFactor(
    input.venueJitterMs,
    policy.jitterBudgetMs
  );
  const executionConfidence =
    fillConfidence *
    (1 - partialFillRisk) *
    freshnessFactor *
    latencyFactor *
    jitterFactor;
  const expectedCapturePnlToman = raw * captureFactor;
  const captureAdjustmentToman = expectedCapturePnlToman - raw;
  const executionAdjustmentToman =
    expectedCapturePnlToman * (executionConfidence - 1);

  const inventoryRepairing = input.inventoryImpactPoints < 0;
  const prices = input.shadowPrices ?? [];
  const buyPrice = prices.find(
    (row) => row.sourceId === input.buySourceId && row.asset === "IRT"
  );
  const sellPrice = prices.find(
    (row) => row.sourceId === input.sellSourceId && row.asset === "USDT_MICRO"
  );
  // Repairing routes receive no bonus; they simply avoid a depletion charge.
  const inventoryOpportunityCostToman = inventoryRepairing
    ? 0
    : Math.max(
        0,
        input.buyIrtRequiredToman * (buyPrice?.priceTomanPerUnit ?? 0) +
          input.sellUsdtMicros * (sellPrice?.priceTomanPerUnit ?? 0)
      );
  const adjustedObjectiveToman =
    raw +
    captureAdjustmentToman +
    executionAdjustmentToman -
    inventoryOpportunityCostToman;

  return {
    canonicalRiskAdjustedPnlToman: raw,
    expectedCapturePnlToman,
    captureAdjustmentToman,
    executionAdjustmentToman,
    inventoryOpportunityCostToman,
    adjustedObjectiveToman,
    captureFactor,
    captureConfidence: input.survival.confidence,
    fillConfidence,
    partialFillRisk,
    freshnessFactor,
    latencyFactor,
    jitterFactor,
    executionConfidence,
    inventoryShadowPrices: prices,
    inventoryRepairing,
    policy,
    provenance: {
      capture: input.survival.provenance,
      fill:
        input.fillConfidenceProvenance ??
        `${policy.provenance}:defaultFillConfidence`,
      partialFill:
        input.partialFillRiskProvenance ??
        `${policy.provenance}:defaultPartialFillRisk`,
      inventory: prices.length
        ? "REPLAY_FUTURE_MARGINAL_RA_PER_REQUIRED_UNIT"
        : "NO_FUTURE_DEMAND_EVIDENCE_ZERO_PRICE"
    }
  };
}

/** Attach venue/asset opportunity costs after the option set is known. */
export function applyInventoryShadowPrices(input: {
  score: CandidateScoreBreakdown;
  shadowPrices: InventoryShadowPrice[];
  buySourceId: string;
  sellSourceId: string;
  buyIrtRequiredToman: number;
  sellUsdtMicros: number;
  inventoryImpactPoints: number;
}): CandidateScoreBreakdown {
  const inventoryRepairing = input.inventoryImpactPoints < 0;
  const buyPrice = input.shadowPrices.find(
    (row) => row.sourceId === input.buySourceId && row.asset === "IRT"
  );
  const sellPrice = input.shadowPrices.find(
    (row) =>
      row.sourceId === input.sellSourceId && row.asset === "USDT_MICRO"
  );
  const inventoryOpportunityCostToman = inventoryRepairing
    ? 0
    : Math.max(
        0,
        input.buyIrtRequiredToman * (buyPrice?.priceTomanPerUnit ?? 0) +
          input.sellUsdtMicros * (sellPrice?.priceTomanPerUnit ?? 0)
      );
  return {
    ...input.score,
    inventoryOpportunityCostToman,
    adjustedObjectiveToman:
      input.score.adjustedObjectiveToman +
      input.score.inventoryOpportunityCostToman -
      inventoryOpportunityCostToman,
    inventoryShadowPrices: input.shadowPrices,
    inventoryRepairing,
    provenance: {
      ...input.score.provenance,
      inventory: input.shadowPrices.length
        ? "CURRENT_OPTION_SET_MARGINAL_RA_PER_REQUIRED_UNIT"
        : "NO_FUTURE_DEMAND_EVIDENCE_ZERO_PRICE"
    }
  };
}
