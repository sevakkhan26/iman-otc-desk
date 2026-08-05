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

type Props = {
  accounting: AccountsAccounting | null;
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

export function AccountsSection({ accounting, session, loading, serverNow }: Props) {
  const [feeWindow, setFeeWindow] = useState<"today" | "7d" | "30d" | "lifetime">("lifetime");

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
              تخصیص» انجام می‌شود.
            </p>
            <PaperSimple parts={{ session: true, summary: false, ledger: false }} />
          </div>
        </section>
      </div>
    );
  }

  const a = accounting;

  return (
    <div className="sa-stack">
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
          <div className="sa-panel-note">آزاد / رزرو / درگیر — کارگزار فعلی رزرو سفارش ندارد</div>
        </div>
        <div className="panel-body sa-acct-venues">
          {(a?.venues ?? []).map((v) => (
            <article key={v.sourceId} className="sa-acct-venue glass-control">
              <header className="sa-acct-venue-head">
                <strong>{v.sourceId}</strong>
                <span className="sa-chip sa-chip-sm sa-chip-muted">کاغذی</span>
              </header>
              <dl className="sa-acct-venue-grid">
                <div>
                  <dt>IRT</dt>
                  <dd>
                    <TomanAmount value={v.irtToman} />
                  </dd>
                </div>
                <div>
                  <dt>USDT</dt>
                  <dd>
                    <Bidi>{toFaDigits(v.usdt.toFixed(4))}</Bidi>
                  </dd>
                </div>
                <div>
                  <dt>ارزش</dt>
                  <dd>
                    {v.valuationToman !== null ? (
                      <TomanAmount value={v.valuationToman} />
                    ) : (
                      DASH
                    )}
                  </dd>
                </div>
                <div>
                  <dt>آزاد IRT / USDT</dt>
                  <dd className="sa-sub">
                    <TomanAmount value={v.freeIrtToman} /> ·{" "}
                    <Bidi>{toFaDigits((v.freeUsdtMicros / 1e6).toFixed(4))}</Bidi>
                  </dd>
                </div>
                <div>
                  <dt>رزرو / درگیر</dt>
                  <dd className="sa-sub">
                    <Bidi>{toFaDigits(v.reservedIrtToman)}</Bidi> ·{" "}
                    <Bidi>{toFaDigits(v.committedIrtToman)}</Bidi>
                  </dd>
                </div>
              </dl>
            </article>
          ))}
          {!a?.venues?.length ? <p className="sa-sub">موجودی ثبت نشده است.</p> : null}
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
