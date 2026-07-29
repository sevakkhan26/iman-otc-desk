/** Client-side shapes for the admin-only Shadow Arbitrage API payloads. */
import type {
  NormalizedSourceSnapshot,
  ShadowAnalytics,
  ShadowMatrixResponse,
  ShadowOpportunity
} from "@/lib/shadowArbitrage/types";

export type Certification = {
  sourceId: string;
  sourceName: string;
  status: string;
  statusReason: string | null;
  endpoint: string;
  marketSymbol: string;
  marketModel: string;
  priceUnit: string;
  quantityUnit: string;
  observedPriceUnit: string | null;
  directionNote: string;
  depthNote: string;
  timestampNote: string;
  rateLimitNote: string;
  limitations: string;
  lastProbeAt: string | null;
  lastHttpStatus: number | null;
  lastLatencyMs: number | null;
  lastAttempts: number | null;
  lastRateLimited: boolean;
  lastError: string | null;
  depthAvailable: boolean | null;
  directionVerified: boolean | null;
  maxExecutableUsdt: number | null;
  exchangeTimestamp: string | null;
  verifiedAt: string | null;
  feeStatus: string;
  feeValueBps: number | null;
  feeReferenceUrl: string | null;
  feeVerifiedAt: string | null;
  feeExplanation: string;
};

export type SourceHealthRow = {
  sourceId: string;
  sourceName: string;
  samples: number;
  uptimePercent: number;
  errorRatePercent: number;
  freshnessPercent: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  rateLimitNote: string;
};

export type Observation = {
  id: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  pausedAt: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  completedCycles: number;
  successfulCycles: number;
  failedCycles: number;
  partialCycles: number;
  pollIntervalMs: number;
  targetDurationMs: number;
  elapsedMs: number;
  remainingMs: number;
  progressPercent: number;
  cycleCoveragePercent: number;
  expectedCycles: number;
  workerId: string | null;
};

export type WorkerState = {
  workerId: string | null;
  status: string;
  lastHeartbeatAt: string | null;
  lastCycleAt: string | null;
  lastCycleStatus: string | null;
  pollIntervalMs: number;
  leaseExpiresAt: string | null;
  stale: boolean;
  leaseHeld: boolean;
  nextExpectedCycleAt: string | null;
};

export type CostRecord = {
  key: string;
  label: string;
  value: number;
  unit: string;
  status: string;
  reference: string | null;
  verifiedAt: string | null;
  explanation: string;
};

export type RunStats = {
  runCount: number;
  successfulRuns: number;
  partialRuns: number;
  failedRuns: number;
  duplicateIdempotencyKeys: number;
};

export type ObservationPayload = {
  serverNow: string;
  observation: Observation | null;
  worker: WorkerState;
  runStats: RunStats;
  certifications: Certification[];
  sourceHealth: SourceHealthRow[];
  costRecords: CostRecord[];
  workerCommand: string;
};

export type ShadowData = {
  matrix: ShadowMatrixResponse | null;
  history: ShadowOpportunity[];
  analytics: ShadowAnalytics | null;
  observation: ObservationPayload | null;
};

export type { NormalizedSourceSnapshot, ShadowOpportunity, ShadowAnalytics, ShadowMatrixResponse };
