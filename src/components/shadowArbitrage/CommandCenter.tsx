"use client";

import { useEffect, useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import {
  COLLECTOR_STATE_FA,
  classifyOpportunity,
  collectorTone,
  deriveCollectorState,
  formatCountFa,
  formatDurationFa,
  formatPercentFa,
  toFaDigits,
  NO_VALID_OPPORTUNITY_FA,
  TOOLTIP_FA
} from "@/components/shadowArbitrage/labels";
import { evidenceFor, type PaperEvidence } from "@/components/shadowArbitrage/opportunityModel";
import {
  CAP_LABEL_FA,
  VENUE_CAPACITY_REASON_FA
} from "@/lib/shadowArbitrage/paper/liquidity";
import {
  summarisePortfolio,
  type VenueAllocation
} from "@/lib/shadowArbitrage/paper/portfolio";
import type {
  Observation,
  ShadowOpportunity,
  WorkerState
} from "@/components/shadowArbitrage/types";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import type { ShadowTabId } from "@/components/shadowArbitrage/tabs";

/* ── the slice of the paper payload this section reads ────────────────────── */

export type CommandSession = {
  id: string;
  name: string;
  status: string;
  mode: string;
  totalCapitalToman: number;
  valuationPriceToman: number;
  openingAllocations: VenueAllocation[];
};

export type CommandBalance = { sourceId: string; irtToman: number; usdt: number };

/** Micros → a fixed four-decimal USDT string. The ledger's own precision. */
function usdtFa(micros: number): string {
  return (micros / 1_000_000).toFixed(4);
}

/*
 * The two hard percentages, spelled out for the labels. They mirror
 * `CAPITAL_CAP_PERCENT` and `DEPTH_CAP_PERCENT` in the sizing policy; the
 * server also sends them in `policyParameters`, and a test pins the two
 * together so a change on one side cannot drift from the other.
 */
export const CAPITAL_CAP_PERCENT_FA = 10;
export const DEPTH_CAP_PERCENT_FA = 10;

/** One leg's child-fill ladder, as the API returns it. */
export type BookWalkView = {
  complete: boolean;
  filledMicros: number;
  unfilledMicros: number;
  notionalToman: number;
  vwapToman: number | null;
  bestPriceToman: number | null;
  worstPriceToman: number | null;
  fills: Array<{ index: number; priceToman: number; quantityMicros: number; notionalToman: number }>;
  bookParticipationPercent: number;
  priceImpactPercent: number;
};

/** The calculated size for one route, as the API returns it. */
export type RouteSizingView = {
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizing: {
    status: "SIZED" | "BLOCKED";
    policy: string;
    sizeUsdt: number | null;
    bindingConstraint: string | null;
    constraints: Array<{
      key: string;
      labelFa: string;
      capUsdtMicros: number | null;
      detailFa: string;
    }>;
    capacity: {
      buyUsableMicros: number;
      sellUsableMicros: number;
      limitingUsableMicros: number;
      limitingSide: "buy" | "sell";
      limitingSourceId: string;
      capitalCapMicros: number;
      depthCapMicros: number;
      depthCapSide: "buy" | "sell";
      ceilingMicros: number;
      buyDepth: SlippageDepthView;
      sellDepth: SlippageDepthView;
      ladder: Array<{
        percent: number;
        rawMicros: number;
        quantizedMicros: number;
        kept: boolean;
      }>;
    } | null;
    liquidityMaxUsdtMicros: number | null;
    policyMaxUsdtMicros: number | null;
    maxFeasibleUsdtMicros: number | null;
    candidates: Array<{
      sizeUsdtMicros: number;
      percentOfUsable: number | null;
      buyVwapToman: number;
      sellVwapToman: number;
      riskAdjustedPnlToman: number;
      riskAdjustedEdgePercent: number;
      riskAdjustedReturnBps: number;
      inventoryImpactPoints: number;
      buyLevels: number;
      sellLevels: number;
      bookParticipationPercent: number;
      priceImpactPercent: number;
      eligible: boolean;
      rejectionCode: string | null;
      rejectionFa: string | null;
    }>;
    selection: {
      policy: string;
      selectedSizeUsdtMicros: number;
      selectedPercentOfUsable: number | null;
      reasonFa: string;
      tieBreakFa: string | null;
      nextLarger: {
        sizeUsdtMicros: number;
        code: string;
        detailFa: string;
        marginalPnlToman: number | null;
      } | null;
    } | null;
    inventory: {
      measurable: boolean;
      reasonFa: string;
      impactPoints: number;
      withinBand: boolean;
      breachedSourceId: string | null;
      breachDetailFa: string | null;
      before: InventoryRowView[];
      after: InventoryRowView[];
    } | null;
    baseline: {
      policy: string;
      executable: boolean;
      noteFa: string;
      bestRiskAdjustedPnlToman: number | null;
      bestSizeUsdt: number | null;
      rows: Array<{
        sizeUsdt: number;
        fillable: boolean;
        buyVwapToman: number | null;
        sellVwapToman: number | null;
        riskAdjustedPnlToman: number | null;
        riskAdjustedReturnBps: number | null;
        reasonFa: string;
      }>;
    } | null;
    quote: {
      buyVwapToman: number;
      sellVwapToman: number;
      buySlippageBps: number;
      sellSlippageBps: number;
      buyWalk: BookWalkView;
      sellWalk: BookWalkView;
    } | null;
    economics: {
      capitalInvolvedToman: number;
      cashPnlIrtToman: number;
      inventoryDeltaUsdtMicros: number;
      sellFeeValueToman: number;
      economicNetPnlToman: number;
      slippageBufferToman: number;
      riskAdjustedPnlToman: number;
      riskAdjustedEdgePercent: number;
      riskAdjustedReturnBps: number;
    } | null;
    blockers: Array<{ code: string; subject: string; detailFa: string }>;
  };
};

/** One leg's depth after the admin's slippage ceiling has been applied. */
export type SlippageDepthView = {
  depthMicros: number;
  totalDepthMicros: number;
  levelsIncluded: number;
  levelsExcluded: number;
  bestPriceToman: number | null;
  worstAllowedPriceToman: number | null;
  maxSlippageBps: number;
};

export type InventoryRowView = {
  sourceId: string;
  usdtSharePercent: number;
  targetUsdtSharePercent: number;
  deviationPoints: number;
  withinBand: boolean;
};

export type CapView = {
  key: string;
  labelFa: string;
  capUsdtMicros: number | null;
  detailFa: string;
};

export type VenueCapacityView = {
  sourceId: string;
  nameFa: string;
  marketModel: string;
  buy: {
    capacityUsdtMicros: number | null;
    reason: string;
    reasonFa: string;
    limitingCap: string | null;
    caps: CapView[];
  };
  sell: {
    capacityUsdtMicros: number | null;
    reason: string;
    reasonFa: string;
    limitingCap: string | null;
    caps: CapView[];
  };
};

export const SCENARIO_CAP_KEYS = [
  "max_order_size_usdt",
  "max_venue_exposure_percent",
  "min_risk_adjusted_edge_percent"
] as const;

export const SCENARIO_CAP_FA: Record<string, string> = {
  max_order_size_usdt: "حداکثر حجم هر سفارش (تتر)",
  max_venue_exposure_percent: "سقف تمرکز روی یک صرافی (٪)",
  min_risk_adjusted_edge_percent: "حداقل حاشیهٔ تعدیل‌شده (٪)"
};

export type ProposalView = {
  id: string;
  status?: string;
  /** The unapproved caps that shaped a PREVIEW, so controls survive a reload. */
  scenarioCaps?: Record<string, number> | null;
  createdAt?: string;
  note?: string | null;
  fingerprints?: { books: string; fees: string; accounts: string; policy: string };
  totalCapitalToman: number;
  allocatedToman: number;
  residualToman: number;
  appliedPolicyCaps: Record<string, number>;
  unsetPolicyCaps: string[];
  rows: Array<{
    sourceId: string;
    role: string;
    irtToman: number;
    usdtUnits: number;
    valueToman: number;
    sharePercent: number;
    buyCapacityUsdtMicros: number | null;
    sellCapacityUsdtMicros: number | null;
    /** Which cap bound each side. Null when capacity is unavailable. */
    buyLimiter: string | null;
    sellLimiter: string | null;
    buyReason: string;
    sellReason: string;
    reasonFa: string;
  }>;
};

export type VenueMatrixRow = {
  sourceId: string;
  nameFa: string;
  dataType: string;
  kycComplete: boolean;
  accountEligible: boolean;
  feeConfirmed: boolean;
  buyCapacityUsdtMicros: number | null;
  sellCapacityUsdtMicros: number | null;
  buyLimiter: string | null;
  sellLimiter: string | null;
  buyReason: string;
  sellReason: string;
  buyLegUsable: boolean;
  sellLegUsable: boolean;
  participates: boolean;
  allocationRole: string | null;
  blockerFa: string | null;
};

export type VenueSemanticsView = {
  total: number;
  kycConfirmed: number;
  accountEligible: number;
  buyCapacityMeasurable: number;
  sellCapacityMeasurable: number;
  buyLegUsable: number;
  sellLegUsable: number;
  participating: number;
  quoteOnly: Array<{ sourceId: string; buyReason: string; sellReason: string }>;
  unverified: Array<{ sourceId: string; reason: string; reasonFa: string }>;
  matrix: VenueMatrixRow[];
};

export type SizingView = {
  /** `SMART_CAPITAL_DEPTH`. Named by the server, never inferred here. */
  policy?: string;
  policyParameters?: {
    candidatePercents: number[];
    capitalCapPercent: number;
    depthCapPercent: number;
    minExecutableUsdt: number;
  };
  requiredPolicies: string[];
  venueSemantics?: VenueSemanticsView;
  missingPolicies: string[];
  venueCapacities?: VenueCapacityView[];
  /** The fixed ladder, kept as a comparison baseline. Never executable. */
  baselineSizesUsdt?: number[];
  baselineExecutable?: boolean;
  routes: RouteSizingView[];
};

export type CommandPortfolio = {
  session: CommandSession | null;
  balances: CommandBalance[];
  fills: Array<{
    economicNetPnlToman: number | null;
    riskAdjustedPnlToman: number | null;
    occurredAt: string;
  }>;
  rejected: number;
  markPriceToman: number | null;
};

type Props = {
  loading: boolean;
  error: string | null;
  stale: boolean;
  observation: Observation | null;
  worker: WorkerState | null;
  opportunities: ShadowOpportunity[];
  paperEvidence: Map<string, PaperEvidence>;
  sources: NormalizedSourceSnapshot[];
  portfolio: CommandPortfolio | null;
  /** Calculated sizes per route. Null until the first read lands. */
  sizing: SizingView | null;
  accounts: { executable: number; total: number } | null;
  readiness: { passed: number; total: number; topBlockerFa: string | null } | null;
  serverNow: string | null;
  onRefresh: () => void;
  onOpenSection: (id: ShadowTabId) => void;
  /** Append-only allocation proposal, when one has been generated. */
  proposal: ProposalView | null;
  proposalDecision: { decision: string; detailFa: string; decidedBy: string; decidedAt: string } | null;
  proposalBusy: boolean;
  /** null = UNSET (not applied); an explicit 0 is a real cap of zero. */
  scenarioCaps: Record<string, number | null>;
  onScenarioCapChange: (key: string, value: number | null) => void;
  applyArmed: boolean;
  onArmApply: (armed: boolean) => void;
  onProposeAllocation: () => void;
  onApplyAllocation: () => void;
  /** Session create / start / pause / stop, supplied by the page. */
  sessionControls?: React.ReactNode;
  /** Everything technical, folded away behind one disclosure. */
  advanced?: React.ReactNode;
};

/**
 * A "part of whole" figure inside its own bidi isolate.
 *
 * Without it an RTL paragraph reorders "۳ / ۹" into "۹ / ۳", which silently
 * reverses the meaning of every ratio on the page.
 */
function Ratio({ part, whole }: { part: number; whole: number }) {
  return (
    <span className="sa-ratio" dir="ltr">
      {toFaDigits(part)}
      <span className="sa-ratio-sep">/</span>
      <span className="sa-ratio-whole">{toFaDigits(whole)}</span>
    </span>
  );
}

/** One headline number. A value that is not known yet is an em dash, never a zero. */
function Kpi({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: React.ReactNode;
  hint: React.ReactNode;
  tone: "good" | "warn" | "danger" | "muted";
}) {
  // .panel is the shared Liquid Glass card material used across the desk.
  return (
    <section className={`panel sa-panel sa-cc-kpi sa-rail-${tone}`}>
      <div className="panel-body sa-cc-kpi-body">
        <div className="sa-cc-kpi-label">{label}</div>
        <div className="sa-cc-kpi-value">{value}</div>
        <div className="sa-cc-kpi-hint">{hint}</div>
      </div>
    </section>
  );
}

const DASH = <span className="sa-unknown">—</span>;

function tone(value: number): "good" | "warn" | "muted" {
  return value > 0 ? "good" : value < 0 ? "warn" : "muted";
}

/**
 * Phase 8C-2 — the Command Center.
 *
 * One screen that answers the operator's standing questions without opening a
 * drawer: how much virtual money exists, how much of it is deployed, how much
 * is free, what today and the session as a whole earned, how bad the worst
 * give-back was, how many trades were taken and refused, and which route is the
 * best one right now with its size, the capital it would tie up and its net
 * result after fees and the slippage buffer.
 *
 * Every figure comes from data the server already returned. Nothing is invented
 * to fill a card: an unknown value shows an em dash and says why. Phase 8C-4
 * sizes from the observed order book, so the size shown is the quantity that
 * maximises risk-adjusted profit — reported next to the largest quantity the
 * books could absorb, because those two are rarely the same number.
 */
export function CommandCenter({
  loading,
  error,
  stale,
  observation,
  worker,
  opportunities,
  paperEvidence,
  sources,
  portfolio,
  sizing,
  accounts,
  readiness,
  serverNow,
  onRefresh,
  onOpenSection,
  proposal,
  proposalDecision,
  proposalBusy,
  scenarioCaps,
  onScenarioCapChange,
  applyArmed,
  onArmApply,
  onProposeAllocation,
  onApplyAllocation,
  sessionControls,
  advanced
}: Props) {
  // Ages are computed on the client, so they must not run during SSR.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const pollIntervalMs = worker?.pollIntervalMs ?? observation?.pollIntervalMs ?? 30_000;
  const lastSuccessAgeMs =
    nowMs && observation?.lastSuccessAt ? nowMs - Date.parse(observation.lastSuccessAt) : null;

  const collectorState = deriveCollectorState({
    observationStatus: observation?.status,
    workerStale: worker?.stale,
    workerRunning: worker?.leaseHeld,
    lastSuccessAgeMs,
    pollIntervalMs
  });

  const session = portfolio?.session ?? null;
  const markPrice = portfolio?.markPriceToman ?? session?.valuationPriceToman ?? null;

  /* ── portfolio ─────────────────────────────────────────────────────────── */

  const summary = useMemo(() => {
    if (!session || !portfolio) return null;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return summarisePortfolio({
      initialCapitalToman: session.totalCapitalToman,
      balances: portfolio.balances.map((b) => ({
        sourceId: b.sourceId as never,
        irtToman: b.irtToman,
        usdtMicros: Math.round(b.usdt * 1_000_000)
      })),
      markPriceToman: markPrice,
      fills: portfolio.fills,
      rejectedCount: portfolio.rejected,
      todayStartMs: todayStart.getTime()
    });
  }, [session, portfolio, markPrice]);

  /*
   * Free cash is the toman actually available to fund a buy, not "total minus
   * allocated" — allocation is exact by construction, so that figure would
   * always be zero and would tell an operator nothing. Deployed is the same
   * balances valued at today's mark, which is why it moves with the market.
   */
  const freeTomanCash = useMemo(
    () => (portfolio?.balances ?? []).reduce((s, b) => s + b.irtToman, 0),
    [portfolio]
  );
  const usdtInventory = useMemo(
    () => (portfolio?.balances ?? []).reduce((s, b) => s + b.usdt, 0),
    [portfolio]
  );

  /* ── best opportunity ──────────────────────────────────────────────────── */

  const classified = useMemo(
    () =>
      opportunities.map((o) => ({
        opportunity: o,
        kind: classifyOpportunity({
          eligibility: o.eligibility,
          feeUnknown: o.feeUnknown,
          netProfitToman: o.netProfitToman,
          rawSpreadPercent: o.rawSpreadPercent
        })
      })),
    [opportunities]
  );

  const valid = useMemo(
    () =>
      classified
        .filter((c) => c.kind === "valid" && c.opportunity.isActive)
        .map((c) => c.opportunity)
        .sort((a, b) => b.netProfitToman - a.netProfitToman),
    [classified]
  );

  const best = valid[0] ?? null;
  const bestEvidence = best ? (evidenceFor(best, paperEvidence) ?? null) : null;

  /*
   * The calculated size for the best route. The fixed 5/10/20/25 ladder is a
   * diagnostic probe of the order book, so it is never shown as the
   * recommendation — this is, together with the one constraint that decided it.
   */
  const bestSizing = useMemo(() => {
    if (!sizing) return null;
    if (best) {
      const match = sizing.routes.find(
        (r) => r.routeKey === `${best.buySourceId}->${best.sellSourceId}`
      );
      if (match) return match;
    }
    /*
     * No profitable route right now. The capacity study is still the thing an
     * operator needs to see — whether these venues could carry the intended
     * scale at all — so fall back to the route with the deepest analysed
     * liquidity rather than showing nothing. It is labelled as a capacity
     * study, never as a trade.
     */
    const analysed = sizing.routes.filter((r) => r.sizing.candidates.length > 0);
    if (!analysed.length) return null;
    return [...analysed].sort(
      (a, b) =>
        (b.sizing.liquidityMaxUsdtMicros ?? 0) - (a.sizing.liquidityMaxUsdtMicros ?? 0) ||
        a.routeKey.localeCompare(b.routeKey)
    )[0];
  }, [best, sizing]);

  /** True when the panel is showing capacity rather than a tradeable route. */
  const capacityOnly = !best && Boolean(bestSizing);

  const sizedCount = sizing?.routes.filter((r) => r.sizing.status === "SIZED").length ?? 0;
  const sem = sizing?.venueSemantics ?? null;

  const healthySources = sources.filter((s) => s.health === "healthy").length;
  const progress = observation?.progressPercent ?? null;
  const coverage = observation?.successCoveragePercent ?? null;

  return (
    <div className="sa-cc">
      {/* ── status strip ─────────────────────────────────────────────── */}
      <section className="panel sa-panel sa-cc-status" aria-label="وضعیت لحظه‌ای">
        <div className="sa-cc-status-row">
          <div className="sa-cc-status-group">
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">حالت</span>
              <span className="sa-chip sa-chip-sm sa-chip-warn" title={TOOLTIP_FA.coverage}>
                فقط پایش آزمایشی
              </span>
            </div>
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">جمع‌آورنده</span>
              <span className={`sa-chip sa-chip-sm sa-chip-${collectorTone(collectorState)}`}>
                {COLLECTOR_STATE_FA[collectorState]}
              </span>
            </div>
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">نشست کاغذی</span>
              <span
                className={`sa-chip sa-chip-sm sa-chip-${
                  session?.status === "RUNNING"
                    ? "good"
                    : session?.status === "PAUSED"
                      ? "warn"
                      : "muted"
                }`}
              >
                {session
                  ? session.status === "RUNNING"
                    ? "در حال اجرا"
                    : session.status === "PAUSED"
                      ? "متوقف موقت"
                      : session.status === "STOPPED"
                        ? "پایان‌یافته"
                        : "شروع‌نشده"
                  : "نشستی وجود ندارد"}
              </span>
            </div>
            {/* Real execution is stated on the landing screen, always. */}
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">اجرای واقعی</span>
              <span className="sa-chip sa-chip-sm sa-chip-danger">غیرمسلح</span>
            </div>
          </div>

          <div className="sa-cc-status-tail">
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">آخرین چرخهٔ موفق</span>
              <span className="sa-cc-status-value" title={observation?.lastSuccessAt ?? undefined}>
                {observation?.lastSuccessAt ? (
                  <>
                    {formatTehran(observation.lastSuccessAt)}
                    {lastSuccessAgeMs !== null ? (
                      <span className="sa-cc-status-sub">
                        {" "}
                        ({formatDurationFa(lastSuccessAgeMs)} پیش)
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </span>
            </div>
            <button
              type="button"
              className="sa-cc-action glass-control"
              onClick={onRefresh}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
            </button>
          </div>
        </div>

        <div className="sa-cc-progress">
          <div className="sa-cc-progress-head">
            <span>پیشرفت دورهٔ ۱۴ روزه</span>
            <span className="sa-cc-progress-value">
              {progress === null ? "—" : formatPercentFa(progress, 1)}
              {observation ? (
                <span className="sa-cc-status-sub">
                  {" "}
                  · باقی‌مانده {formatDurationFa(observation.remainingMs)}
                </span>
              ) : null}
            </span>
          </div>
          <div className="sa-progress" role="presentation">
            <div
              className="sa-progress-fill"
              style={{ width: `${Math.max(0, Math.min(100, progress ?? 0))}%` }}
            />
          </div>
        </div>
      </section>

      {error ? (
        <div className="sa-callout sa-callout-danger" role="alert">
          {error}
        </div>
      ) : null}

      {stale && !error ? (
        <div className="sa-callout sa-callout-warn">
          دادهٔ نمایش‌داده‌شده از آخرین چرخهٔ جمع‌آوری قدیمی‌تر از حد انتظار است؛ اگر جمع‌آورنده
          متوقف شده باشد، ارقام زیر به‌روز نیستند.
        </div>
      ) : null}

      {/*
        Sizing status. A blocked sizing engine must never look like an idle one:
        when a required risk policy is unset, nothing can trade, and the screen
        says so with the exact policy names rather than showing an empty ledger.
      */}
      {sizing && sizing.missingPolicies.length ? (
        <div className="sa-callout sa-callout-warn" role="status">
          حجم پویا محاسبه نمی‌شود چون {toFaDigits(sizing.missingPolicies.length)} سیاست ریسک لازم
          هنوز تعیین نشده است:{" "}
          <span className="sa-strong">{sizing.missingPolicies.join("، ")}</span>. تا زمانی که مدیر
          این مقادیر را تعیین نکند هیچ حجمی انتخاب نمی‌شود و هیچ معاملهٔ کاغذی تازه‌ای ثبت
          نمی‌گردد — هیچ مقدار پیش‌فرضی جایگزین نمی‌شود.
        </div>
      ) : null}
      {sizing && !sizing.missingPolicies.length ? (
        <div className="sa-callout sa-callout-muted" role="status">
          <span className="sa-chip sa-chip-sm sa-chip-good sa-sz-policy-chip">
            {sizing.policy ?? "SMART_CAPITAL_DEPTH"}
          </span>{" "}
          حجم هوشمند فعال است — {toFaDigits(sizedCount)} مسیر از{" "}
          {toFaDigits(sizing.routes.length)} مسیر بررسی‌شده حجم گرفت.
          {sizing.policyParameters ? (
            <span className="sa-sub">
              {" "}
              نامزدها {toFaDigits(sizing.policyParameters.candidatePercents.join("، "))}٪ از موجودی
              قابل استفادهٔ سمت محدودکننده، با سقف سرمایهٔ{" "}
              {toFaDigits(sizing.policyParameters.capitalCapPercent)}٪، سقف عمق{" "}
              {toFaDigits(sizing.policyParameters.depthCapPercent)}٪ هر پا و حداقل اجراپذیر{" "}
              {toFaDigits(sizing.policyParameters.minExecutableUsdt)} تتر. نردبان ثابت
              ۵/۱۰/۲۰/۲۵ فقط مبنای مقایسه است و اجرا نمی‌شود.
            </span>
          ) : null}
        </div>
      ) : null}

      {/* ── session controls ─────────────────────────────────────────── */}
      {sessionControls}

      {/* ── the eight standing numbers ───────────────────────────────── */}
      <div className="sa-cc-kpis">
        <Kpi
          label="سرمایهٔ کل مجازی"
          tone="muted"
          value={session ? <TomanAmount value={session.totalCapitalToman} /> : DASH}
          hint={
            session
              ? "کل پرتفوی مجازی این نشست — اندازهٔ یک معامله نیست"
              : "نشستی وجود ندارد؛ ابتدا یک نشست کاغذی بسازید"
          }
        />
        <Kpi
          label="سرمایهٔ تخصیص‌یافته"
          tone="muted"
          value={
            summary?.markedValueToman === null || summary === null ? (
              DASH
            ) : (
              <TomanAmount value={summary.markedValueToman} />
            )
          }
          hint={
            summary?.markedValueToman === null
              ? "بدون قیمت مبنا محاسبه نمی‌شود"
              : `ارزش امروزِ موجودی روی ${toFaDigits((portfolio?.balances ?? []).length)} صرافی`
          }
        />
        <Kpi
          label="سرمایهٔ آزاد"
          tone="muted"
          value={session ? <TomanAmount value={freeTomanCash} /> : DASH}
          hint={
            session
              ? `نقد تومانی قابل استفاده برای خرید · موجودی تتری: ${toFaDigits(usdtInventory.toFixed(2))} تتر`
              : "—"
          }
        />
        <Kpi
          label="سود و زیان امروز"
          tone={summary ? tone(summary.todayPnlToman) : "muted"}
          value={summary ? <TomanAmount value={summary.todayPnlToman} /> : DASH}
          hint={
            summary
              ? `از نیمه‌شب تهران تا این لحظه · ${formatCountFa(
                  portfolio?.fills.filter((f) => {
                    const t = new Date();
                    t.setHours(0, 0, 0, 0);
                    return Date.parse(f.occurredAt) >= t.getTime();
                  }).length ?? 0
                )} معاملهٔ امروز`
              : "بدون نشست فعال محاسبه نمی‌شود"
          }
        />
        <Kpi
          label="سود و زیان کل"
          tone={summary ? tone(summary.economicPnlToman) : "muted"}
          value={summary ? <TomanAmount value={summary.economicPnlToman} /> : DASH}
          hint={
            summary ? (
              <>
                تعدیل‌شده با بافر: <TomanAmount value={summary.riskAdjustedPnlToman} />
                {summary.roiPercent === null ? null : (
                  <> · بازده {formatPercentFa(summary.roiPercent, 2, true)}</>
                )}
              </>
            ) : (
              "بدون نشست فعال محاسبه نمی‌شود"
            )
          }
        />
        <Kpi
          label="بیشترین افت"
          tone={summary && summary.drawdownToman > 0 ? "warn" : "muted"}
          value={summary ? <TomanAmount value={summary.drawdownToman} /> : DASH}
          hint={
            summary
              ? `بیشترین بازپس‌دهی از اوج سود تحقق‌یافته${
                  summary.drawdownPercent === null
                    ? ""
                    : ` · ${formatPercentFa(summary.drawdownPercent, 2)} سرمایه`
                }`
              : "بدون نشست فعال محاسبه نمی‌شود"
          }
        />
        <Kpi
          label="معاملات انجام‌شده و رد‌شده"
          tone="muted"
          value={summary ? <Ratio part={summary.filled} whole={summary.filled + summary.rejected} /> : DASH}
          hint={
            summary
              ? `رد‌شده: ${formatCountFa(summary.rejected)} · آخرین معامله: ${
                  summary.lastTradeAt ? formatTehran(summary.lastTradeAt) : "—"
                }`
              : "بدون نشست فعال محاسبه نمی‌شود"
          }
        />
        <Kpi
          label="فرصت‌های معتبر"
          tone={valid.length ? "good" : "muted"}
          value={formatCountFa(valid.length)}
          hint={
            <>
              از {formatCountFa(classified.length)} فرصت مشاهده‌شده ·{" "}
              <button type="button" className="sa-linkish" onClick={() => onOpenSection("book")}>
                مشاهدهٔ فهرست
              </button>
            </>
          }
        />
      </div>

      {/* ── best opportunity, fully disclosed ────────────────────────── */}
      <section className="panel sa-panel sa-cc-best" aria-label="بهترین فرصت فعلی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">بهترین فرصت فعلی</h3>
          <div className="sa-panel-note">
            {best
              ? "معتبر و خالص مثبت پس از کارمزد و بافر لغزش"
              : capacityOnly
                ? "مطالعهٔ ظرفیت — عمیق‌ترین مسیر تحلیل‌شده"
                : NO_VALID_OPPORTUNITY_FA}
          </div>
        </div>
        <div className="panel-body">
          {capacityOnly ? (
            <div className="sa-callout sa-callout-muted" role="status">
              در این لحظه هیچ مسیر خالص مثبتی وجود ندارد. آنچه در ادامه می‌بینید یک{" "}
              <strong>مطالعهٔ ظرفیت</strong> است، نه یک معاملهٔ پیشنهادی: عمیق‌ترین مسیر
              تحلیل‌شده ({bestSizing?.routeKey}) تا کجا می‌توانست حجم بگیرد و چرا سودآور نیست.
            </div>
          ) : null}
          {best || bestSizing ? (
            <>
              <dl className="sa-cc-best-grid">
                <div>
                  <dt>صرافی خرید</dt>
                  <dd>{best ? best.buySourceName : (bestSizing?.buySourceId ?? "—")}</dd>
                </div>
                <div>
                  <dt>صرافی فروش</dt>
                  <dd>{best ? best.sellSourceName : (bestSizing?.sellSourceId ?? "—")}</dd>
                </div>
                <div>
                  <dt>حجم محاسبه‌شده</dt>
                  <dd>
                    {bestSizing?.sizing.status === "SIZED" && bestSizing.sizing.sizeUsdt !== null ? (
                      <>
                        <Bidi>{toFaDigits(bestSizing.sizing.sizeUsdt.toFixed(4))}</Bidi> تتر
                      </>
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>سرمایهٔ درگیر</dt>
                  <dd>
                    {bestSizing?.sizing.economics ? (
                      <TomanAmount value={bestSizing.sizing.economics.capitalInvolvedToman} />
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>سود خالص تعدیل‌شده</dt>
                  <dd
                    className={
                      (bestSizing?.sizing.economics?.riskAdjustedPnlToman ?? 0) >= 0
                        ? "sa-pos"
                        : "sa-neg"
                    }
                  >
                    {bestSizing?.sizing.economics ? (
                      <TomanAmount value={bestSizing.sizing.economics.riskAdjustedPnlToman} />
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>حاشیهٔ تعدیل‌شده</dt>
                  <dd>
                    {bestSizing?.sizing.economics ? (
                      <Bidi>
                        {formatPercentFa(bestSizing.sizing.economics.riskAdjustedEdgePercent)} ·{" "}
                        {toFaDigits(bestSizing.sizing.economics.riskAdjustedReturnBps)} bps
                      </Bidi>
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>موجودی محدودکننده</dt>
                  <dd>
                    {bestSizing?.sizing.capacity ? (
                      <>
                        <Bidi>
                          {toFaDigits(usdtFa(bestSizing.sizing.capacity.limitingUsableMicros))}
                        </Bidi>{" "}
                        تتر
                        <span className="sa-cc-status-sub">
                          {" "}
                          · سمت {bestSizing.sizing.capacity.limitingSide === "buy" ? "خرید" : "فروش"} (
                          {bestSizing.sizing.capacity.limitingSourceId})
                        </span>
                      </>
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>سقف سرمایه ({toFaDigits(CAPITAL_CAP_PERCENT_FA)}٪)</dt>
                  <dd>
                    {bestSizing?.sizing.capacity ? (
                      <>
                        <Bidi>
                          {toFaDigits(usdtFa(bestSizing.sizing.capacity.capitalCapMicros))}
                        </Bidi>{" "}
                        تتر
                      </>
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>سقف عمق ({toFaDigits(DEPTH_CAP_PERCENT_FA)}٪)</dt>
                  <dd>
                    {bestSizing?.sizing.capacity ? (
                      <>
                        <Bidi>{toFaDigits(usdtFa(bestSizing.sizing.capacity.depthCapMicros))}</Bidi>{" "}
                        تتر
                        <span className="sa-cc-status-sub">
                          {" "}
                          · پای {bestSizing.sizing.capacity.depthCapSide === "buy" ? "خرید" : "فروش"}
                        </span>
                      </>
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>VWAP دو پا</dt>
                  <dd>
                    {bestSizing?.sizing.quote ? (
                      <Bidi>
                        {toFaDigits(bestSizing.sizing.quote.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                        {toFaDigits(bestSizing.sizing.quote.sellVwapToman.toLocaleString("en-US"))}
                      </Bidi>
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>اثر بر موجودی</dt>
                  <dd
                    className={
                      bestSizing?.sizing.inventory?.measurable
                        ? bestSizing.sizing.inventory.impactPoints <= 0
                          ? "sa-pos"
                          : "sa-neg"
                        : undefined
                    }
                  >
                    {bestSizing?.sizing.inventory?.measurable ? (
                      <>
                        <Bidi>
                          {bestSizing.sizing.inventory.impactPoints > 0 ? "+" : ""}
                          {toFaDigits(bestSizing.sizing.inventory.impactPoints.toFixed(2))}
                        </Bidi>{" "}
                        واحد
                        <span className="sa-cc-status-sub">
                          {" "}
                          ·{" "}
                          {bestSizing.sizing.inventory.impactPoints <= 0
                            ? "نزدیک‌تر به هدف"
                            : "دورتر از هدف"}
                        </span>
                      </>
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
              </dl>

              {/* Why not bigger — the single question a size always raises. */}
              {bestSizing?.sizing.selection ? (
                <div className="sa-callout sa-callout-muted sa-sz-why" role="status">
                  <p className="sa-sz-why-line">{bestSizing.sizing.selection.reasonFa}</p>
                  {bestSizing.sizing.selection.tieBreakFa ? (
                    <p className="sa-sz-why-line sa-sub">
                      {bestSizing.sizing.selection.tieBreakFa}
                    </p>
                  ) : null}
                  <p className="sa-sz-why-line">
                    <span className="sa-strong">چرا حجم بزرگ‌تر نه؟ </span>
                    {bestSizing.sizing.selection.nextLarger ? (
                      <>
                        نامزد بعدی{" "}
                        <Bidi>
                          {toFaDigits(
                            usdtFa(bestSizing.sizing.selection.nextLarger.sizeUsdtMicros)
                          )}
                        </Bidi>{" "}
                        تتر بود —{" "}
                        <span className="sa-chip sa-chip-sm sa-chip-warn">
                          {bestSizing.sizing.selection.nextLarger.code}
                        </span>{" "}
                        {bestSizing.sizing.selection.nextLarger.detailFa}
                      </>
                    ) : (
                      "هیچ نامزد بزرگ‌تری وجود نداشت؛ حجم انتخاب‌شده خودِ سقف محدودکننده است."
                    )}
                  </p>
                </div>
              ) : null}

              {/* An inventory breach is the one blocker that is about the desk. */}
              {bestSizing?.sizing.inventory &&
              !bestSizing.sizing.inventory.withinBand &&
              bestSizing.sizing.status !== "SIZED" ? (
                <div className="sa-callout sa-callout-warn" role="status">
                  {bestSizing.sizing.inventory.breachDetailFa ??
                    bestSizing.sizing.inventory.reasonFa}
                </div>
              ) : null}

              {/* One line: the size, or the single reason there is none. */}
              <p className={bestSizing?.sizing.status === "SIZED" ? "sa-sub" : "sa-sub sa-neg"}>
                {bestSizing
                  ? bestSizing.sizing.status === "SIZED"
                    ? bestSizing.sizing.bindingConstraint
                      ? `محدودکنندهٔ اصلی حجم: ${
                          bestSizing.sizing.constraints.find(
                            (c) => c.key === bestSizing.sizing.bindingConstraint
                          )?.labelFa ?? bestSizing.sizing.bindingConstraint
                        }`
                      : "هیچ سقفی محدودکننده نبود — حجم را منحنی سود تعیین کرد، نه یک حد."
                    : `حجمی انتخاب نشد — ${bestSizing.sizing.blockers[0]?.detailFa ?? "دلیل ثبت نشده"}`
                  : "برای این مسیر هنوز محاسبه‌ای انجام نشده است."}
              </p>

              {/* The full calculation, folded away by default. */}
              {bestSizing ? (
                <details className="sa-advanced-details sa-cc-calc">
                  <summary>
                    <span>محاسبهٔ کامل حجم و سقف‌های محدودکننده</span>
                  </summary>
                  <div className="sa-cc-calc-body">
                    <div className="sa-table-wrap">
                      <table className="sa-table">
                        <thead>
                          <tr>
                            <th scope="col">سقف</th>
                            <th scope="col" className="num">
                              حداکثر حجم
                            </th>
                            <th scope="col">مبنا</th>
                          </tr>
                        </thead>
                        <tbody>
                          {bestSizing.sizing.constraints.map((c) => (
                            <tr
                              key={c.key}
                              className={
                                c.key === bestSizing.sizing.bindingConstraint ? "sa-strong" : undefined
                              }
                            >
                              <td>
                                {c.labelFa}
                                {c.key === bestSizing.sizing.bindingConstraint ? " ◂ محدودکننده" : ""}
                              </td>
                              <td className="num">
                                {c.capUsdtMicros === null ? (
                                  <span className="sa-unknown" title="اندازه‌گیری نشد">
                                    —
                                  </span>
                                ) : (
                                  <Bidi>{toFaDigits((c.capUsdtMicros / 1_000_000).toFixed(4))}</Bidi>
                                )}
                              </td>
                              <td className="sa-sub">{c.detailFa}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <dl className="sa-cc-best-grid">
                      <div>
                        <dt>سقف نقدشوندگی و موجودی</dt>
                        <dd>
                          {bestSizing.sizing.liquidityMaxUsdtMicros === null ? (
                            DASH
                          ) : (
                            <Bidi>
                              {toFaDigits(
                                (bestSizing.sizing.liquidityMaxUsdtMicros / 1_000_000).toFixed(4)
                              )}
                            </Bidi>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>سقف سیاست ریسک</dt>
                        <dd>
                          {bestSizing.sizing.policyMaxUsdtMicros === null ? (
                            DASH
                          ) : (
                            <Bidi>
                              {toFaDigits(
                                (bestSizing.sizing.policyMaxUsdtMicros / 1_000_000).toFixed(4)
                              )}
                            </Bidi>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>جریان نقدی تومانی</dt>
                        <dd>
                          {bestSizing.sizing.economics ? (
                            <TomanAmount value={bestSizing.sizing.economics.cashPnlIrtToman} />
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>ارزش تومانی کارمزد تتری</dt>
                        <dd>
                          {bestSizing.sizing.economics ? (
                            <TomanAmount value={bestSizing.sizing.economics.sellFeeValueToman} />
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>سود خالص اقتصادی</dt>
                        <dd>
                          {bestSizing.sizing.economics ? (
                            <TomanAmount value={bestSizing.sizing.economics.economicNetPnlToman} />
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>بافر لغزش</dt>
                        <dd>
                          {bestSizing.sizing.economics ? (
                            <TomanAmount value={bestSizing.sizing.economics.slippageBufferToman} />
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                    </dl>

                    {bestSizing.sizing.blockers.length ? (
                      <ul className="sa-cc-blockers">
                        {bestSizing.sizing.blockers.map((b) => (
                          <li key={`${b.code}:${b.subject}`}>{b.detailFa}</li>
                        ))}
                      </ul>
                    ) : null}

                    {/* Optimal versus what the books could physically absorb. */}
                    <dl className="sa-cc-best-grid">
                      <div>
                        <dt>حجم بهینهٔ انتخاب‌شده</dt>
                        <dd>
                          {bestSizing.sizing.sizeUsdt === null ? (
                            DASH
                          ) : (
                            <Bidi>{toFaDigits(bestSizing.sizing.sizeUsdt.toFixed(4))}</Bidi>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>بیشترین حجم ممکن</dt>
                        <dd>
                          {bestSizing.sizing.maxFeasibleUsdtMicros === null ? (
                            DASH
                          ) : (
                            <Bidi>
                              {toFaDigits(
                                (bestSizing.sizing.maxFeasibleUsdtMicros / 1_000_000).toFixed(4)
                              )}
                            </Bidi>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>سهم از دفتر · اثر قیمتی</dt>
                        <dd>
                          {bestSizing.sizing.quote ? (
                            <Bidi>
                              {formatPercentFa(
                                Math.max(
                                  bestSizing.sizing.quote.buyWalk.bookParticipationPercent,
                                  bestSizing.sizing.quote.sellWalk.bookParticipationPercent
                                )
                              )}{" "}
                              ·{" "}
                              {formatPercentFa(
                                Math.max(
                                  bestSizing.sizing.quote.buyWalk.priceImpactPercent,
                                  bestSizing.sizing.quote.sellWalk.priceImpactPercent
                                )
                              )}
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                    </dl>

                    {/* The child-fill ladder: what each leg would actually consume. */}
                    {bestSizing.sizing.quote
                      ? (
                          [
                            ["خرید", bestSizing.sizing.quote.buyWalk],
                            ["فروش", bestSizing.sizing.quote.sellWalk]
                          ] as Array<[string, BookWalkView]>
                        ).map(([legFa, walk]) => (
                          <div key={legFa} className="sa-table-wrap">
                            <table className="sa-table">
                              <caption className="sa-sub">
                                نردبان اجرای {legFa} — {toFaDigits(walk.fills.length)} فیل فرزند ·
                                میانگین <Bidi>{toFaDigits(walk.vwapToman ?? 0)}</Bidi> · بدترین قیمت{" "}
                                <Bidi>{toFaDigits(walk.worstPriceToman ?? 0)}</Bidi>
                                {walk.unfilledMicros > 0
                                  ? ` · پرنشده ${(walk.unfilledMicros / 1_000_000).toFixed(4)} تتر`
                                  : " · بدون باقی‌مانده"}
                              </caption>
                              <thead>
                                <tr>
                                  <th scope="col">#</th>
                                  <th scope="col" className="num">قیمت</th>
                                  <th scope="col" className="num">مقدار (تتر)</th>
                                  <th scope="col" className="num">ارزش</th>
                                </tr>
                              </thead>
                              <tbody>
                                {walk.fills.map((f) => (
                                  <tr key={f.index}>
                                    <td>{toFaDigits(f.index)}</td>
                                    <td className="num">
                                      <TomanAmount value={f.priceToman} />
                                    </td>
                                    <td className="num">
                                      <Bidi>{toFaDigits((f.quantityMicros / 1_000_000).toFixed(4))}</Bidi>
                                    </td>
                                    <td className="num">
                                      <TomanAmount value={f.notionalToman} />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ))
                      : null}

                    {/* Every evaluated candidate: eligible or with its exact cause. */}
                    {bestSizing.sizing.candidates.length ? (
                      <div className="sa-sz-block">
                        <p className="sa-sub sa-sz-caption">
                          نامزدهای حجم — درصدی از موجودی قابل استفادهٔ سمت محدودکننده؛ حجم
                          انتخاب‌شده پررنگ است
                        </p>
                        <div className="sa-table-wrap sa-sz-desktop">
                          <table className="sa-table">
                            <thead>
                              <tr>
                                <th scope="col" className="num">حجم (تتر)</th>
                                <th scope="col" className="num">٪ ظرفیت</th>
                                <th scope="col" className="num">VWAP خرید</th>
                                <th scope="col" className="num">VWAP فروش</th>
                                <th scope="col" className="num">سود تعدیل‌شده</th>
                                <th scope="col" className="num">بازده (bps)</th>
                                <th scope="col" className="num">اثر موجودی</th>
                                <th scope="col">وضعیت</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bestSizing.sizing.candidates.map((c) => {
                                const chosen =
                                  bestSizing.sizing.sizeUsdt !== null &&
                                  Math.round(bestSizing.sizing.sizeUsdt * 1_000_000) ===
                                    c.sizeUsdtMicros;
                                return (
                                  <tr
                                    key={c.sizeUsdtMicros}
                                    className={chosen ? "sa-strong" : undefined}
                                  >
                                    <td className="num">
                                      <Bidi>{toFaDigits(usdtFa(c.sizeUsdtMicros))}</Bidi>
                                      {chosen ? " ◂" : ""}
                                    </td>
                                    <td className="num">
                                      {c.percentOfUsable === null ? (
                                        <span className="sa-unknown" title="سقف محدودکننده">
                                          سقف
                                        </span>
                                      ) : (
                                        <Bidi>{toFaDigits(c.percentOfUsable)}٪</Bidi>
                                      )}
                                    </td>
                                    <td className="num">
                                      {c.buyVwapToman ? <TomanAmount value={c.buyVwapToman} /> : DASH}
                                    </td>
                                    <td className="num">
                                      {c.sellVwapToman ? (
                                        <TomanAmount value={c.sellVwapToman} />
                                      ) : (
                                        DASH
                                      )}
                                    </td>
                                    <td
                                      className={
                                        c.riskAdjustedPnlToman > 0 ? "num sa-pos" : "num sa-neg"
                                      }
                                    >
                                      <TomanAmount value={c.riskAdjustedPnlToman} />
                                    </td>
                                    <td className="num">
                                      <Bidi>{toFaDigits(c.riskAdjustedReturnBps)}</Bidi>
                                    </td>
                                    <td
                                      className={
                                        c.inventoryImpactPoints <= 0 ? "num sa-pos" : "num sa-neg"
                                      }
                                    >
                                      <Bidi>
                                        {c.inventoryImpactPoints > 0 ? "+" : ""}
                                        {toFaDigits(c.inventoryImpactPoints.toFixed(2))}
                                      </Bidi>
                                    </td>
                                    <td className="sa-sub">
                                      {c.eligible ? (
                                        <span className="sa-chip sa-chip-sm sa-chip-good">
                                          واجد شرایط
                                        </span>
                                      ) : (
                                        <>
                                          <span className="sa-chip sa-chip-sm sa-chip-warn">
                                            {c.rejectionCode}
                                          </span>{" "}
                                          {c.rejectionFa}
                                        </>
                                      )}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>

                        {/* Mobile: one card per candidate, nothing scrolls sideways. */}
                        <ul className="sa-sz-cards">
                          {bestSizing.sizing.candidates.map((c) => {
                            const chosen =
                              bestSizing.sizing.sizeUsdt !== null &&
                              Math.round(bestSizing.sizing.sizeUsdt * 1_000_000) === c.sizeUsdtMicros;
                            return (
                              <li
                                key={c.sizeUsdtMicros}
                                className={`sa-sz-card${chosen ? " sa-sz-card-chosen" : ""}`}
                              >
                                <div className="sa-sz-card-head">
                                  <span className="sa-sz-card-title">
                                    <Bidi>{toFaDigits(usdtFa(c.sizeUsdtMicros))}</Bidi> تتر
                                    {c.percentOfUsable === null ? (
                                      <span className="sa-cc-status-sub"> · سقف</span>
                                    ) : (
                                      <span className="sa-cc-status-sub">
                                        {" "}
                                        · {toFaDigits(c.percentOfUsable)}٪
                                      </span>
                                    )}
                                  </span>
                                  {c.eligible ? (
                                    <span className="sa-chip sa-chip-sm sa-chip-good">
                                      {chosen ? "انتخاب‌شده" : "واجد شرایط"}
                                    </span>
                                  ) : (
                                    <span className="sa-chip sa-chip-sm sa-chip-warn">
                                      {c.rejectionCode}
                                    </span>
                                  )}
                                </div>
                                <dl className="sa-sz-card-grid">
                                  <div>
                                    <dt>سود تعدیل‌شده</dt>
                                    <dd
                                      className={
                                        c.riskAdjustedPnlToman > 0 ? "sa-pos" : "sa-neg"
                                      }
                                    >
                                      <TomanAmount value={c.riskAdjustedPnlToman} />
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>بازده</dt>
                                    <dd>
                                      <Bidi>{toFaDigits(c.riskAdjustedReturnBps)} bps</Bidi>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>VWAP خرید ↤ فروش</dt>
                                    <dd>
                                      <Bidi>
                                        {toFaDigits(c.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                                        {toFaDigits(c.sellVwapToman.toLocaleString("en-US"))}
                                      </Bidi>
                                    </dd>
                                  </div>
                                  <div>
                                    <dt>اثر موجودی</dt>
                                    <dd
                                      className={
                                        c.inventoryImpactPoints <= 0 ? "sa-pos" : "sa-neg"
                                      }
                                    >
                                      <Bidi>
                                        {c.inventoryImpactPoints > 0 ? "+" : ""}
                                        {toFaDigits(c.inventoryImpactPoints.toFixed(2))} واحد
                                      </Bidi>
                                    </dd>
                                  </div>
                                </dl>
                                {c.eligible ? null : (
                                  <p className="sa-sub sa-sz-card-note">{c.rejectionFa}</p>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    ) : null}

                    {/* The old fixed ladder, priced on the same evidence. */}
                    {bestSizing.sizing.baseline ? (
                      <div className="sa-sz-block">
                        <p className="sa-sub sa-sz-caption">
                          مبنای مقایسه — نردبان ثابت{" "}
                          <span className="sa-chip sa-chip-sm sa-chip-muted">
                            {bestSizing.sizing.baseline.policy}
                          </span>{" "}
                          <span className="sa-chip sa-chip-sm sa-chip-danger">
                            اجرا نمی‌شود
                          </span>
                        </p>
                        <div className="sa-table-wrap sa-sz-desktop">
                          <table className="sa-table">
                            <thead>
                              <tr>
                                <th scope="col" className="num">حجم ثابت (تتر)</th>
                                <th scope="col" className="num">VWAP خرید</th>
                                <th scope="col" className="num">VWAP فروش</th>
                                <th scope="col" className="num">سود تعدیل‌شده</th>
                                <th scope="col" className="num">بازده (bps)</th>
                                <th scope="col">وضعیت</th>
                              </tr>
                            </thead>
                            <tbody>
                              {bestSizing.sizing.baseline.rows.map((r) => (
                                <tr key={r.sizeUsdt}>
                                  <td className="num">
                                    <Bidi>{toFaDigits(r.sizeUsdt)}</Bidi>
                                  </td>
                                  <td className="num">
                                    {r.buyVwapToman === null ? (
                                      DASH
                                    ) : (
                                      <TomanAmount value={r.buyVwapToman} />
                                    )}
                                  </td>
                                  <td className="num">
                                    {r.sellVwapToman === null ? (
                                      DASH
                                    ) : (
                                      <TomanAmount value={r.sellVwapToman} />
                                    )}
                                  </td>
                                  <td
                                    className={
                                      r.riskAdjustedPnlToman === null
                                        ? "num"
                                        : r.riskAdjustedPnlToman > 0
                                          ? "num sa-pos"
                                          : "num sa-neg"
                                    }
                                  >
                                    {r.riskAdjustedPnlToman === null ? (
                                      DASH
                                    ) : (
                                      <TomanAmount value={r.riskAdjustedPnlToman} />
                                    )}
                                  </td>
                                  <td className="num">
                                    {r.riskAdjustedReturnBps === null ? (
                                      DASH
                                    ) : (
                                      <Bidi>{toFaDigits(r.riskAdjustedReturnBps)}</Bidi>
                                    )}
                                  </td>
                                  <td className="sa-sub">{r.reasonFa}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <ul className="sa-sz-cards">
                          {bestSizing.sizing.baseline.rows.map((r) => (
                            <li key={r.sizeUsdt} className="sa-sz-card">
                              <div className="sa-sz-card-head">
                                <span className="sa-sz-card-title">
                                  <Bidi>{toFaDigits(r.sizeUsdt)}</Bidi> تتر
                                </span>
                                <span className="sa-chip sa-chip-sm sa-chip-danger">
                                  اجرا نمی‌شود
                                </span>
                              </div>
                              <dl className="sa-sz-card-grid">
                                <div>
                                  <dt>سود تعدیل‌شده</dt>
                                  <dd
                                    className={
                                      r.riskAdjustedPnlToman === null
                                        ? undefined
                                        : r.riskAdjustedPnlToman > 0
                                          ? "sa-pos"
                                          : "sa-neg"
                                    }
                                  >
                                    {r.riskAdjustedPnlToman === null ? (
                                      DASH
                                    ) : (
                                      <TomanAmount value={r.riskAdjustedPnlToman} />
                                    )}
                                  </dd>
                                </div>
                                <div>
                                  <dt>بازده</dt>
                                  <dd>
                                    {r.riskAdjustedReturnBps === null ? (
                                      DASH
                                    ) : (
                                      <Bidi>{toFaDigits(r.riskAdjustedReturnBps)} bps</Bidi>
                                    )}
                                  </dd>
                                </div>
                              </dl>
                              <p className="sa-sub sa-sz-card-note">{r.reasonFa}</p>
                            </li>
                          ))}
                        </ul>

                        <p className="sa-sub">
                          {bestSizing.sizing.baseline.noteFa}
                          {bestSizing.sizing.baseline.bestRiskAdjustedPnlToman !== null &&
                          bestSizing.sizing.economics ? (
                            <>
                              {" "}
                              بهترین نتیجهٔ نردبان ثابت (
                              <Bidi>
                                {toFaDigits(bestSizing.sizing.baseline.bestSizeUsdt ?? 0)}
                              </Bidi>{" "}
                              تتر):{" "}
                              <TomanAmount
                                value={bestSizing.sizing.baseline.bestRiskAdjustedPnlToman}
                              />{" "}
                              در برابر{" "}
                              <TomanAmount
                                value={bestSizing.sizing.economics.riskAdjustedPnlToman}
                              />{" "}
                              حجم هوشمند.
                            </>
                          ) : null}
                        </p>
                      </div>
                    ) : null}

                    <p className="sa-sub">
                      قیمت‌گذاری با پیمایش واقعی سطوح دفتر انجام شده است، نه با یک قیمت سرصفحه یا
                      پروب ثابت. حجم انتخابی بیشترین سود تعدیل‌شده را می‌دهد و لزوماً بزرگ‌ترین حجم
                      ممکن نیست؛ فراتر از عمق مشاهده‌شده هیچ برون‌یابی انجام نمی‌شود.
                    </p>
                  </div>
                </details>
              ) : null}
              {best ? (
              <p className="sa-sub">
                پس از کارمزد خرید <TomanAmount value={best.buyFeeToman} />، کارمزد فروش{" "}
                <TomanAmount value={best.sellFeeToman} /> و بافر لغزش{" "}
                <TomanAmount value={best.slippageBufferToman} /> محاسبه شده است.
                {bestEvidence?.riskAdjustedPnlToman !== null &&
                bestEvidence?.riskAdjustedPnlToman !== undefined ? (
                  <>
                    {" "}
                    سود ثبت‌شده در اجرای کاغذی برای همین مسیر و همین حجم:{" "}
                    <TomanAmount value={bestEvidence.riskAdjustedPnlToman} />.
                  </>
                ) : null}
              </p>
              ) : null}
              <p className="sa-sub">
                حجم از کمینهٔ عمق اثبات‌شدهٔ دفتر، موجودی تومانی و تتری دو صرافی با احتساب کارمزد،
                سهم طرح سرمایه و سقف‌های سیاست ریسک محاسبه می‌شود. هیچ حد ریسکی به‌جای مدیر فرض
                نمی‌شود؛ اگر سیاستی تعیین نشده باشد، حجم انتخاب نمی‌گردد.
              </p>
            </>
          ) : (
            <p className="sa-cc-empty">
              {NO_VALID_OPPORTUNITY_FA}. تا زمانی که مسیری پس از کارمزد و بافر لغزش خالص مثبت نشود،
              اینجا عددی ساخته نمی‌شود.
            </p>
          )}
        </div>
      </section>

      {/* ── the 9-venue matrix: every fact, per venue, side by side ───── */}
      {sem?.matrix?.length ? (
        <section className="panel sa-panel" aria-label="ماتریس صرافی‌ها">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">ماتریس صرافی‌ها</h3>
            <div className="sa-panel-note">
              ظرفیت و قابلیت استفادهٔ هر پا جداگانه — یک پای معتبر برای شرکت در آربیتراژ کافی است
            </div>
          </div>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">صرافی</th>
                  <th scope="col">نوع داده</th>
                  <th scope="col">حساب/کارمزد</th>
                  <th scope="col">نقش</th>
                  <th scope="col" className="num">ظرفیت خرید</th>
                  <th scope="col">پای خرید</th>
                  <th scope="col" className="num">ظرفیت فروش</th>
                  <th scope="col">پای فروش</th>
                  <th scope="col">شرکت‌کننده</th>
                  <th scope="col">مانع دقیق</th>
                </tr>
              </thead>
              <tbody>
                {sem.matrix.map((m) => (
                  <tr key={m.sourceId}>
                    <td>{m.nameFa}</td>
                    <td className="sa-sub">
                      {m.dataType === "EXECUTABLE_QUOTE" ? "نقل‌قول اجراپذیر" : "دفتر سفارش"}
                    </td>
                    <td className="sa-sub">
                      {m.kycComplete ? "KYC ✓" : "KYC ✗"} ·{" "}
                      {m.accountEligible ? "حساب ✓" : "حساب ✗"} ·{" "}
                      {m.feeConfirmed ? "کارمزد ✓" : "کارمزد ✗"}
                    </td>
                    <td className="sa-sub">{m.allocationRole ?? "—"}</td>
                    <td className="num">
                      {m.buyCapacityUsdtMicros === null ? (
                        DASH
                      ) : (
                        <Bidi>{toFaDigits((m.buyCapacityUsdtMicros / 1_000_000).toFixed(2))}</Bidi>
                      )}
                    </td>
                    <td>
                      <span className={`sa-chip sa-chip-sm sa-chip-${m.buyLegUsable ? "good" : "muted"}`}>
                        {m.buyLegUsable ? "قابل استفاده" : "خیر"}
                      </span>
                    </td>
                    <td className="num">
                      {m.sellCapacityUsdtMicros === null ? (
                        DASH
                      ) : (
                        <Bidi>{toFaDigits((m.sellCapacityUsdtMicros / 1_000_000).toFixed(2))}</Bidi>
                      )}
                    </td>
                    <td>
                      <span className={`sa-chip sa-chip-sm sa-chip-${m.sellLegUsable ? "good" : "muted"}`}>
                        {m.sellLegUsable ? "قابل استفاده" : "خیر"}
                      </span>
                    </td>
                    <td>
                      <span className={`sa-chip sa-chip-sm sa-chip-${m.participates ? "good" : "warn"}`}>
                        {m.participates ? "بله" : "خیر"}
                      </span>
                    </td>
                    <td className="sa-sub">
                      {m.blockerFa ??
                        `خرید: ${
                          CAP_LABEL_FA[m.buyLimiter as keyof typeof CAP_LABEL_FA] ??
                          VENUE_CAPACITY_REASON_FA[
                            m.buyReason as keyof typeof VENUE_CAPACITY_REASON_FA
                          ] ??
                          "—"
                        } · فروش: ${
                          CAP_LABEL_FA[m.sellLimiter as keyof typeof CAP_LABEL_FA] ??
                          VENUE_CAPACITY_REASON_FA[
                            m.sellReason as keyof typeof VENUE_CAPACITY_REASON_FA
                          ] ??
                          "—"
                        }`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ── per-venue capacity, each with its own exact reason ───────── */}
      {sizing?.venueCapacities?.length ? (
        <section className="panel sa-panel" aria-label="ظرفیت هر صرافی">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">ظرفیت هر صرافی</h3>
            <div className="sa-panel-note">
              حداکثر حجم قابل خرید و فروش روی هر صرافی، با محدودکنندهٔ دقیق هر سمت
            </div>
          </div>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">صرافی</th>
                  <th scope="col" className="num">تومان</th>
                  <th scope="col" className="num">تتر</th>
                  <th scope="col" className="num">ظرفیت خرید</th>
                  <th scope="col">محدودکنندهٔ خرید</th>
                  <th scope="col" className="num">ظرفیت فروش</th>
                  <th scope="col">محدودکنندهٔ فروش</th>
                </tr>
              </thead>
              <tbody>
                {sizing.venueCapacities.map((v) => {
                  const bal = portfolio?.balances.find((b) => b.sourceId === v.sourceId);
                  const capOf = (side: VenueCapacityView["buy"]) =>
                    side.capacityUsdtMicros === null ? null : side.capacityUsdtMicros / 1_000_000;
                  const limitOf = (side: VenueCapacityView["buy"]) =>
                    side.capacityUsdtMicros === null
                      ? side.reasonFa
                      : (side.caps.find((c) => c.key === side.limitingCap)?.labelFa ?? "—");
                  return (
                    <tr key={v.sourceId}>
                      <td>{v.nameFa}</td>
                      <td className="num">
                        {bal ? <TomanAmount value={bal.irtToman} /> : DASH}
                      </td>
                      <td className="num">
                        {bal ? <Bidi>{toFaDigits(bal.usdt.toFixed(2))}</Bidi> : DASH}
                      </td>
                      <td className="num">
                        {capOf(v.buy) === null ? (
                          DASH
                        ) : (
                          <Bidi>{toFaDigits((capOf(v.buy) as number).toFixed(2))}</Bidi>
                        )}
                      </td>
                      <td className="sa-sub">{limitOf(v.buy)}</td>
                      <td className="num">
                        {capOf(v.sell) === null ? (
                          DASH
                        ) : (
                          <Bidi>{toFaDigits((capOf(v.sell) as number).toFixed(2))}</Bidi>
                        )}
                      </td>
                      <td className="sa-sub">{limitOf(v.sell)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="panel-body sa-sub">
            سقف سیاست تعیین‌نشده «اعمال نشد» است، نه صفر — اجرای واقعی همچنان مسدود می‌ماند.
            دلیل هر صرافی مستقل است؛ نبودِ دفتر ساختاری (نقل‌قول تک‌قیمتی) هرگز با نبودِ دفتر در یک
            چرخه یکی گزارش نمی‌شود.
          </div>

          {/* ── current versus proposed allocation ────────────────────── */}
          <div className="panel-body sa-stack-2">
            {/* Scenario caps: preview only, never an approval. */}
            <div className="sa-filter-body">
              {SCENARIO_CAP_KEYS.map((key) => {
                const v = scenarioCaps[key];
                const unset = v === null || v === undefined;
                return (
                  <label className="sa-field" key={key}>
                    <span className="sa-field-label">{SCENARIO_CAP_FA[key]}</span>
                    <input
                      className="sa-control glass-control"
                      inputMode="decimal"
                      placeholder="تعیین‌نشده"
                      value={unset ? "" : String(v)}
                      onChange={(e) => {
                        const raw = e.target.value.trim();
                        // Empty means UNSET. "0" is a real cap and stays 0.
                        onScenarioCapChange(key, raw === "" ? null : Number(raw));
                      }}
                    />
                    <span className="sa-sub">
                      {unset ? "تعیین‌نشده — در تحلیل اعمال نمی‌شود" : `اعمال می‌شود: ${toFaDigits(v)}`}
                    </span>
                  </label>
                );
              })}
            </div>

            <div className="sa-chips">
              <button
                type="button"
                className="sa-btn-details glass-control"
                disabled={proposalBusy}
                onClick={onProposeAllocation}
              >
                {proposalBusy ? "در حال محاسبه…" : "ساخت پیشنهاد (فقط پیش‌نمایش)"}
              </button>
              {proposal && proposal.status !== "PREVIEW" ? (
                applyArmed ? (
                  <>
                    <button
                      type="button"
                      className="sa-btn-clear glass-control"
                      disabled={proposalBusy}
                      onClick={onApplyAllocation}
                    >
                      بله، همین پیشنهاد را اعمال کن
                    </button>
                    <button
                      type="button"
                      className="sa-btn-clear glass-control"
                      onClick={() => onArmApply(false)}
                    >
                      انصراف
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="sa-btn-clear glass-control"
                    disabled={proposalBusy}
                    onClick={() => onArmApply(true)}
                  >
                    اعمال پیشنهاد…
                  </button>
                )
              ) : null}
            </div>

            {proposal ? (
              <div className="sa-sub">
                پیشنهاد <Bidi>{proposal.id.slice(0, 8)}</Bidi> ·{" "}
                <span className="sa-sub">نوع رکورد:</span>{" "}
                <span className="sa-strong">
                  {proposal.status === "PREVIEW"
                    ? "پیش‌نمایش (قابل اعمال نیست)"
                    : "پیشنهاد ثبت‌شده — آمادهٔ اعمال"}
                </span>
                {proposal.status === "PREVIEW"
                  ? " — بر پایهٔ سقف سناریویی تأییدنشده ساخته شده و قابل اعمال نیست."
                  : null}
                {proposal.fingerprints ? (
                  <>
                    {" "}
                    · اثرانگشت‌ها: دفتر <Bidi>{proposal.fingerprints.books.slice(0, 8)}</Bidi> ·
                    کارمزد <Bidi>{proposal.fingerprints.fees.slice(0, 8)}</Bidi> · حساب{" "}
                    <Bidi>{proposal.fingerprints.accounts.slice(0, 8)}</Bidi> · سیاست{" "}
                    <Bidi>{proposal.fingerprints.policy.slice(0, 8)}</Bidi>
                  </>
                ) : null}
              </div>
            ) : null}

            {proposalDecision ? (
              <div
                className={`sa-callout ${
                  proposalDecision.decision === "APPLIED" ? "sa-callout-muted" : "sa-callout-warn"
                }`}
                role="status"
              >
                <span className="sa-sub">آخرین تصمیم ماندگار روی این رکورد:</span>{" "}
                <span className="sa-strong">
                  {proposalDecision.decision === "APPLIED"
                    ? "اعمال شد"
                    : proposalDecision.decision === "REJECTED_STALE"
                      ? "رد شد — کهنه"
                      : "ناموفق"}
                </span>{" "}
                — {proposalDecision.detailFa} ({proposalDecision.decidedBy})
                <div className="sa-sub">
                  «نوع رکورد» می‌گوید این ردیف چیست و «تصمیم ماندگار» می‌گوید بعداً چه بر سرش
                  آمد؛ چون ذخیره‌سازی افزودنی است، این دو هرگز یکدیگر را نقض نمی‌کنند.
                </div>
              </div>
            ) : null}
            <p className="sa-sub">
              ساخت پیشنهاد فقط محاسبه و ثبت می‌کند و هیچ موجودی‌ای را تغییر نمی‌دهد. تخصیص فعلی تا
              زمانی که مدیر صریحاً «اعمال» را نزند دست‌نخورده می‌ماند، و پیشنهادی که شواهدش (دفتر،
              کارمزد، حساب یا سیاست) تغییر کرده باشد رد می‌شود.
            </p>
          </div>

          {proposal ? (
            <>
              <div className="panel-body sa-table-wrap">
                <table className="sa-table">
                  <caption className="sa-sub">
                    تخصیص فعلی در برابر پیشنهادی — مجموع پیشنهاد{" "}
                    <TomanAmount value={proposal.allocatedToman} /> با باقی‌ماندهٔ{" "}
                    {toFaDigits(proposal.residualToman)}
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">صرافی</th>
                      <th scope="col">نقش</th>
                      <th scope="col" className="num">تومان فعلی</th>
                      <th scope="col" className="num">تومان پیشنهادی</th>
                      <th scope="col" className="num">تتر فعلی</th>
                      <th scope="col" className="num">تتر پیشنهادی</th>
                      <th scope="col" className="num">ارزش پیشنهادی</th>
                      <th scope="col" className="num">تغییر</th>
                      <th scope="col">ظرفیت و محدودکننده</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proposal.rows.map((r) => {
                      const cur = portfolio?.balances.find((b) => b.sourceId === r.sourceId);
                      const curValue = cur
                        ? Math.round(cur.irtToman + cur.usdt * (markPrice ?? 0))
                        : null;
                      const delta = curValue === null ? null : r.valueToman - curValue;
                      return (
                        <tr key={r.sourceId}>
                          <td>{r.sourceId}</td>
                          <td className="sa-sub">{r.role}</td>
                          <td className="num">
                            {cur ? <TomanAmount value={cur.irtToman} /> : DASH}
                          </td>
                          <td className="num">
                            <TomanAmount value={r.irtToman} />
                          </td>
                          <td className="num">
                            {cur ? <Bidi>{toFaDigits(cur.usdt.toFixed(2))}</Bidi> : DASH}
                          </td>
                          <td className="num">
                            <Bidi>{toFaDigits(r.usdtUnits.toFixed(2))}</Bidi>
                          </td>
                          <td className="num">
                            <TomanAmount value={r.valueToman} />
                          </td>
                          <td className={`num ${(delta ?? 0) >= 0 ? "sa-pos" : "sa-neg"}`}>
                            {delta === null ? DASH : <TomanAmount value={delta} />}
                          </td>
                          {/*
                            Read straight from the stored proposal row, which
                            `venueCapacity()` produced at generation time. The UI
                            names a limiter; it never decides one.
                          */}
                          <td className="sa-sub">
                            <div className="sa-stack-2">
                              <span>
                                خرید:{" "}
                                {r.buyCapacityUsdtMicros === null ? (
                                  <span className="sa-strong">
                                    {VENUE_CAPACITY_REASON_FA[
                                      r.buyReason as keyof typeof VENUE_CAPACITY_REASON_FA
                                    ] ?? r.buyReason}
                                  </span>
                                ) : (
                                  <>
                                    <Bidi>
                                      {toFaDigits((r.buyCapacityUsdtMicros / 1_000_000).toFixed(2))}
                                    </Bidi>{" "}
                                    تتر ·{" "}
                                    {CAP_LABEL_FA[r.buyLimiter as keyof typeof CAP_LABEL_FA] ??
                                      r.buyLimiter ??
                                      "—"}
                                  </>
                                )}
                              </span>
                              <span>
                                فروش:{" "}
                                {r.sellCapacityUsdtMicros === null ? (
                                  <span className="sa-strong">
                                    {VENUE_CAPACITY_REASON_FA[
                                      r.sellReason as keyof typeof VENUE_CAPACITY_REASON_FA
                                    ] ?? r.sellReason}
                                  </span>
                                ) : (
                                  <>
                                    <Bidi>
                                      {toFaDigits((r.sellCapacityUsdtMicros / 1_000_000).toFixed(2))}
                                    </Bidi>{" "}
                                    تتر ·{" "}
                                    {CAP_LABEL_FA[r.sellLimiter as keyof typeof CAP_LABEL_FA] ??
                                      r.sellLimiter ??
                                      "—"}
                                  </>
                                )}
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="panel-body sa-sub">
                سقف‌های اعمال‌شده:{" "}
                {Object.keys(proposal.appliedPolicyCaps).length
                  ? Object.entries(proposal.appliedPolicyCaps)
                      .map(([k, v]) => `${k}=${v}`)
                      .join("، ")
                  : "هیچ‌کدام"}{" "}
                · تعیین‌نشده (اعمال نشد):{" "}
                <span className="sa-strong">{proposal.unsetPolicyCaps.join("، ") || "—"}</span>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {/* ── health and safety, one line each ─────────────────────────── */}
      <div className="sa-cc-health">
        <section className="panel sa-panel sa-cc-mini">
          <h3 className="sa-cc-mini-title">سلامت منابع</h3>
          <dl className="sa-cc-mini-list">
            <div>
              <dt>منبع سالم</dt>
              <dd>{sources.length ? <Ratio part={healthySources} whole={sources.length} /> : DASH}</dd>
            </div>
            <div>
              <dt>پوشش موفق</dt>
              <dd>{coverage === null ? DASH : formatPercentFa(coverage, 1)}</dd>
            </div>
          </dl>
        </section>

        <section className="panel sa-panel sa-cc-mini">
          <h3 className="sa-cc-mini-title">وضعیت صرافی‌ها</h3>
          {/*
            Four different facts, never collapsed into one "9/9". A venue can be
            KYC-confirmed and account-eligible while its market data cannot be
            measured this cycle and no route through it is usable — those are
            separate questions with separate answers.
          */}
          <dl className="sa-cc-mini-list">
            <div>
              <dt>احراز هویت تأییدشده</dt>
              <dd>
                {sem ? <Ratio part={sem.kycConfirmed} whole={sem.total} /> : DASH}
              </dd>
            </div>
            <div>
              <dt>حساب اجراپذیر</dt>
              <dd>
                {sem ? (
                  <Ratio part={sem.accountEligible} whole={sem.total} />
                ) : accounts ? (
                  <Ratio part={accounts.executable} whole={accounts.total} />
                ) : (
                  DASH
                )}
              </dd>
            </div>
            <div>
              <dt>ظرفیت خرید قابل اندازه‌گیری</dt>
              <dd>{sem ? <Ratio part={sem.buyCapacityMeasurable} whole={sem.total} /> : DASH}</dd>
            </div>
            <div>
              <dt>ظرفیت فروش قابل اندازه‌گیری</dt>
              <dd>{sem ? <Ratio part={sem.sellCapacityMeasurable} whole={sem.total} /> : DASH}</dd>
            </div>
            <div>
              <dt>پای خرید قابل استفاده</dt>
              <dd>{sem ? <Ratio part={sem.buyLegUsable} whole={sem.total} /> : DASH}</dd>
            </div>
            <div>
              <dt>پای فروش قابل استفاده</dt>
              <dd>{sem ? <Ratio part={sem.sellLegUsable} whole={sem.total} /> : DASH}</dd>
            </div>
            <div className="sa-cc-wide">
              <dt>واجد شرکت در حداقل یک مسیر</dt>
              <dd>
                {sem ? <Ratio part={sem.participating} whole={sem.total} /> : DASH}
                <span className="sa-sub">
                  {" "}
                  — یک پای معتبر کافی است؛ صرافی لازم نیست هر دو جهت را داشته باشد.
                </span>
              </dd>
            </div>
            <div className="sa-cc-wide">
              <dt>نقل‌قولی / تأییدنشده</dt>
              <dd className="sa-cc-reason">
                {sem
                  ? sem.quoteOnly.length || sem.unverified.length
                    ? [
                        ...sem.quoteOnly.map(
                          (q) =>
                            `${q.sourceId}: نقل‌قولی — ${
                              VENUE_CAPACITY_REASON_FA[
                                q.buyReason as keyof typeof VENUE_CAPACITY_REASON_FA
                              ] ?? q.buyReason
                            }`
                        ),
                        ...sem.unverified
                          .filter((u) => !sem.quoteOnly.some((q) => q.sourceId === u.sourceId))
                          .map((u) => `${u.sourceId}: ${u.reasonFa}`)
                      ].join(" · ")
                    : "هیچ‌کدام"
                  : "—"}
              </dd>
            </div>
            <div className="sa-cc-wide">
              <dt>جزئیات</dt>
              <dd>
                <button
                  type="button"
                  className="sa-linkish"
                  onClick={() => onOpenSection("settings")}
                >
                  تنظیمات و ایمنی
                </button>
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel sa-panel sa-cc-mini">
          <h3 className="sa-cc-mini-title">مرز اجرای واقعی</h3>
          <div className="sa-cc-disarmed" role="status">
            <span className="sa-chip sa-chip-sm sa-chip-danger">غیرمسلح</span>
            <span>اجرای واقعی پیاده‌سازی نشده است — هیچ سفارش واقعی ثبت نمی‌شود.</span>
          </div>
          <dl className="sa-cc-mini-list">
            <div>
              <dt>دروازه‌های برقرار</dt>
              <dd>{readiness ? <Ratio part={readiness.passed} whole={readiness.total} /> : DASH}</dd>
            </div>
            {/* A blocking reason is a sentence — it gets the whole row. */}
            <div className="sa-cc-wide">
              <dt>نخستین مانع</dt>
              <dd className="sa-cc-reason">{readiness?.topBlockerFa ?? "—"}</dd>
            </div>
          </dl>
        </section>
      </div>

      {/* ── everything technical, folded away ────────────────────────── */}
      {advanced ? (
        <details className="panel sa-panel sa-advanced-details">
          <summary className="panel-header sa-panel-header">
            <span className="panel-title">تشخیص‌های پیشرفته</span>
            <span className="sa-panel-note">
              دروازه‌های آمادگی، سیاست‌ها، شواهد، اجارهٔ جمع‌آورنده و محاسبات خام
            </span>
          </summary>
          <div className="panel-body sa-stack">{advanced}</div>
        </details>
      ) : null}

      <p className="sa-cc-foot">{serverNow ? <>زمان سرور: {formatTehran(serverNow)}</> : null}</p>
    </div>
  );
}
