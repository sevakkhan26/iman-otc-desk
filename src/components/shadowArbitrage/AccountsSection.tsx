"use client";

/**
 * «سرمایه و حساب» — desk accounting from persisted paper.accounting only.
 * Does not re-derive PnL. Missing mark/fees/unrealized render as N/A, never 0.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { Kpi } from "@/components/shadowArbitrage/panelKit";
import { ObservationTelemetry } from "@/components/shadowArbitrage/ObservationTelemetry";
import { SizingWaterfall } from "@/components/shadowArbitrage/SizingWaterfall";
import type { RouteSizingView } from "@/components/shadowArbitrage/CommandCenter";
import type { ShadowOpportunity } from "@/components/shadowArbitrage/types";
import { ExperimentHistoryTable } from "@/components/shadowArbitrage/ExperimentSummary";
import type { ExperimentHistoryRow } from "@/components/shadowArbitrage/sessionLifecycle";

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

export type VenueDepthSideView = {
  bestPriceToman: number | null;
  rawDepthUsdt: number | null;
  rawDepthToman: number | null;
  levelsAccepted: number | null;
  levelsExcluded: number | null;
  acceptedPriceMin?: number | null;
  acceptedPriceMax?: number | null;
  acceptedLevels?: Array<{ priceToman: number; amountUsdt: number }>;
  smartSizeVwapToman: number | null;
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
  summary?: Record<string, unknown> | null;
  configuredDurationDays?: number | null;
  filled?: number | null;
  skipped?: number | null;
  lastFillAt?: string | null;
  lastCycleAt?: string | null;
};

type Props = {
  accounting: AccountsAccounting | null;
  venueDepthCards?: VenueDepthCardView[] | null;
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
  evaluatedCycleCount?: number | null;
  opportunities?: ShadowOpportunity[];
  sizingRoutes?: RouteSizingView[] | null;
  sessionHistory?: ExperimentHistoryRow[];
};

const DASH = <span className="sa-unknown">—</span>;
const UNAVAILABLE = "ناموجود";

function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "sa-pnl-zero";
  return n > 0 ? "sa-pos" : "sa-neg";
}

function kpiTone(n: number | null | undefined): "good" | "warn" | "muted" {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "muted";
  return n > 0 ? "good" : "warn";
}

function pickOptimizerRoute(routes: RouteSizingView[] | null | undefined): RouteSizingView | null {
  if (!routes?.length) return null;
  const sized = routes.filter((r) => r.sizing.status === "SIZED");
  const pool = sized.length ? sized : routes.filter((r) => r.sizing.candidates.length > 0);
  if (!pool.length) return routes[0] ?? null;
  return [...pool].sort((a, b) => {
    const ap = a.sizing.economics?.riskAdjustedPnlToman ?? Number.NEGATIVE_INFINITY;
    const bp = b.sizing.economics?.riskAdjustedPnlToman ?? Number.NEGATIVE_INFINITY;
    return bp - ap;
  })[0] ?? null;
}

export function AccountsSection({
  accounting,
  session,
  loading,
  serverNow,
  evaluatedCycleCount = null,
  opportunities = [],
  sizingRoutes = null,
  sessionHistory = []
}: Props) {
  const optimizer = pickOptimizerRoute(sizingRoutes);

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
            <p className="sa-sub">نشست کاغذی فعال نیست. راه‌اندازی نشست از «تنظیمات» انجام می‌شود.</p>
          </div>
        </section>
      </div>
    );
  }

  const a = accounting;
  const engaged =
    (a?.reservedInOrdersToman ?? 0) + (a?.committedToPositionsToman ?? 0);
  const cycleLabel =
    evaluatedCycleCount !== null && evaluatedCycleCount !== undefined
      ? toFaDigits(evaluatedCycleCount)
      : null;

  return (
    <div className="sa-stack sa-desk">
      <section className="sa-desk-status" aria-label="برچسب حساب">
        <span className="sa-sub">
          as-of{" "}
          {a?.asOf ? formatTehran(a.asOf) : serverNow ? formatTehran(serverNow) : "—"}
        </span>
        {cycleLabel ? (
          <span className="sa-desk-cycle sa-sub" title="شمارندهٔ تلمتری چرخه — نه سود">
            چرخه‌های ارزیابی‌شده: <Bidi>{cycleLabel}</Bidi>
          </span>
        ) : null}
      </section>

      <section className="panel sa-panel sa-port-panel" aria-label="خلاصه پرتفوی کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">حساب میز</h3>
          <div className="sa-panel-note">
            از دفتر حسابداری نشست — صفر ساختگی برای ارزش/کارمزد/تحقق‌نیافته گذاشته نمی‌شود
          </div>
        </div>
        <div className="panel-body sa-port-body">
          <div className="sa-cards sa-desk-kpis">
            <Kpi
              label="ارزش فعلی (حقوق صاحبان)"
              tone={kpiTone(a?.returnPercent ?? null)}
              hint={
                a?.returnPercent !== null && a?.returnPercent !== undefined
                  ? `بازده ${toFaDigits(a.returnPercent.toFixed(2))}٪ · سرمایهٔ اولیه ثبت‌شده`
                  : "بدون قیمت مبنا ارزش‌گذاری نمی‌شود"
              }
              value={
                a?.equityToman !== null && a?.equityToman !== undefined ? (
                  <TomanAmount value={a.equityToman} />
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
            <Kpi
              label="سرمایهٔ آزاد"
              tone="muted"
              hint="نقد قابل استفاده برای خرید جدید"
              value={
                a?.freeCapitalToman !== null && a?.freeCapitalToman !== undefined ? (
                  <TomanAmount value={a.freeCapitalToman} />
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
            <Kpi
              label="سرمایهٔ درگیر"
              tone="muted"
              hint="رزرو سفارش + درگیر پوزیشن؛ کارگزار کاغذی اتمی است و صفر صادقانه است اگر سفارشی باز نباشد"
              value={a ? <TomanAmount value={engaged} /> : <span className="sa-unknown">{UNAVAILABLE}</span>}
            />
            <Kpi
              label="IRT آزاد"
              tone="muted"
              hint="موجودی تومانی قابل خرید"
              value={a ? <TomanAmount value={a.availableIrtToman} /> : <span className="sa-unknown">{UNAVAILABLE}</span>}
            />
            <Kpi
              label="USDT آزاد"
              tone="muted"
              hint="موجودی تتری قابل فروش"
              value={
                a ? (
                  <Bidi>{toFaDigits(a.availableUsdt.toFixed(4))}</Bidi>
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
            <Kpi
              label="سود امروز"
              tone={kpiTone(a?.todayRealizedPnlToman ?? null)}
              hint="تحقق‌یافته از نیمه‌شب — رقم دفتر"
              value={
                a ? (
                  <span className={pnlClass(a.todayRealizedPnlToman)}>
                    <TomanAmount value={a.todayRealizedPnlToman} />
                  </span>
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
            <Kpi
              label="سود تحقق‌یافته (اقتصادی)"
              tone={kpiTone(a?.realizedEconomicPnlToman ?? null)}
              hint="تجمیعی نشست · اقتصاد خالص پس از کارمزد"
              value={
                a ? (
                  <span className={pnlClass(a.realizedEconomicPnlToman)}>
                    <TomanAmount value={a.realizedEconomicPnlToman} />
                  </span>
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
            <Kpi
              label="سود تحقق‌نیافته"
              tone={kpiTone(a?.unrealizedPnlToman ?? null)}
              hint="حقوق صاحبان − اولیه − تحقق‌یافته اقتصادی؛ بدون مبنا محاسبه نمی‌شود"
              value={
                a?.unrealizedPnlToman !== null && a?.unrealizedPnlToman !== undefined ? (
                  <span className={pnlClass(a.unrealizedPnlToman)}>
                    <TomanAmount value={a.unrealizedPnlToman} />
                  </span>
                ) : (
                  <span className="sa-unknown" title="قیمت مبنا در دسترس نیست">
                    {UNAVAILABLE}
                  </span>
                )
              }
            />
            <Kpi
              label="کارمزد پرداخت‌شده"
              tone="muted"
              hint="معادل تومانی کارمزد IRT+USDT در دفتر؛ بدون مبنا برای پایهٔ تتری ناموجود است"
              value={
                a?.fees.totalFeeTomanEquivalent !== null &&
                a?.fees.totalFeeTomanEquivalent !== undefined ? (
                  <TomanAmount value={a.fees.totalFeeTomanEquivalent} />
                ) : (
                  <span className="sa-unknown">{UNAVAILABLE}</span>
                )
              }
            />
          </div>

          <dl className="sa-pnl-triple" aria-label="تفکیک سه سود">
            <div>
              <dt>سود نقدی (IRT)</dt>
              <dd className={pnlClass(a?.realizedCashPnlToman)}>
                {a ? <TomanAmount value={a.realizedCashPnlToman} /> : DASH}
              </dd>
            </div>
            <div>
              <dt>سود اقتصادی خالص</dt>
              <dd className={pnlClass(a?.realizedEconomicPnlToman)}>
                {a ? <TomanAmount value={a.realizedEconomicPnlToman} /> : DASH}
              </dd>
            </div>
            <div>
              <dt>سود تعدیل‌شده با ریسک</dt>
              <dd className={pnlClass(a?.realizedRiskAdjustedPnlToman)}>
                {a ? <TomanAmount value={a.realizedRiskAdjustedPnlToman} /> : DASH}
              </dd>
            </div>
          </dl>
          <p className="sa-sub">
            سرمایهٔ اولیه:{" "}
            <TomanAmount value={a?.initialCapitalToman ?? session.totalCapitalToman} />
            {" · "}
            قیمت مبنا:{" "}
            {a?.markPriceToman ? <TomanAmount value={a.markPriceToman} /> : <span className="sa-unknown">{UNAVAILABLE}</span>}
            {a?.markPriceProvisional ? " (موقت)" : ""}
          </p>
        </div>
      </section>

      <ObservationTelemetry opportunities={opportunities} optimizerRoute={optimizer} />
      <SizingWaterfall route={optimizer} />

      <section className="panel sa-panel" aria-label="موجودی هر صرافی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">سرمایهٔ هر صرافی</h3>
        </div>
        <div className="panel-body sa-acct-venues">
          {!a?.venues?.length ? (
            <p className="sa-sub">
              {loading ? "در حال خواندن…" : "موجودی صرافی‌ها در این چرخه در دسترس نیست."}
            </p>
          ) : (
            a.venues.map((v) => {
              const fee = a.fees.byVenue.find((f) => f.sourceId === v.sourceId);
              return (
                <article key={v.sourceId} className="panel sa-panel sa-acct-venue sa-acct-venue-compact">
                  <header className="sa-acct-venue-head panel-header sa-panel-header">
                    <div className="sa-acct-venue-id">
                      <strong className="panel-title">{v.sourceId}</strong>
                    </div>
                    {fee ? (
                      <span className="sa-sub">
                        {toFaDigits(fee.trades)} معامله · کارمزد{" "}
                        {fee.feeUsdtValueToman !== null ? (
                          <TomanAmount value={fee.feeToman + fee.feeUsdtValueToman} />
                        ) : (
                          <TomanAmount value={fee.feeToman} />
                        )}
                      </span>
                    ) : null}
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
              );
            })
          )}
        </div>
      </section>

      <ExperimentHistoryTable rows={sessionHistory} loading={loading} />
    </div>
  );
}
