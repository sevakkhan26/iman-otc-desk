"use client";

import { useEffect } from "react";
import { formatTehran } from "@/components/format";
import { TomanAmount } from "@/components/TomanAmount";
import {
  ELIGIBILITY_FA,
  blockedDetail,
  blockedShort,
  eligibilityTone,
  formatAgoFa,
  formatDurationFa,
  formatPercentFa,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "@/components/shadowArbitrage/types";

type Props = {
  opportunity: ShadowOpportunity | null;
  sources: NormalizedSourceSnapshot[];
  onClose: () => void;
};

function Line({
  label,
  value,
  hint,
  strong
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  strong?: boolean;
}) {
  return (
    <div className={`sa-line${strong ? " is-strong" : ""}`}>
      <div className="sa-line-label">
        {label}
        {hint ? <span className="sa-line-hint">{hint}</span> : null}
      </div>
      <div className="sa-line-value">{value}</div>
    </div>
  );
}

/** Section D — exact, auditable breakdown of one opportunity. */
export function OpportunityDrawer({ opportunity, sources, onClose }: Props) {
  useEffect(() => {
    if (!opportunity) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [opportunity, onClose]);

  if (!opportunity) return null;
  const o = opportunity;
  const buySource = sources.find((s) => s.sourceId === o.buySourceId);
  const sellSource = sources.find((s) => s.sourceId === o.sellSourceId);
  const buyExec = buySource?.sizeExecutables.find((x) => x.sizeUsdt === o.sizeUsdt);
  const sellExec = sellSource?.sizeExecutables.find((x) => x.sizeUsdt === o.sizeUsdt);

  const executable = o.eligibility === "EXECUTABLE_NOW";

  return (
    <div className="sa-drawer-backdrop" onClick={onClose} role="presentation">
      <aside
        className="sa-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="جزئیات فرصت"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sa-drawer-head">
          <div>
            <div className="sa-drawer-route">
              {o.buySourceName} <span aria-hidden="true">←</span> {o.sellSourceName}
            </div>
            <div className="sa-drawer-sub">
              حجم {toFaDigits(o.sizeUsdt)} تتر ·{" "}
              <span className={`sa-chip sa-chip-${eligibilityTone(o.eligibility)} sa-chip-sm`}>
                {ELIGIBILITY_FA[o.eligibility]}
              </span>
            </div>
          </div>
          <button type="button" className="sa-btn sa-btn-ghost" onClick={onClose} aria-label="بستن">
            بستن
          </button>
        </header>

        <div className="sa-drawer-body">
          <section className="sa-drawer-section">
            <h4>محاسبهٔ خرید</h4>
            <Line
              label={`قیمت میانگین وزنی خرید در ${o.buySourceName}`}
              value={<TomanAmount value={o.buyVwapToman} />}
              hint={buySource?.marketModel === "OTC_QUOTE" ? "نقل‌قول OTC" : "میانگین وزنی سطوح دفتر"}
            />
            <Line
              label={`هزینهٔ خرید ${toFaDigits(o.sizeUsdt)} تتر`}
              value={<TomanAmount value={o.buyCostToman} />}
            />
            <Line
              label="حجم پرشده"
              value={
                buyExec
                  ? `${toFaDigits(Number(buyExec.buyFilledUsdt.toFixed(2)))} تتر`
                  : "—"
              }
              hint={buyExec?.buyFillable ? "کل حجم پر می‌شود" : "حجم درخواستی پر نمی‌شود"}
            />
            <Line
              label="عمق سمت فروشندگان"
              value={
                buySource?.meta?.depthAvailable === false
                  ? "عمق تأییدنشده"
                  : buySource?.depthUsdtAsk != null
                    ? `${toFaDigits(Math.round(buySource.depthUsdtAsk))} تتر`
                    : "—"
              }
            />
          </section>

          <section className="sa-drawer-section">
            <h4>محاسبهٔ فروش</h4>
            <Line
              label={`قیمت میانگین وزنی فروش در ${o.sellSourceName}`}
              value={<TomanAmount value={o.sellVwapToman} />}
              hint={sellSource?.marketModel === "OTC_QUOTE" ? "نقل‌قول OTC" : "میانگین وزنی سطوح دفتر"}
            />
            <Line
              label={`دریافتی از فروش ${toFaDigits(o.sizeUsdt)} تتر`}
              value={<TomanAmount value={o.sellProceedsToman} />}
            />
            <Line
              label="حجم پرشده"
              value={
                sellExec
                  ? `${toFaDigits(Number(sellExec.sellFilledUsdt.toFixed(2)))} تتر`
                  : "—"
              }
              hint={sellExec?.sellFillable ? "کل حجم پر می‌شود" : "حجم درخواستی پر نمی‌شود"}
            />
            <Line
              label="عمق سمت خریداران"
              value={
                sellSource?.meta?.depthAvailable === false
                  ? "عمق تأییدنشده"
                  : sellSource?.depthUsdtBid != null
                    ? `${toFaDigits(Math.round(sellSource.depthUsdtBid))} تتر`
                    : "—"
              }
            />
          </section>

          <section className="sa-drawer-section">
            <h4>کارمزد و هزینه‌ها</h4>
            <Line label="اسپرد خام" value={formatPercentFa(o.rawSpreadPercent, 3, true)} />
            <Line
              label={`کارمزد خرید (${toFaDigits(o.buyFeeBps)} در ده‌هزار)`}
              value={o.feeUnknown ? "نامشخص" : <TomanAmount value={o.buyFeeToman} />}
            />
            <Line
              label={`کارمزد فروش (${toFaDigits(o.sellFeeBps)} در ده‌هزار)`}
              value={o.feeUnknown ? "نامشخص" : <TomanAmount value={o.sellFeeToman} />}
            />
            <Line label="بافر لغزش و ریسک" value={<TomanAmount value={o.slippageBufferToman} />} hint="۰٫۰۵٪ موقت" />
            <Line
              label="برآورد هزینهٔ بازتوازن"
              value={<TomanAmount value={o.rebalanceCostToman} />}
              hint="مقدار موقت"
            />
          </section>

          <section className="sa-drawer-section">
            <h4>نتیجه</h4>
            <div className="sa-formula">
              سود خالص = دریافتی فروش − هزینهٔ خرید − کارمزد خرید − کارمزد فروش − بافر ریسک − هزینهٔ
              بازتوازن
            </div>
            {o.feeUnknown ? (
              <div className="sa-callout sa-callout-warn">
                کارمزد یکی از دو صرافی تأیید نشده است، بنابراین این مسیر فقط «پتانسیل خام» دارد و سود
                خالص برای آن محاسبه نمی‌شود.
              </div>
            ) : (
              <>
                <Line label="حاشیهٔ خالص" value={formatPercentFa(o.netEdgePercent, 3, true)} strong />
                <Line label="سود خالص نظری" value={<TomanAmount value={o.netProfitToman} />} strong />
                <Line
                  label="بیشترین حاشیهٔ ثبت‌شده"
                  value={formatPercentFa(o.maxNetEdgePercent, 3, true)}
                />
              </>
            )}
          </section>

          <section className="sa-drawer-section">
            <h4>وضعیت اجرا</h4>
            <div className={`sa-callout ${executable ? "sa-callout-good" : "sa-callout-warn"}`}>
              {executable
                ? "هر دو صرافی حساب احرازشده دارند، داده تازه است، عمق کافی است و کارمزد معلوم است — این مسیر از نظر داده قابل استفاده است. با این حال هیچ سفارشی ارسال نمی‌شود."
                : "این مسیر در حال حاضر قابل استفاده نیست. دلایل زیر باید رفع شوند:"}
            </div>
            {o.blockedReasons.length ? (
              <ul className="sa-reason-list">
                {o.blockedReasons.map((r) => (
                  <li key={r}>
                    <strong>{blockedShort(r)}</strong>
                    <span>{blockedDetail(r)}</span>
                    <code className="sa-code">{r}</code>
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="sa-drawer-section">
            <h4>سلامت منابع و زمان داده</h4>
            <Line
              label={`سن دادهٔ ${o.buySourceName}`}
              value={`${toFaDigits(Math.round(o.buyAgeMs / 1000))} ثانیه`}
              hint={buySource?.health === "healthy" ? "سالم" : buySource?.health === "degraded" ? "تضعیف‌شده" : "در دسترس نیست"}
            />
            <Line
              label={`سن دادهٔ ${o.sellSourceName}`}
              value={`${toFaDigits(Math.round(o.sellAgeMs / 1000))} ثانیه`}
              hint={sellSource?.health === "healthy" ? "سالم" : sellSource?.health === "degraded" ? "تضعیف‌شده" : "در دسترس نیست"}
            />
            <Line label="نخستین مشاهده" value={formatTehran(o.firstSeenAt)} />
            <Line
              label="آخرین مشاهده"
              value={formatTehran(o.lastSeenAt)}
              hint={formatAgoFa(o.lastSeenAt)}
            />
            <Line label="مدت دوام" value={formatDurationFa(o.durationMs)} />
            <Line label="تعداد مشاهده" value={toFaDigits(o.observationCount ?? 1)} />
          </section>
        </div>
      </aside>
    </div>
  );
}
