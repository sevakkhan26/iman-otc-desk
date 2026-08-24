"use client";

/**
 * «سرمایه و حساب» — portfolio summary and per-exchange virtual capital.
 *
 * v4.2.1: no experiment panel, no session setup (moved to Settings), no fees,
 * no market depth. Presentation-only from persisted accounting props.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { Kpi } from "@/components/shadowArbitrage/panelKit";

export type AccountsAccounting = {
  asOf: string;
  initialCapitalToman: number;
  markPriceToman: number | null;
  markPriceProvisional: boolean;
  equityToman: number | null;
  freeCapitalToman: number | null;
  reservedInOrdersToman: number;
  committedToPositionsToman: number;
  availableIrtToman: number;
  availableUsdt: number;
  realizedEconomicPnlToman: number;
  realizedRiskAdjustedPnlToman: number;
  realizedCashPnlToman: number;
  unrealizedPnlToman: number | null;
  grossSpreadToman: number;
  todayRealizedPnlToman: number;
  returnPercent: number | null;
  fees: {
    feeToman: number;
    feeUsdtMicros: number;
    feeUsdtValueToman: number | null;
    totalFeeTomanEquivalent: number | null;
    byVenue: Array<{
      sourceId: string;
      feeToman: number;
      feeUsdtMicros: number;
      feeUsdtValueToman: number | null;
      trades: number;
    }>;
    byTrade: Array<{
      id: string;
      lifecycleId: string;
      routeKey: string;
      feeToman: number;
      feeUsdtMicros: number;
      feeUsdtValueToman: number | null;
      occurredAt: string;
    }>;
  };
  venues: Array<{
    sourceId: string;
    irtToman: number;
    usdt: number;
    valuationToman: number | null;
    freeIrtToman: number;
    freeUsdtMicros: number;
    reservedIrtToman: number;
    reservedUsdtMicros: number;
    committedIrtToman: number;
    committedUsdtMicros: number;
    openingIrtToman: number;
    openingUsdtMicros: number;
  }>;
  reconciliation: {
    equityMatchesInitialPlusPnl: boolean | null;
    freePlusReservedPlusCommittedEqualsEquity: boolean | null;
    venueSumEqualsPortfolioEquity: boolean | null;
    feeLedgerSumMatchesBucket: boolean;
  };
  openOrdersNoteFa?: string;
  openPositionsNoteFa?: string;
};

/** Kept for API compatibility; depth is no longer shown on Accounts. */
export type VenueDepthSideView = {
  bestPriceToman: number | null;
  /** Pure market depth USDT (Σ accepted level quantities). */
  rawDepthUsdt: number | null;
  /** Pure market depth toman (Σ price × qty) — not USDT × best. */
  rawDepthToman: number | null;
  levelsAccepted: number | null;
  levelsExcluded: number | null;
  acceptedPriceMin?: number | null;
  acceptedPriceMax?: number | null;
  acceptedLevels?: Array<{ priceToman: number; amountUsdt: number }>;
  smartSizeVwapToman: number | null;
  /** Executable capacity — not market depth. */
  usableCapacityUsdt: number | null;
  usableCapacityToman: number | null;
  limitingKey: string | null;
  limitingLabelFa: string | null;
  reasonFa: string | null;
  unavailable: boolean;
  unavailableFa: string | null;
};

export type VenueDepthCardView = {
  sourceId: string;
  nameFa: string | null;
  marketModel: string;
  asOf: string;
  snapshotAgeMs: number | null;
  buy: VenueDepthSideView;
  sell: VenueDepthSideView;
  smartRecommendedUsdt: number | null;
  smartRouteKey: string | null;
  smartBindingConstraint: string | null;
};

