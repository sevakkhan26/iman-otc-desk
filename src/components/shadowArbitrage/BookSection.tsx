"use client";

/**
 * «سفارش‌ها و پوزیشن‌ها» — open book + closed Paper trades.
 *
 * Open orders/positions are empty when the broker completes fills immediately.
 * Closed trades come only from immutable FILLED ledger rows.
 * Trade details are read-only presentation of already-persisted ledger fields.
 */
import { useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { TradeDetailsPanel } from "@/components/shadowArbitrage/TradeDetailsPanel";
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";
import type { ClosedTradeEvidence } from "@/lib/shadowArbitrage/paper/tradeDetailsView";
import {
  UNCOMPUTABLE_FA,
  experimentTotalsCoverage,
  summarizeTradeSet,
  type TradeSetSummary
} from "@/lib/shadowArbitrage/paper/tradeProfitability";

/** Closed trade row — subset of the paper ledger API payload (no client inventing). */
export type ClosedTradeRow = ClosedTradeEvidence;

export type BookExperimentContext = {
  experimentId?: string | null;
  policyFingerprint?: string | null;
  releaseVersion?: string | null;
};

type Props = {
  openOrdersNoteFa: string;
  openPositionsNoteFa: string;
  closedTrades: ClosedTradeRow[];
  loading: boolean;
  /**
   * Server-side count of FILLED ledger rows when known (stats.filled or count).
   * Used only to decide whether loaded rows can represent the full experiment.
   */
  serverFilledCount?: number | null;
  /** Optional experiment identity for technical evidence only. */
  experimentContext?: BookExperimentContext | null;
};

const DASH = <span className="sa-unknown">—</span>;

function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "sa-pnl-zero";
  return n > 0 ? "sa-pnl-pos" : "sa-pnl-neg";
}

function MoneyTR({ toman }: { toman: number }) {
  return (
    <span className={pnlClass(toman)}>
      <TomanAmount value={toman} />
      <span className="sa-sub">
        {" "}
        · <Bidi>{toFaDigits(Math.round(toman * 10).toLocaleString("en-US"))}</Bidi> ریال
      </span>
    </span>
  );
}

