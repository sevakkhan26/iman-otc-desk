"use client";

/**
 * «سفارش‌ها» — only currently queued or open Paper orders.
 *
 * v4.2.1: completed trades moved to Activity. Statuses shown:
 * QUEUED | OPEN | PENDING | HELD. Never invents open rows.
 */
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";

const OPEN_STATUSES = new Set(["QUEUED", "OPEN", "PENDING", "HELD"]);

export type OpenOrderRow = {
  id: string;
  status: string;
  routeKey?: string | null;
  buySourceId?: string | null;
  sellSourceId?: string | null;
  sizeUsdt?: number | null;
  side?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  noteFa?: string | null;
};

/** Closed trade type kept for call-site compatibility (unused in this section). */
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
  grossSpreadToman: number | null;
  economicNetPnlToman: number | null;
  occurredAt: string;
  sizingPolicy?: string | null;
};

export type BookExperimentContext = {
  experimentId?: string | null;
  policyFingerprint?: string | null;
  releaseVersion?: string | null;
};

type Props = {
  openOrders?: OpenOrderRow[] | null;
  openOrdersNoteFa?: string;
  /** @deprecated open positions not shown as separate list in v4.2.1 */
  openPositionsNoteFa?: string;
  /** @deprecated completed trades live under Activity */
  closedTrades?: ClosedTradeRow[];
  loading: boolean;
  serverFilledCount?: number | null;
  experimentContext?: BookExperimentContext | null;
};

export function BookSection({
  openOrders = null,
  openOrdersNoteFa,
  loading
}: Props) {
  const open = (openOrders ?? []).filter((o) =>
    OPEN_STATUSES.has(String(o.status ?? "").toUpperCase())
  );

  return (
    <div className="sa-stack">
      <section className="panel sa-panel" aria-label="سفارش‌های باز">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">سفارش‌ها</h3>
          <div className="sa-panel-note">
            فقط QUEUED · OPEN · PENDING · HELD
          </div>
        </div>
        <div className="panel-body">
          {loading && !open.length ? (
            <p className="sa-sub">در حال خواندن…</p>
          ) : null}

          {open.length ? (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>وضعیت</th>
                    <th>مسیر</th>
                    <th className="num">حجم</th>
                    <th>زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {open.map((o) => (
                    <tr key={o.id} className="sa-row">
                      <td>
                        <span className="sa-chip sa-chip-sm sa-chip-warn">{o.status}</span>
                      </td>
                      <td className="sa-sub">
                        {o.routeKey ??
                          (o.buySourceId && o.sellSourceId
                            ? `${o.buySourceId} ← ${o.sellSourceId}`
                            : "—")}
                      </td>
                      <td className="num">
                        {o.sizeUsdt !== null && o.sizeUsdt !== undefined ? (
                          <Bidi>{toFaDigits(o.sizeUsdt.toFixed(4))}</Bidi>
                        ) : (
                          <span className="sa-unknown">Unavailable</span>
                        )}
                      </td>
                      <td className="sa-sub">
                        {o.createdAt || o.updatedAt
                          ? formatTehran(o.createdAt ?? o.updatedAt ?? "")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="sa-empty-state" role="status">
              <p className="sa-empty-title">سفارش بازی نیست</p>
              <p className="sa-sub">
                {openOrdersNoteFa ??
                  "کارگزار کاغذی فعلی سفارش باز نگه نمی‌دارد؛ معاملات تکمیل‌شده در «فعالیت‌ها» هستند."}
              </p>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