export type ExperimentView = {
  id: string;
  runKey: string;
  status: string;
  policySetKey: string;
  policyFingerprint: string;
  releaseVersion: string;
  startedAt: string;
  endsAt: string;
  startedAtTehran?: string;
  endsAtTehran?: string;
  elapsedMs: number;
  remainingMs: number;
  initialCapitalToman: number;
  targetUtilizationPercent: number;
  maxUtilizationPercent: number;
  minReservePercent: number;
  maxRouteCapitalPercent: number;
  maxVenueExposurePercent: number;
  derivedMaxOrderUsdt: number | null;
  derivedMaxOrderReferencePrice: number | null;
  peakUtilizationPercent: number | null;
  averageUtilizationPercent: number | null;
  sessionId: string | null;
};

type Props = {
  accounting: AccountsAccounting | null;
  /** @deprecated not rendered on Accounts; kept for call-site compatibility */
  venueDepthCards?: VenueDepthCardView[] | null;
  /** @deprecated experiment panel removed; identity still available elsewhere */
  experiment?: ExperimentView | null;
  session: {
    id: string;
    name: string;
    status: string;
    totalCapitalToman: number;
    valuationPriceToman: number;
  } | null;
  loading: boolean;
  serverNow: string | null;
  /** Total evaluated cycles (from cycle summaries). */
  evaluatedCycleCount?: number | null;
};

const DASH = <span className="sa-unknown">—</span>;
const UNAVAILABLE = "Unavailable";

function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "sa-pnl-zero";
  return n > 0 ? "sa-pos" : "sa-neg";
}