function SummaryCard({
  title,
  summary,
  note
}: {
  title: string;
  summary: TradeSetSummary;
  note?: string | null;
}) {
  return (
    <div className="sa-td-summary panel sa-panel">
      <div className="panel-header sa-panel-header">
        <h4 className="panel-title">{title}</h4>
      </div>
      <div className="panel-body">
        {note ? (
          <p className="sa-callout sa-callout-warn" role="status">
            {note}
          </p>
        ) : null}
        <dl className="sa-td-grid sa-td-summary-grid">
          <div className="sa-td-row">
            <dt>تعداد معاملات تکمیل‌شده</dt>
            <dd>
              <Bidi>{toFaDigits(summary.tradeCount)}</Bidi>
            </dd>
          </div>
          <div className="sa-td-row">
            <dt>حجم کل (USDT، یک‌بار به‌ازای هر معامله)</dt>
            <dd>
              <Bidi>{toFaDigits(summary.volumeUsdt.toFixed(4))}</Bidi>
            </dd>
          </div>
          <div className="sa-td-row">
            <dt>سود ناخالص کل</dt>
            <dd>
              {summary.grossProfit.ok ? (
                <MoneyTR toman={summary.grossProfit.money.toman} />
              ) : (
                <span className="sa-unknown" title={summary.grossProfit.reasonFa}>
                  {UNCOMPUTABLE_FA}
                </span>
              )}
            </dd>
          </div>
          <div className="sa-td-row">
            <dt>مجموع کارمزد</dt>
            <dd>
              {summary.totalFees.ok ? (
                <MoneyTR toman={summary.totalFees.money.toman} />
              ) : (
                <span className="sa-unknown" title={summary.totalFees.reasonFa}>
                  {UNCOMPUTABLE_FA}
                </span>
              )}
            </dd>
          </div>
          <div className="sa-td-row sa-td-row-highlight">
            <dt>سود اقتصادی خالص کل</dt>
            <dd>
              {summary.economicNet.ok ? (
                <MoneyTR toman={summary.economicNet.money.toman} />
              ) : (
                <span className="sa-unknown" title={summary.economicNet.reasonFa}>
                  {UNCOMPUTABLE_FA}
                </span>
              )}
            </dd>
          </div>
          <div className="sa-td-row">
            <dt>سود به‌ازای هر ۱ تتر</dt>
            <dd>
              {summary.profitPerUsdt.ok ? (
                <MoneyTR toman={summary.profitPerUsdt.money.toman} />
              ) : (
                <span className="sa-unknown" title={summary.profitPerUsdt.reasonFa}>
                  {UNCOMPUTABLE_FA}
                </span>
              )}
            </dd>
          </div>
          <div className="sa-td-row">
            <dt>بازده خالص کل</dt>
            <dd>
              {summary.netReturn.ok ? (
                <span className={pnlClass(summary.netReturn.percent)}>
                  <Bidi>{toFaDigits(summary.netReturn.percent.toFixed(4))}٪</Bidi>
                  {" · "}
                  <Bidi>{toFaDigits(summary.netReturn.bps.toFixed(2))}</Bidi> bps
                </span>
              ) : (
                <span className="sa-unknown" title={summary.netReturn.reasonFa}>
                  {UNCOMPUTABLE_FA}
                </span>
              )}
            </dd>
          </div>
          <div className="sa-td-row">
            <dt>سودده / زیان‌ده / صفر</dt>
            <dd>
              <Bidi>{toFaDigits(summary.profitableCount)}</Bidi>
              {" / "}
              <Bidi>{toFaDigits(summary.losingCount)}</Bidi>
              {" / "}
              <Bidi>{toFaDigits(summary.zeroCount)}</Bidi>
            </dd>
          </div>
        </dl>
      </div>
    </div>
  );
}

