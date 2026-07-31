"use client";

import { useEffect } from "react";
import { formatTehran } from "@/components/format";
import { TomanAmount } from "@/components/TomanAmount";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
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
import {
  DEBIT_MODE_FA,
  FEE_ASSET_FA,
  SETTLEMENT_PROVENANCE_FA
} from "@/components/shadowArbitrage/sourcesModel";
import type { PaperEvidence } from "@/components/shadowArbitrage/opportunityModel";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "@/components/shadowArbitrage/types";

type Props = {
  opportunity: ShadowOpportunity | null;
  sources: NormalizedSourceSnapshot[];
  /** The paper engine's own recorded figures for this lifecycle, if any. */
  evidence?: PaperEvidence | null;
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

/**
 * Exact, auditable breakdown of one opportunity.
 *
 * Phase 8B keeps every figure the drawer already showed and only sharpens the
 * hierarchy: a headline strip first, then the calculation in the order it is
 * performed, then the engine's own settled figures where they exist. Nothing is
 * recomputed here — a value the server did not record is «—», never a guess.
 */
export function OpportunityDrawer({ opportunity, sources, evidence, onClose }: Props) {
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
          {/* Headline: the three numbers a reader wants before any detail. */}
          <section className="sa-drawer-section sa-dw-headline">
            <div className="sa-dw-headline-grid">
              <div className="sa-dw-head-stat">
                <span className="sa-dw-head-label">اسپرد خام</span>
                <span className="sa-dw-head-value">
                  <Bidi>{formatPercentFa(o.rawSpreadPercent, 3, true)}</Bidi>
                </span>
              </div>
              <div className="sa-dw-head-stat">
                <span className="sa-dw-head-label">سود خالص نظری</span>
                <span className="sa-dw-head-value">
                  {o.feeUnknown ? "—" : <TomanAmount value={o.netProfitToman} />}
                </span>
              </div>
              <div className="sa-dw-head-stat">
                <span className="sa-dw-head-label">سود تعدیل‌شده با بافر</span>
                <span className="sa-dw-head-value">
                  {evidence?.riskAdjustedPnlToman !== null &&
                  evidence?.riskAdjustedPnlToman !== undefined ? (
                    <TomanAmount value={evidence.riskAdjustedPnlToman} />
                  ) : (
                    <span title="این رقم را موتور اجرای کاغذی ثبت می‌کند؛ برای این چرخه ثبتی وجود ندارد.">
                      —
                    </span>
                  )}
                </span>
              </div>
            </div>
          </section>

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

          {/* The engine's own settled figures, shown only when it evaluated this lifecycle. */}
          {evidence ? (
            <section className="sa-drawer-section">
              <h4>ارزیابی موتور اجرای کاغذی</h4>
              <Line
                label="سود نقدی تومانی"
                value={
                  evidence.cashPnlIrtToman !== null ? (
                    <TomanAmount value={evidence.cashPnlIrtToman} />
                  ) : (
                    "—"
                  )
                }
                hint="دریافتی فروش − هزینهٔ خرید − کارمزد تومانی خرید"
              />
              <Line
                label="تغییر موجودی تتر"
                value={
                  evidence.inventoryDeltaUsdt !== null ? (
                    <Bidi>{toFaDigits(evidence.inventoryDeltaUsdt.toFixed(6))} تتر</Bidi>
                  ) : (
                    "—"
                  )
                }
                hint="کارمزد تتری فروش از پرتفوی خارج می‌شود"
              />
              <Line
                label="ارزش تومانی کارمزد تتری"
                value={
                  evidence.sellFeeValueToman !== null ? (
                    <TomanAmount value={evidence.sellFeeValueToman} />
                  ) : (
                    "—"
                  )
                }
                hint={
                  evidence.markPriceToman !== null
                    ? `با قیمت مبنای همان چرخه: ${toFaDigits(evidence.markPriceToman)} تومان`
                    : "قیمت مبنا ثبت نشده است"
                }
              />
              <Line
                label="سود خالص اقتصادی"
                value={
                  evidence.economicNetPnlToman !== null ? (
                    <TomanAmount value={evidence.economicNetPnlToman} />
                  ) : (
                    "—"
                  )
                }
                strong
              />
              <Line
                label="سود تعدیل‌شده با بافر"
                value={
                  evidence.riskAdjustedPnlToman !== null ? (
                    <TomanAmount value={evidence.riskAdjustedPnlToman} />
                  ) : (
                    "—"
                  )
                }
                strong
              />
              <Line
                label="تسویهٔ کارمزد خرید"
                value={`${FEE_ASSET_FA[evidence.buyFeeAsset ?? "UNKNOWN"] ?? "—"} · ${
                  DEBIT_MODE_FA[evidence.buyFeeDebitMode ?? "UNKNOWN"] ?? "—"
                }`}
                hint={SETTLEMENT_PROVENANCE_FA[evidence.buyFeeProvenance ?? "UNKNOWN"] ?? undefined}
              />
              <Line
                label="تسویهٔ کارمزد فروش"
                value={`${FEE_ASSET_FA[evidence.sellFeeAsset ?? "UNKNOWN"] ?? "—"} · ${
                  DEBIT_MODE_FA[evidence.sellFeeDebitMode ?? "UNKNOWN"] ?? "—"
                }`}
                hint={SETTLEMENT_PROVENANCE_FA[evidence.sellFeeProvenance ?? "UNKNOWN"] ?? undefined}
              />
              {evidence.outcome === "SKIPPED" && evidence.rejectionReason ? (
                <div className="sa-callout sa-callout-muted">
                  این نامزد در آخرین ارزیابی اجرا نشد: {evidence.rejectionReason}
                </div>
              ) : null}
            </section>
          ) : (
            <section className="sa-drawer-section">
              <h4>ارزیابی موتور اجرای کاغذی</h4>
              <div className="sa-callout sa-callout-muted">
                برای این چرخهٔ حیات، ارزیابی اجرای کاغذی ثبت نشده است؛ بنابراین سود نقدی، اقتصادی و
                تعدیل‌شده «—» نمایش داده می‌شود و هیچ مقداری جایگزین آن نمی‌شود.
              </div>
            </section>
          )}

          <section className="sa-drawer-section">
            <h4>وضعیت اجرا</h4>
            <div className={`sa-callout ${executable ? "sa-callout-good" : "sa-callout-warn"}`}>
              {executable
                ? "هر دو صرافی حساب احرازشده دارند، داده تازه است، عمق کافی است و کارمزد معلوم است — این مسیر از نظر داده قابل استفاده است. با این حال هیچ سفارشی ارسال نمی‌شود."
                : "این مسیر در حال حاضر قابل استفاده نیست. دلایل زیر باید رفع شوند:"}
            </div>
            {/* Complete list, first-recorded first: that is the reason to act on. */}
            {o.blockedReasons.length ? (
              <ul className="sa-reason-list">
                {o.blockedReasons.map((r, i) => (
                  <li key={r}>
                    <strong>
                      {i === 0 ? "دلیل اصلی: " : ""}
                      {blockedShort(r)}
                    </strong>
                    <span>{blockedDetail(r)}</span>
                    {/* The technical code stays here, out of the primary UI. */}
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