export function AccountsSection({
  accounting,
  session,
  loading,
  serverNow,
  evaluatedCycleCount = null
}: Props) {
  if (loading && !accounting && !session) {
    return (
      <div className="panel sa-panel">
        <div className="panel-body">
          <p className="sa-sub">در حال خواندن…</p>
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="sa-stack">
        <section className="panel sa-panel" aria-label="سرمایه و حساب">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">سرمایه و حساب</h3>
          </div>
          <div className="panel-body">
            <p className="sa-sub">
              نشست کاغذی فعال نیست. راه‌اندازی نشست از «تنظیمات» انجام می‌شود.
            </p>
          </div>
        </section>
        <section className="panel sa-panel sa-cycle-card" aria-label="تعداد چرخهٔ ارزیابی">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">تعداد چرخهٔ ارزیابی‌شده</h3>
          </div>
          <div className="panel-body">
            <p className="sa-cycle-count">
              <Bidi>
                {toFaDigits(
                  evaluatedCycleCount !== null && evaluatedCycleCount !== undefined
                    ? evaluatedCycleCount
                    : 0
                )}
              </Bidi>
            </p>
          </div>
        </section>
      </div>
    );
  }

  const a = accounting;

  return (
    <div className="sa-stack">
      <section className="panel sa-panel sa-cycle-card" aria-label="تعداد چرخهٔ ارزیابی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">تعداد چرخهٔ ارزیابی‌شده</h3>
        </div>
        <div className="panel-body">
          <p className="sa-cycle-count">
            <Bidi>
              {toFaDigits(
                evaluatedCycleCount !== null && evaluatedCycleCount !== undefined
                  ? evaluatedCycleCount
                  : 0
              )}
            </Bidi>
          </p>
        </div>
      </section>

      <section className="panel sa-panel sa-port-panel" aria-label="خلاصه پرتفوی کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">خلاصه پرتفوی</h3>
          <div className="sa-panel-note">
            {session.name}
            {" · "}
            {a?.asOf ? formatTehran(a.asOf) : serverNow ? formatTehran(serverNow) : DASH}
          </div>
        </div>
        <div className="panel-body sa-port-body">
          <div className="sa-cards">
            <Kpi
              label="ارزش فعلی"
              tone={a?.returnPercent && a.returnPercent < 0 ? "warn" : "good"}
              hint={`بازده: ${a?.returnPercent ? toFaDigits(a.returnPercent.toFixed(2)) + "٪" : UNAVAILABLE}`}
              value={
                a?.equityToman !== null && a?.equityToman !== undefined ? (
                  <TomanAmount value={a.equityToman} />
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
            <Kpi
              label="سود امروز"
              tone={a?.todayRealizedPnlToman && a.todayRealizedPnlToman < 0 ? "warn" : a?.todayRealizedPnlToman && a.todayRealizedPnlToman > 0 ? "good" : "muted"}
              hint="سود و زیان تحقق‌یافته (امروز)"
              value={
                <span className={pnlClass(a?.todayRealizedPnlToman ?? 0)}>
                  <TomanAmount value={a?.todayRealizedPnlToman ?? 0} />
                </span>
              }
            />
            <Kpi
              label="سرمایهٔ آزاد"
              tone="good"
              hint="مجموع نقدینگی در دسترس"
              value={
                a?.freeCapitalToman !== null && a?.freeCapitalToman !== undefined ? (
                  <TomanAmount value={a.freeCapitalToman} />
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
            <Kpi
              label="درگیر / رزرو"
              tone="muted"
              hint="سرمایه در پوزیشن یا سفارش"
              value={
                <TomanAmount value={(a?.reservedInOrdersToman ?? 0) + (a?.committedToPositionsToman ?? 0)} />
              }
            />
          </div>
        </div>
      </section>

      <section className="panel sa-panel" aria-label="موجودی هر صرافی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">سرمایهٔ هر صرافی</h3>
        </div>
        <div className="panel-body sa-acct-venues">
          {!a?.venues?.length ? (
            <p className="sa-sub">
              {loading
                ? "در حال خواندن…"
                : "موجودی صرافی‌ها در این چرخه در دسترس نیست."}
            </p>
          ) : (
            a.venues.map((v) => (
              <article key={v.sourceId} className="panel sa-panel sa-acct-venue sa-acct-venue-compact">
                <header className="sa-acct-venue-head panel-header sa-panel-header">
                  <div className="sa-acct-venue-id">
                    <strong className="panel-title">{v.sourceId}</strong>
                  </div>
                </header>
                <div className="panel-body sa-acct-venue-body">
                  <div className="sa-bal-metrics" aria-label="موجودی">
                    <div className="sa-bal-metric">
                      <span className="sa-bal-metric-label">IRT</span>
                      <span className="sa-bal-metric-value">
                        <TomanAmount value={v.irtToman} />
                      </span>
                    </div>
                    <div className="sa-bal-metric">
                      <span className="sa-bal-metric-label">USDT</span>
                      <span className="sa-bal-metric-value">
                        <Bidi>{toFaDigits(v.usdt.toFixed(4))}</Bidi>
                      </span>
                    </div>
                    <div className="sa-bal-metric">
                      <span className="sa-bal-metric-label">ارزش کل</span>
                      <span className="sa-bal-metric-value">
                        {v.valuationToman !== null ? (
                          <TomanAmount value={v.valuationToman} />
                        ) : (
                          <span className="sa-unknown" title="قیمت مبنا برای ارزش‌گذاری موجود نیست">
                            {UNAVAILABLE}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="sa-bal-metric">
                      <span className="sa-bal-metric-label">آزاد (IRT · USDT)</span>
                      <span className="sa-bal-metric-value sa-sub">
                        <TomanAmount value={v.freeIrtToman} /> ·{" "}
                        <Bidi>{toFaDigits((v.freeUsdtMicros / 1e6).toFixed(4))}</Bidi>
                      </span>
                    </div>
                    <div className="sa-bal-metric">
                      <span className="sa-bal-metric-label">رزرو (IRT · USDT)</span>
                      <span className="sa-bal-metric-value sa-sub">
                        <TomanAmount value={v.reservedIrtToman} /> ·{" "}
                        <Bidi>{toFaDigits((v.reservedUsdtMicros / 1e6).toFixed(4))}</Bidi>
                      </span>
                    </div>
                    <div className="sa-bal-metric">
                      <span className="sa-bal-metric-label">درگیر (IRT · USDT)</span>
                      <span className="sa-bal-metric-value sa-sub">
                        <TomanAmount value={v.committedIrtToman} /> ·{" "}
                        <Bidi>{toFaDigits((v.committedUsdtMicros / 1e6).toFixed(4))}</Bidi>
                      </span>
                    </div>
                  </div>
                </div>
              </article>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
