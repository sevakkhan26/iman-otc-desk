"use client";

/**
 * «سفارش‌ها و پوزیشن‌ها» — open book + closed Paper trades.
 *
 * Open orders/positions are empty when the broker completes fills immediately.
 * Closed trades come only from immutable FILLED ledger rows.
 */
import { useMemo } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";

export type ClosedTradeRow = {
  id: string;
  lifecycleId: string;
  routeKey: string;
  buySourceId: string;
  sellSourceId: string;
  sizeUsdt: number;
  buyVwapToman: number | null;
  sellVwapToman: number | null;
  feeTomanTotal: number | null;
  feeUsdtMicrosTotal: number | null;
  sellFeeValueToman: number | null;
  grossSpreadToman: number | null;
  cashPnlIrtToman: number | null;
  economicNetPnlToman: number | null;
  riskAdjustedPnlToman: number | null;
  slippageBufferToman: number | null;
  occurredAt: string;
  bindingConstraint?: string | null;
  sizingPolicy?: string | null;
};

type Props = {
  openOrdersNoteFa: string;
  openPositionsNoteFa: string;
  closedTrades: ClosedTradeRow[];
  loading: boolean;
};

const DASH = <span className="sa-unknown">—</span>;

export function BookSection({
  openOrdersNoteFa,
  openPositionsNoteFa,
  closedTrades,
  loading
}: Props) {
  const { read, write } = useShadowViewState();
  const venue = read("bv", "all");
  const page = readInt(read("bp", "1"), 1, 1, 10_000);
  const perPage = 20;

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
        (t) =>
          venue === "all" || t.buySourceId === venue || t.sellSourceId === venue
      ),
    [closedTrades, venue]
  );

  const totalPages = Math.max(1, Math.ceil(filtered.length / perPage));
  const safePage = Math.min(page, totalPages);
  const shown = filtered.slice((safePage - 1) * perPage, safePage * perPage);

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
        <div className="panel-body">
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
                  </li>
                ))}
              </ul>
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
