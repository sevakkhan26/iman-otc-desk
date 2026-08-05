"use client";

/**
 * «سرمایه و حساب» — virtual balances, P&L and booked Paper fees.
 *
 * Labels these as Paper/virtual only. No real exchange balances or fees.
 */
import { useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { PaperSimple } from "@/components/shadowArbitrage/PaperSimple";

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
};

const DASH = <span className="sa-unknown">—</span>;

function Metric({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sa-acct-metric">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function DepthSide({
  title,
  side
}: {
  title: string;
  side: VenueDepthSideView;
}) {
  const showNa = (v: number | null | undefined, fmt: (n: number) => React.ReactNode) => {
    if (v === null || v === undefined) {
      return (
        <span className="sa-unknown" title={side.unavailableFa ?? side.reasonFa ?? undefined}>
          {side.unavailable ? "ناموجود" : "قابل محاسبه نیست"}
        </span>
      );
    }
    return fmt(v);
  };

  return (
    <div className="sa-depth-side">
      <h4 className="sa-depth-side-title">{title}</h4>
      {side.unavailable && side.unavailableFa ? (
        <p className="sa-sub sa-depth-unavail">{side.unavailableFa}</p>
      ) : null}
      <dl className="sa-depth-side-grid">
        <div>
          <dt>بهترین قیمت</dt>
          <dd>
            {showNa(side.bestPriceToman, (n) => (
              <TomanAmount value={n} />
            ))}
          </dd>
        </div>
        <div>
          <dt>عمق خام (USDT)</dt>
          <dd>
            {showNa(side.rawDepthUsdt, (n) => (
              <Bidi>{toFaDigits(n.toFixed(4))}</Bidi>
            ))}
          </dd>
        </div>
        <div>
          <dt>عمق خام (تومان)</dt>
          <dd>
            {showNa(side.rawDepthToman, (n) => (
              <TomanAmount value={n} />
            ))}
          </dd>
        </div>
        <div>
          <dt>سطوح پذیرفته</dt>
          <dd>
            {showNa(side.levelsAccepted, (n) => (
              <Bidi>{toFaDigits(n)}</Bidi>
            ))}
            {side.levelsExcluded !== null && side.levelsExcluded > 0 ? (
              <span className="sa-sub">
                {" "}
                (خارج از لغزش: <Bidi>{toFaDigits(side.levelsExcluded)}</Bidi>)
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>VWAP حجم هوشمند</dt>
          <dd>
            {showNa(side.smartSizeVwapToman, (n) => (
              <TomanAmount value={n} />
            ))}
          </dd>
        </div>
        <div>
          <dt>ظرفیت قابل استفاده</dt>
          <dd>
            {showNa(side.usableCapacityUsdt, (n) => (
              <>
                <Bidi>{toFaDigits(n.toFixed(4))}</Bidi> USDT
                {side.usableCapacityToman !== null ? (
                  <>
                    {" "}
                    · <TomanAmount value={side.usableCapacityToman} />
                  </>
                ) : null}
              </>
            ))}
          </dd>
        </div>
        <div className="sa-depth-side-full">
          <dt>محدودکننده</dt>
          <dd className="sa-sub">
            {side.limitingLabelFa ?? side.reasonFa ?? DASH}
          </dd>
        </div>
      </dl>
    </div>
  );
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m ${sec}s`;
  return `${h}h ${m}m ${sec}s`;
}

export function AccountsSection({
  accounting,
  venueDepthCards,
  experiment,
  session,
  loading,
  serverNow
}: Props) {
  const [feeWindow, setFeeWindow] = useState<"today" | "7d" | "30d" | "lifetime">("lifetime");
  const depthById = useMemo(() => {
    const m = new Map<string, VenueDepthCardView>();
    for (const c of venueDepthCards ?? []) m.set(c.sourceId, c);
    return m;
  }, [venueDepthCards]);

  const feeTrades = useMemo(() => {
    if (!accounting) return [];
    const now = serverNow ? Date.parse(serverNow) : Date.now();
    const list = accounting.fees.byTrade;
    if (feeWindow === "lifetime") return list;
    if (feeWindow === "today") {
      // Server already uses Tehran day for today PnL; for fees, filter by 24h/window loosely via calendar day UTC offset is wrong — use last N ms.
      const start = now - (now % 86_400_000);
      return list.filter((t) => Date.parse(t.occurredAt) >= start);
    }
    const ms = feeWindow === "7d" ? 7 * 86_400_000 : 30 * 86_400_000;
    return list.filter((t) => now - Date.parse(t.occurredAt) <= ms);
  }, [accounting, feeWindow, serverNow]);

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
        <section className="panel sa-panel" aria-label="نشست کاغذی">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">سرمایه و حساب</h3>
            <div className="sa-panel-note">موجودی و سود مجازی — نه موجودی واقعی صرافی</div>
          </div>
          <div className="panel-body">
            <p className="sa-sub">
              هنوز نشست کاغذی فعالی نیست. ایجاد و شروع نشست از «تنظیمات ← سرمایه و
              تخصیص» انجام می‌شود. عمق بازار زیر، از همان چرخهٔ جمع‌آوری خوانده می‌شود.
            </p>
            <PaperSimple parts={{ session: true, summary: false, ledger: false }} />
          </div>
        </section>
        {(venueDepthCards?.length ?? 0) > 0 ? (
          <section className="panel sa-panel" aria-label="عمق بازار بدون نشست">
            <div className="panel-header sa-panel-header">
              <h3 className="panel-title">عمق و ظرفیت بازار (بدون نشست)</h3>
              <div className="sa-panel-note">موجودی صفر است تا نشست باز شود</div>
            </div>
            <div className="panel-body sa-acct-venues">
              {(venueDepthCards ?? []).map((depth) => (
                <article key={depth.sourceId} className="panel sa-panel sa-acct-venue">
                  <header className="sa-acct-venue-head panel-header sa-panel-header">
                    <div>
                      <strong className="panel-title">{depth.nameFa ?? depth.sourceId}</strong>
                      <span className="sa-ps-key">{depth.sourceId}</span>
                    </div>
                    <span className="sa-chip sa-chip-sm sa-chip-muted">بدون موجودی نشست</span>
                  </header>
                  <div className="panel-body sa-acct-venue-body">
                    <div className="sa-depth-block" aria-label="عمق و ظرفیت بازار">
                      <div className="sa-depth-block-title">عمق و ظرفیت بازار</div>
                      <div className="sa-depth-sides">
                        <DepthSide title="خرید از صرافی" side={depth.buy} />
                        <DepthSide title="فروش به صرافی" side={depth.sell} />
                      </div>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    );
  }

  const a = accounting;

  return (
    <div className="sa-stack">
      {experiment ? (
        <section className="panel sa-panel" aria-label="آزمایش چهارروزه">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">آزمایش Paper چهارروزه</h3>
            <div className="sa-panel-note">
              {experiment.status} · {experiment.policySetKey}
            </div>
          </div>
          <div className="panel-body">
            <dl className="sa-acct-grid">
              <Metric label="runId">
                <span className="sa-ps-key">{experiment.id}</span>
              </Metric>
              <Metric label="شروع (Tehran)">
                {experiment.startedAtTehran ?? formatTehran(experiment.startedAt)}
              </Metric>
              <Metric label="پایان (Tehran)">
                {experiment.endsAtTehran ?? formatTehran(experiment.endsAt)}
              </Metric>
              <Metric label="باقی‌مانده">
                <Bidi>{fmtDuration(experiment.remainingMs)}</Bidi>
              </Metric>
              <Metric label="هدف استفاده">
                <Bidi>{toFaDigits(experiment.targetUtilizationPercent)}٪</Bidi>
              </Metric>
              <Metric label="سقف سخت استفاده">
                <Bidi>{toFaDigits(experiment.maxUtilizationPercent)}٪</Bidi>
              </Metric>
              <Metric label="کف نقدینگی آزاد">
                <Bidi>{toFaDigits(experiment.minReservePercent)}٪</Bidi>
              </Metric>
              <Metric label="سقف مسیر / صرافی">
                <Bidi>
                  {toFaDigits(experiment.maxRouteCapitalPercent)}٪ /{" "}
                  {toFaDigits(experiment.maxVenueExposurePercent)}٪
                </Bidi>
              </Metric>
              <Metric label="سقف USDT مشتق‌شده">
                {experiment.derivedMaxOrderUsdt !== null ? (
                  <Bidi>{toFaDigits(experiment.derivedMaxOrderUsdt)}</Bidi>
                ) : (
                  DASH
                )}
              </Metric>
              <Metric label="اوج / میانگین استفاده">
                <Bidi>
                  {experiment.peakUtilizationPercent !== null
                    ? toFaDigits(Number(experiment.peakUtilizationPercent).toFixed(2))
                    : "—"}
                  ٪ /{" "}
                  {experiment.averageUtilizationPercent !== null
                    ? toFaDigits(Number(experiment.averageUtilizationPercent).toFixed(2))
                    : "—"}
                  ٪
                </Bidi>
              </Metric>
              <Metric label="سرمایهٔ اولیه">
                <TomanAmount value={experiment.initialCapitalToman} />
              </Metric>
              <Metric label="نسخه انتشار">
                <Bidi>{experiment.releaseVersion}</Bidi>
              </Metric>
            </dl>
            <p className="sa-sub">
              UTC start: {experiment.startedAt} · UTC end: {experiment.endsAt} · fingerprint:{" "}
              <span className="sa-ps-key">{experiment.policyFingerprint}</span>
            </p>
          </div>
        </section>
      ) : null}

      <section className="panel sa-panel" aria-label="خلاصه پرتفوی کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">سرمایه و حساب (کاغذی)</h3>
          <div className="sa-panel-note">
            مجازی · {session.name} ·{" "}
            {a?.asOf ? formatTehran(a.asOf) : serverNow ? formatTehran(serverNow) : DASH}
          </div>
        </div>
        <div className="panel-body">
          <dl className="sa-acct-grid">
            <Metric label="سرمایهٔ اولیه">
              <TomanAmount value={a?.initialCapitalToman ?? session.totalCapitalToman} />
            </Metric>
            <Metric label="ارزش فعلی (equity)">
              {a?.equityToman !== null && a?.equityToman !== undefined ? (
                <TomanAmount value={a.equityToman} />
              ) : (
                <span className="sa-unknown">نامشخص (قیمت مبنا)</span>
              )}
            </Metric>
            <Metric label="سرمایهٔ آزاد">
              {a?.freeCapitalToman !== null && a?.freeCapitalToman !== undefined ? (
                <TomanAmount value={a.freeCapitalToman} />
              ) : (
                DASH
              )}
            </Metric>
            <Metric label="رزرو سفارش باز">
              <TomanAmount value={a?.reservedInOrdersToman ?? 0} />
            </Metric>
            <Metric label="درگیر پوزیشن باز">
              <TomanAmount value={a?.committedToPositionsToman ?? 0} />
            </Metric>
            <Metric label="IRT آزاد">
              <TomanAmount value={a?.availableIrtToman ?? 0} />
            </Metric>
            <Metric label="USDT آزاد">
              <Bidi>{toFaDigits((a?.availableUsdt ?? 0).toFixed(4))}</Bidi>
            </Metric>
            <Metric label="سود تحقق‌یافته (اقتصادی)">
              <TomanAmount value={a?.realizedEconomicPnlToman ?? 0} />
            </Metric>
            <Metric label="سود تحقق‌نیافته">
              {a?.unrealizedPnlToman !== null && a?.unrealizedPnlToman !== undefined ? (
                <TomanAmount value={a.unrealizedPnlToman} />
              ) : (
                <span className="sa-unknown">نامشخص</span>
              )}
            </Metric>
            <Metric label="سود امروز">
              <TomanAmount value={a?.todayRealizedPnlToman ?? 0} />
            </Metric>
            <Metric label="بازده">
              {a?.returnPercent !== null && a?.returnPercent !== undefined ? (
                <Bidi>{toFaDigits(a.returnPercent.toFixed(2))}٪</Bidi>
              ) : (
                DASH
              )}
            </Metric>
            <Metric label="قیمت مبنای تتر">
              {a?.markPriceToman ? (
                <TomanAmount value={a.markPriceToman} />
              ) : (
                <span className="sa-unknown">نامشخص</span>
              )}
            </Metric>
          </dl>
          {a?.reconciliation ? (
            <p className="sa-sub sa-acct-recon">
              تطبیق حساب: equity{" "}
              {a.reconciliation.equityMatchesInitialPlusPnl === false ? "ناموفق" : "OK"} ·
              تقسیم سرمایه{" "}
              {a.reconciliation.freePlusReservedPlusCommittedEqualsEquity === false
                ? "ناموفق"
                : "OK"}{" "}
              · جمع صرافی‌ها{" "}
              {a.reconciliation.venueSumEqualsPortfolioEquity === false ? "ناموفق" : "OK"} ·
              کارمزد {a.reconciliation.feeLedgerSumMatchesBucket ? "OK" : "ناموفق"}
            </p>
          ) : null}
        </div>
      </section>

      <section className="panel sa-panel" aria-label="موجودی مجازی صرافی‌ها">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">موجودی مجازی هر صرافی</h3>
          <div className="sa-panel-note">
            موجودی کاغذی ≠ عمق بازار · ظرفیت = min(عمق، موجودی، سیاست‌ها)
          </div>
        </div>
        <div className="panel-body sa-acct-venues">
          {(() => {
            /*
             * Prefer accounting venues (with balances). If the session has none
             * yet, still render depth cards so market depth is never hidden
             * behind an empty balance state.
             */
            const balRows =
              a?.venues?.length
                ? a.venues
                : (venueDepthCards ?? []).map((d) => ({
                    sourceId: d.sourceId,
                    irtToman: 0,
                    usdt: 0,
                    valuationToman: null as number | null,
                    freeIrtToman: 0,
                    freeUsdtMicros: 0,
                    reservedIrtToman: 0,
                    reservedUsdtMicros: 0,
                    committedIrtToman: 0,
                    committedUsdtMicros: 0,
                    openingIrtToman: 0,
                    openingUsdtMicros: 0
                  }));
            if (!balRows.length) {
              return <p className="sa-sub">موجودی و عمق این چرخه در دسترس نیست.</p>;
            }
            return balRows.map((v) => {
              const depth = depthById.get(v.sourceId);
              return (
                <article key={v.sourceId} className="panel sa-panel sa-acct-venue">
                  <header className="sa-acct-venue-head panel-header sa-panel-header">
                    <div>
                      <strong className="panel-title">
                        {depth?.nameFa ?? v.sourceId}
                      </strong>
                      <span className="sa-ps-key">{v.sourceId}</span>
                    </div>
                    <div className="sa-acct-venue-chips">
                      <span className="sa-chip sa-chip-sm sa-chip-muted">موجودی کاغذی</span>
                      {depth?.snapshotAgeMs !== null && depth?.snapshotAgeMs !== undefined ? (
                        <span className="sa-chip sa-chip-sm sa-chip-muted">
                          سن: <Bidi>{toFaDigits(Math.round(depth.snapshotAgeMs / 1000))}</Bidi>s
                        </span>
                      ) : null}
                    </div>
                  </header>
                  <div className="panel-body sa-acct-venue-body">
                    <dl className="sa-acct-venue-grid" aria-label="موجودی">
                      <div>
                        <dt>موجودی IRT</dt>
                        <dd>
                          <TomanAmount value={v.irtToman} />
                        </dd>
                      </div>
                      <div>
                        <dt>موجودی USDT</dt>
                        <dd>
                          <Bidi>{toFaDigits(v.usdt.toFixed(4))}</Bidi>
                        </dd>
                      </div>
                      <div>
                        <dt>ارزش کل</dt>
                        <dd>
                          {v.valuationToman !== null ? (
                            <TomanAmount value={v.valuationToman} />
                          ) : (
                            DASH
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>آزاد IRT · USDT</dt>
                        <dd className="sa-sub">
                          <TomanAmount value={v.freeIrtToman} /> ·{" "}
                          <Bidi>{toFaDigits((v.freeUsdtMicros / 1e6).toFixed(4))}</Bidi>
                        </dd>
                      </div>
                      <div>
                        <dt>رزرو · درگیر</dt>
                        <dd className="sa-sub">
                          <Bidi>{toFaDigits(v.reservedIrtToman)}</Bidi> ·{" "}
                          <Bidi>{toFaDigits(v.committedIrtToman)}</Bidi>
                        </dd>
                      </div>
                      <div>
                        <dt>حجم پیشنهادی (SMART)</dt>
                        <dd>
                          {depth?.smartRecommendedUsdt !== null &&
                          depth?.smartRecommendedUsdt !== undefined ? (
                            <Bidi>{toFaDigits(depth.smartRecommendedUsdt.toFixed(4))} USDT</Bidi>
                          ) : (
                            <span className="sa-unknown">—</span>
                          )}
                          {depth?.smartBindingConstraint ? (
                            <span className="sa-reason">{depth.smartBindingConstraint}</span>
                          ) : null}
                        </dd>
                      </div>
                    </dl>

                    <div className="sa-depth-block" aria-label="عمق و ظرفیت بازار">
                      <div className="sa-depth-block-title">عمق و ظرفیت بازار</div>
                      <p className="sa-sub sa-depth-legend">
                        عمق = نقدینگی دفتر در پنجرهٔ لغزش · ظرفیت = پس از موجودی و سقف‌های سیاست
                      </p>
                      {depth ? (
                        <div className="sa-depth-sides">
                          <DepthSide title="خرید از صرافی" side={depth.buy} />
                          <DepthSide title="فروش به صرافی" side={depth.sell} />
                        </div>
                      ) : (
                        <p className="sa-sub">
                          عمق این چرخه در دسترس نیست — موجودی بالا موجودی کاغذی است، نه نقدینگی
                          بازار.
                        </p>
                      )}
                      {depth ? (
                        <details className="sa-advanced-details sa-depth-details">
                          <summary className="sa-panel-note">شواهد فنی این کارت</summary>
                          <p className="sa-sub">
                            مدل: {depth.marketModel} · as-of: {formatTehran(depth.asOf)}
                            {depth.smartRouteKey ? ` · مسیر: ${depth.smartRouteKey}` : ""}
                          </p>
                        </details>
                      ) : null}
                    </div>
                  </div>
                </article>
              );
            });
          })()}
        </div>
      </section>

      <section className="panel sa-panel" aria-label="کارمزدهای ثبت‌شده">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">کارمزدهای ثبت‌شده (دفتر)</h3>
          <div className="sa-panel-note">کارمزد مدل‌شده روی fill — نه کارمزد واقعی پرداخت‌شده به صرافی</div>
        </div>
        <div className="panel-body">
          <div className="sa-ad-filters">
            {(
              [
                ["lifetime", "کل دوره"],
                ["today", "امروز"],
                ["7d", "۷ روز"],
                ["30d", "۳۰ روز"]
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`sa-seg${feeWindow === id ? " is-active glass-control" : ""}`}
                onClick={() => setFeeWindow(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <dl className="sa-acct-grid sa-acct-grid-sm">
            <Metric label="کارمزد IRT">
              <TomanAmount value={a?.fees.feeToman ?? 0} />
            </Metric>
            <Metric label="کارمزد USDT">
              <Bidi>
                {toFaDigits(((a?.fees.feeUsdtMicros ?? 0) / 1e6).toFixed(6))}
              </Bidi>
            </Metric>
            <Metric label="معادل تومانی کل">
              {a?.fees.totalFeeTomanEquivalent !== null &&
              a?.fees.totalFeeTomanEquivalent !== undefined ? (
                <TomanAmount value={a.fees.totalFeeTomanEquivalent} />
              ) : (
                <span className="sa-unknown">نامشخص</span>
              )}
            </Metric>
          </dl>
          <div className="sa-table-wrap sa-ps-desktop">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>صرافی</th>
                  <th className="num">IRT</th>
                  <th className="num">USDT</th>
                  <th className="num">معاملات</th>
                </tr>
              </thead>
              <tbody>
                {(a?.fees.byVenue ?? []).map((v) => (
                  <tr key={v.sourceId}>
                    <td>{v.sourceId}</td>
                    <td className="num">
                      <TomanAmount value={v.feeToman} />
                    </td>
                    <td className="num">
                      <Bidi>{toFaDigits((v.feeUsdtMicros / 1e6).toFixed(6))}</Bidi>
                    </td>
                    <td className="num">
                      <Bidi>{toFaDigits(v.trades)}</Bidi>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="sa-advanced-details">
            <summary className="sa-panel-note">جزئیات کارمزد به ازای معامله ({feeTrades.length})</summary>
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>مسیر</th>
                    <th className="num">IRT</th>
                    <th className="num">USDT</th>
                    <th>زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {feeTrades.slice(0, 100).map((t) => (
                    <tr key={t.id}>
                      <td className="sa-sub">{t.routeKey}</td>
                      <td className="num">
                        <TomanAmount value={t.feeToman} />
                      </td>
                      <td className="num">
                        <Bidi>{toFaDigits((t.feeUsdtMicros / 1e6).toFixed(6))}</Bidi>
                      </td>
                      <td className="sa-sub">{formatTehran(t.occurredAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
      </section>

      <details className="panel sa-panel sa-advanced-details">
        <summary className="panel-header sa-panel-header">
          <span className="panel-title">کنترل نشست کاغذی</span>
          <span className="sa-panel-note">ایجاد / شروع / توقف — بدون سفارش واقعی</span>
        </summary>
        <div className="panel-body">
          <PaperSimple parts={{ session: true, summary: true, ledger: false }} />
        </div>
      </details>
    </div>
  );
}