export function BookSection({
  openOrdersNoteFa,
  openPositionsNoteFa,
  closedTrades,
  loading,
  serverFilledCount = null,
  experimentContext
}: Props) {
  const { read, write } = useShadowViewState();
  const venue = read("bv", "all");
  const page = readInt(read("bp", "1"), 1, 1, 10_000);
  const perPage = 20;
  const [openId, setOpenId] = useState<string | null>(null);

  const venues = useMemo(() => {
    const s = new Set<string>();
    for (const t of closedTrades) {
      s.add(t.buySourceId);
      s.add(t.sellSourceId);
    }
    return [...s].sort();
  }, [closedTrades]);

  const filtered = useMemo(
    () =>
      closedTrades.filter(
        (t) => venue === "all" || t.buySourceId === venue || t.sellSourceId === venue
      ),
    [closedTrades, venue]
  );

  const filterSummary = useMemo(() => summarizeTradeSet(filtered), [filtered]);

  const experimentCoverage = useMemo(
    () =>
      experimentTotalsCoverage({
        loadedFilledCount: closedTrades.length,
        serverFilledCount: serverFilledCount ?? null
      }),
    [closedTrades.length, serverFilledCount]
  );

  const experimentSummary = useMemo(() => {
    if (!experimentCoverage.complete) return null;
    return summarizeTradeSet(closedTrades);
  }, [closedTrades, experimentCoverage.complete]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const shown = filtered.slice((safePage - 1) * perPage, safePage * perPage);
  const openTrade = openId ? closedTrades.find((t) => t.id === openId) ?? null : null;

  const toggleDetails = (id: string) => {
    setOpenId((cur) => (cur === id ? null : id));
  };

  return (
    <div className="sa-stack">
      <section className="panel sa-panel" aria-label="سفارش‌های باز کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">سفارش‌های باز کاغذی</h3>
          <div className="sa-panel-note">فقط از دفتر پایدار — بدون ساختن سفارش ساختگی</div>
        </div>
        <div className="panel-body">
          <div className="sa-callout sa-callout-muted" role="status">
            <Bidi>{toFaDigits(0)}</Bidi> سفارش باز
          </div>
          <p className="sa-sub">{openOrdersNoteFa}</p>
        </div>
      </section>

      <section className="panel sa-panel" aria-label="پوزیشن‌های باز کاغذی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">پوزیشن‌های باز کاغذی</h3>
          <div className="sa-panel-note">فقط وقتی در دفتر ثبت شده باشد</div>
        </div>
        <div className="panel-body">
          <div className="sa-callout sa-callout-muted" role="status">
            <Bidi>{toFaDigits(0)}</Bidi> پوزیشن باز
          </div>
          <p className="sa-sub">{openPositionsNoteFa}</p>
        </div>
      </section>

      <section className="panel sa-panel" aria-label="معاملات بسته‌شده">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">معاملات و پوزیشن‌های بسته‌شده</h3>
          <div className="sa-panel-note">
            <Bidi>
              {toFaDigits(filtered.length)} از {toFaDigits(closedTrades.length)}
            </Bidi>{" "}
            · تاریخچهٔ غیرقابل‌حذف
          </div>
        </div>
        <div className="panel-body sa-stack">
          <div className="sa-td-summary-row">
            <SummaryCard
              title="خلاصه فیلتر فعلی"
              summary={filterSummary}
              note={
                venue === "all"
                  ? `همهٔ ${filtered.length} معاملهٔ بارگذاری‌شده (نه فقط صفحهٔ جاری).`
                  : `فیلتر صرافی «${venue}» — ${filtered.length} معامله (نه فقط صفحهٔ جاری).`
              }
            />
            {experimentSummary ? (
              <SummaryCard
                title="خلاصه کل آزمایش چهارروزه"
                summary={experimentSummary}
                note="جمع روی تمام معاملات FILLED بارگذاری‌شده که با شمارندهٔ سرور هم‌خوان است."
              />
            ) : (
              <div className="sa-td-summary panel sa-panel">
                <div className="panel-header sa-panel-header">
                  <h4 className="panel-title">خلاصه کل آزمایش چهارروزه</h4>
                </div>
                <div className="panel-body">
                  <p className="sa-callout sa-callout-warn" role="status">
                    {experimentCoverage.gapFa ??
                      "جمع کل آزمایش به‌صورت امن قابل اعلام نیست."}
                  </p>
                  <p className="sa-sub">
                    بارگذاری‌شده: <Bidi>{toFaDigits(experimentCoverage.loadedFilledCount)}</Bidi>
                    {experimentCoverage.serverFilledCount !== null ? (
                      <>
                        {" "}
                        از{" "}
                        <Bidi>{toFaDigits(experimentCoverage.serverFilledCount)}</Bidi> (شمارندهٔ
                        سرور)
                      </>
                    ) : null}
                    . جمع جزئی به‌عنوان «کل آزمایش» نشان داده نمی‌شود.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="sa-ad-filters">
            <label className="sa-field">
              <span className="sa-field-label">صرافی</span>
              <select
                className="sa-control"
                value={venue}
                onChange={(e) => write({ bv: e.target.value, bp: "1" })}
              >
                <option value="all">همه</option>
                {venues.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {loading && !closedTrades.length ? (
            <p className="sa-sub">در حال خواندن…</p>
          ) : null}

          {shown.length ? (
            <>
              <div className="sa-table-wrap sa-ad-desktop">
                <table className="sa-table">
                  <thead>
                    <tr>
                      <th>مسیر</th>
                      <th className="num">حجم</th>
                      <th className="num">VWAP</th>
                      <th className="num">ناخالص</th>
                      <th className="num">کارمزد</th>
                      <th className="num">خالص اقتصادی</th>
                      <th>زمان</th>
                      <th>جزئیات</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((t) => (
                      <tr key={t.id}>
                        <td>
                          {t.buySourceId} ← {t.sellSourceId}
                          {t.sizingPolicy ? (
                            <span className="sa-reason">{t.sizingPolicy}</span>
                          ) : null}
                        </td>
                        <td className="num">
                          <Bidi>{toFaDigits(t.sizeUsdt.toFixed(4))}</Bidi>
                        </td>
                        <td className="num">
                          {t.buyVwapToman !== null && t.sellVwapToman !== null ? (
                            <Bidi>
                              {toFaDigits(t.buyVwapToman.toLocaleString("en-US"))} ↤{" "}
                              {toFaDigits(t.sellVwapToman.toLocaleString("en-US"))}
                            </Bidi>
                          ) : (
                            DASH
                          )}
                        </td>
                        <td className="num">
                          {t.grossSpreadToman !== null ? (
                            <TomanAmount value={t.grossSpreadToman} />
                          ) : (
                            DASH
                          )}
                        </td>
                        <td className="num">
                          {t.feeTomanTotal !== null ? (
                            <TomanAmount value={t.feeTomanTotal} />
                          ) : (
                            DASH
                          )}
                          {t.feeUsdtMicrosTotal ? (
                            <span className="sa-sub">
                              {" "}
                              +{" "}
                              <Bidi>
                                {toFaDigits((t.feeUsdtMicrosTotal / 1e6).toFixed(4))} USDT
                              </Bidi>
                            </span>
                          ) : null}
                        </td>
                        <td className="num">
                          {t.economicNetPnlToman !== null ? (
                            <TomanAmount value={t.economicNetPnlToman} />
                          ) : (
                            <span className="sa-unknown">نامشخص</span>
                          )}
                        </td>
                        <td className="sa-sub">{formatTehran(t.occurredAt)}</td>
                        <td>
                          <button
                            type="button"
                            className="sa-btn sa-btn-ghost sa-td-open-btn"
                            aria-expanded={openId === t.id}
                            onClick={() => toggleDetails(t.id)}
                          >
                            جزئیات معامله
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="sa-ad-cards">
                {shown.map((t) => (
                  <li key={t.id} className="sa-ad-card">
                    <div className="sa-ad-card-head">
                      <span className="sa-ad-card-title">
                        {t.buySourceId} ← {t.sellSourceId}
                      </span>
                      {t.economicNetPnlToman !== null ? (
                        <TomanAmount value={t.economicNetPnlToman} />
                      ) : (
                        DASH
                      )}
                    </div>
                    <p className="sa-sub">
                      <Bidi>{toFaDigits(t.sizeUsdt.toFixed(4))}</Bidi> تتر ·{" "}
                      {formatTehran(t.occurredAt)}
                    </p>
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost sa-td-open-btn"
                      aria-expanded={openId === t.id}
                      onClick={() => toggleDetails(t.id)}
                    >
                      جزئیات معامله
                    </button>
                  </li>
                ))}
              </ul>

              {openTrade ? (
                <TradeDetailsPanel
                  trade={openTrade}
                  context={{
                    experimentId: experimentContext?.experimentId ?? null,
                    policyFingerprint: experimentContext?.policyFingerprint ?? null,
                    releaseVersion: experimentContext?.releaseVersion ?? null
                  }}
                  open
                  onClose={() => setOpenId(null)}
                />
              ) : null}

              <div className="sa-ad-filters">
                <button
                  type="button"
                  className="sa-btn sa-btn-ghost"
                  disabled={safePage <= 1}
                  onClick={() => write({ bp: String(safePage - 1) })}
                >
                  قبلی
                </button>
                <span className="sa-sub">
                  صفحه <Bidi>{toFaDigits(safePage)}</Bidi> از{" "}
                  <Bidi>{toFaDigits(totalPages)}</Bidi>
                </span>
                <button
                  type="button"
                  className="sa-btn sa-btn-ghost"
                  disabled={safePage >= totalPages}
                  onClick={() => write({ bp: String(safePage + 1) })}
                >
                  بعدی
                </button>
              </div>
            </>
          ) : (
            <p className="sa-sub">
              {loading ? "در حال خواندن…" : "هنوز معاملهٔ بسته‌شده‌ای در دفتر نیست."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
