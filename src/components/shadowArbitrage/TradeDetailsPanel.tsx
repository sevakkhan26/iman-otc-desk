"use client";

/**
 * Read-only trade detail panel for closed Paper ledger rows.
 * Presentation only — values come from buildTradeDetailsView; no recalculation.
 */
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import {
  MISSING_FA,
  buildTradeDetailsView,
  type ClosedTradeEvidence,
  type TradeDetailField,
  type TradeDetailsContext
} from "@/lib/shadowArbitrage/paper/tradeDetailsView";
import { UNCOMPUTABLE_FA } from "@/lib/shadowArbitrage/paper/tradeProfitability";

type Props = {
  trade: ClosedTradeEvidence;
  context?: TradeDetailsContext;
  open: boolean;
  onClose: () => void;
};

function FieldValue({
  field,
  children
}: {
  field: TradeDetailField<unknown>;
  children?: React.ReactNode;
}) {
  if (field.status === "missing") {
    return (
      <span className="sa-unknown" title={field.missingFa}>
        {MISSING_FA}
      </span>
    );
  }
  return <>{children}</>;
}

function Row({
  label,
  field,
  children
}: {
  label: string;
  field: TradeDetailField<unknown>;
  children?: React.ReactNode;
}) {
  return (
    <div className="sa-td-row">
      <dt>{label}</dt>
      <dd>
        <FieldValue field={field}>{children}</FieldValue>
        {field.status === "missing" ? (
          <span className="sa-td-missing-hint">{field.missingFa}</span>
        ) : null}
      </dd>
    </div>
  );
}

function pnlClass(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n === 0) return "sa-pnl-zero";
  return n > 0 ? "sa-pnl-pos" : "sa-pnl-neg";
}

function MoneyTR({
  toman,
  emphasize
}: {
  toman: number;
  emphasize?: boolean;
}) {
  const rial = toman * 10;
  return (
    <span className={emphasize ? pnlClass(toman) : undefined}>
      <TomanAmount value={toman} />
      <span className="sa-sub">
        {" "}
        · <Bidi>{toFaDigits(Math.round(rial).toLocaleString("en-US"))}</Bidi> ریال
      </span>
    </span>
  );
}

export function TradeDetailsPanel({ trade, context, open, onClose }: Props) {
  if (!open) return null;
  const v = buildTradeDetailsView(trade, context);
  const p = v.profitability;

  return (
    <div className="sa-td-panel panel sa-panel" role="region" aria-label="جزئیات معامله">
      <div className="panel-header sa-panel-header sa-td-head">
        <h4 className="panel-title">جزئیات معامله</h4>
        <button type="button" className="sa-btn sa-btn-ghost sa-td-close" onClick={onClose}>
          بستن
        </button>
      </div>
      <div className="panel-body sa-td-body">
        <section className="sa-td-block sa-td-profit" aria-label="سودآوری">
          <h5 className="sa-td-block-title">سودآوری (اقتصادی پس از کارمزد)</h5>
          <p className="sa-sub sa-td-profit-note">
            رقم اصلی سود اقتصادی خالص پس از کارمزد دو سمت است — نه جابه‌جایی نقدی. حجم هر معامله
            اتمیک یک‌بار شمرده می‌شود. ریال = تومان × ۱۰ (فقط نمایش).
          </p>
          <dl className="sa-td-grid">
            <div className="sa-td-row">
              <dt>حجم معامله</dt>
              <dd>
                {p.sizeUsdt !== null && p.sizeUsdt > 0 ? (
                  <Bidi>{toFaDigits(p.sizeUsdt.toFixed(4))} USDT</Bidi>
                ) : (
                  <span className="sa-unknown">{UNCOMPUTABLE_FA}</span>
                )}
              </dd>
            </div>
            <div className="sa-td-row">
              <dt>سود ناخالص</dt>
              <dd>
                {p.grossProfit.ok ? (
                  <MoneyTR toman={p.grossProfit.money.toman} emphasize />
                ) : (
                  <span className="sa-unknown" title={p.grossProfit.reasonFa}>
                    {UNCOMPUTABLE_FA}
                  </span>
                )}
              </dd>
            </div>
            <div className="sa-td-row">
              <dt>مجموع کارمزد</dt>
              <dd>
                {p.totalFees.ok ? (
                  <MoneyTR toman={p.totalFees.money.toman} />
                ) : (
                  <span className="sa-unknown" title={p.totalFees.reasonFa}>
                    {UNCOMPUTABLE_FA}
                  </span>
                )}
              </dd>
            </div>
            <div className="sa-td-row sa-td-row-highlight">
              <dt>سود اقتصادی خالص</dt>
              <dd>
                {p.economicNet.ok ? (
                  <MoneyTR toman={p.economicNet.money.toman} emphasize />
                ) : (
                  <span className="sa-unknown" title={p.economicNet.reasonFa}>
                    {UNCOMPUTABLE_FA}
                  </span>
                )}
              </dd>
            </div>
            <div className="sa-td-row">
              <dt>سود به‌ازای هر ۱ تتر</dt>
              <dd>
                {p.profitPerUsdt.ok ? (
                  <MoneyTR toman={p.profitPerUsdt.money.toman} emphasize />
                ) : (
                  <span className="sa-unknown" title={p.profitPerUsdt.reasonFa}>
                    {UNCOMPUTABLE_FA}
                  </span>
                )}
              </dd>
            </div>
            <div className="sa-td-row">
              <dt>بازده خالص</dt>
              <dd>
                {p.netReturn.ok ? (
                  <span className={pnlClass(p.netReturn.percent)}>
                    <Bidi>{toFaDigits(p.netReturn.percent.toFixed(4))}٪</Bidi>
                    {" · "}
                    <Bidi>{toFaDigits(p.netReturn.bps.toFixed(2))}</Bidi> bps
                  </span>
                ) : (
                  <span className="sa-unknown" title={p.netReturn.reasonFa}>
                    {UNCOMPUTABLE_FA}
                  </span>
                )}
              </dd>
            </div>
          </dl>
        </section>

        <section className="sa-td-block" aria-label="زمان‌بندی">
          <h5 className="sa-td-block-title">زمان‌بندی</h5>
          <dl className="sa-td-grid">
            <Row label="زمان تصمیم" field={v.timeline.decisionAt} />
            <Row label="ایجاد سفارش" field={v.timeline.orderCreatedAt} />
            <Row label="ارسال سفارش" field={v.timeline.submissionAt} />
            <Row label="پر خرید" field={v.timeline.buyFillAt}>
              {formatTehran(v.timeline.buyFillAt.value as string)}
            </Row>
            <Row label="پر فروش" field={v.timeline.sellFillAt}>
              {formatTehran(v.timeline.sellFillAt.value as string)}
            </Row>
            <Row label="اتمام" field={v.timeline.completionAt}>
              {formatTehran(v.timeline.completionAt.value as string)}
            </Row>
            <div className="sa-td-row sa-td-row-full">
              <dt>مدت تراکنش</dt>
              <dd>
                <Bidi>{toFaDigits(v.timeline.duration.durationMs)}</Bidi> میلی‌ثانیه
                <p className="sa-sub sa-td-duration-note">{v.timeline.duration.explanationFa}</p>
                <p className="sa-sub">
                  تعریف مدت: از{" "}
                  <code className="sa-ps-key">{v.timeline.duration.startField}</code> تا{" "}
                  <code className="sa-ps-key">{v.timeline.duration.endField}</code>
                </p>
              </dd>
            </div>
          </dl>
        </section>

        <section className="sa-td-block" aria-label="تراکنش">
          <h5 className="sa-td-block-title">تراکنش</h5>
          <dl className="sa-td-grid">
            <Row label="صرافی خرید" field={v.transaction.buyVenue}>
              {v.transaction.buyVenue.value as string}
            </Row>
            <Row label="صرافی فروش" field={v.transaction.sellVenue}>
              {v.transaction.sellVenue.value as string}
            </Row>
            <Row label="حالت حجم‌دهی" field={v.transaction.sizingMode}>
              {v.transaction.sizingMode.value as string}
            </Row>
            <Row label="حجم USDT" field={v.transaction.sizeUsdt}>
              <Bidi>{toFaDigits(Number(v.transaction.sizeUsdt.value).toFixed(4))}</Bidi>
            </Row>
            <Row label="قیمت خرید / VWAP" field={v.transaction.buyVwap}>
              <TomanAmount value={v.transaction.buyVwap.value as number} />
            </Row>
            <Row label="قیمت فروش / VWAP" field={v.transaction.sellVwap}>
              <TomanAmount value={v.transaction.sellVwap.value as number} />
            </Row>
            <Row label="مبلغ خرید" field={v.transaction.buyNotional}>
              <TomanAmount value={v.transaction.buyNotional.value as number} />
            </Row>
            <Row label="عواید فروش" field={v.transaction.sellNotional}>
              <TomanAmount value={v.transaction.sellNotional.value as number} />
            </Row>
            <Row label="اسپرد / سود ناخالص" field={v.transaction.grossSpread}>
              <span className={pnlClass(v.transaction.grossSpread.value as number)}>
                <TomanAmount value={v.transaction.grossSpread.value as number} />
              </span>
            </Row>
            <Row label="کارمزد خرید (bps)" field={v.transaction.buyFeeBps}>
              <Bidi>{toFaDigits(v.transaction.buyFeeBps.value as number)}</Bidi>
            </Row>
            <Row label="کارمزد فروش (bps)" field={v.transaction.sellFeeBps}>
              <Bidi>{toFaDigits(v.transaction.sellFeeBps.value as number)}</Bidi>
            </Row>
            <Row label="دارایی کارمزد خرید" field={v.transaction.buyFeeAsset}>
              {v.transaction.buyFeeAsset.value as string}
            </Row>
            <Row label="دارایی کارمزد فروش" field={v.transaction.sellFeeAsset}>
              {v.transaction.sellFeeAsset.value as string}
            </Row>
            <Row label="کارمزد IRT" field={v.transaction.feeTomanTotal}>
              <TomanAmount value={v.transaction.feeTomanTotal.value as number} />
            </Row>
            <Row label="کارمزد USDT" field={v.transaction.feeUsdtMicros}>
              <Bidi>
                {toFaDigits(((v.transaction.feeUsdtMicros.value as number) / 1e6).toFixed(6))}
              </Bidi>
            </Row>
            <Row label="معادل تومانی کارمزد تتر" field={v.transaction.sellFeeValueToman}>
              <TomanAmount value={v.transaction.sellFeeValueToman.value as number} />
            </Row>
            <div className="sa-td-row sa-td-row-full">
              <dt>کارمزد مدل‌شده</dt>
              <dd className="sa-sub">{v.transaction.totalModeledFeeNoteFa}</dd>
            </div>
            <Row label="P&amp;L اقتصادی تحقق‌یافته" field={v.transaction.economicNetPnl}>
              <span className={pnlClass(v.transaction.economicNetPnl.value as number)}>
                <TomanAmount value={v.transaction.economicNetPnl.value as number} />
              </span>
            </Row>
            <Row label="P&amp;L نقدی" field={v.transaction.cashPnl}>
              <span className={pnlClass(v.transaction.cashPnl.value as number)}>
                <TomanAmount value={v.transaction.cashPnl.value as number} />
              </span>
            </Row>
            <Row label="وضعیت" field={v.transaction.status}>
              <span
                className={`sa-chip sa-chip-sm ${
                  v.transaction.status.value === "FILLED" ? "sa-chip-good" : "sa-chip-danger"
                }`}
              >
                {v.transaction.status.value as string}
              </span>
            </Row>
            <Row label="دلیل شکست" field={v.transaction.failureReason}>
              {v.transaction.failureReason.value as string}
            </Row>
          </dl>
        </section>

        <section className="sa-td-block" aria-label="چرا این حجم">
          <h5 className="sa-td-block-title">چرا این حجم انتخاب شد</h5>
          <dl className="sa-td-grid">
            <Row label="حجم انتخاب‌شده" field={v.sizing.selectedSizeUsdt}>
              <Bidi>{toFaDigits(Number(v.sizing.selectedSizeUsdt.value).toFixed(4))}</Bidi>
            </Row>
            <Row label="کاندیدهای ارزیابی‌شده" field={v.sizing.candidatesEvaluated} />
            <Row label="استفاده قبل" field={v.sizing.utilBefore} />
            <Row label="استفاده بعد" field={v.sizing.utilAfter} />
            <Row label="عمق خام خرید" field={v.sizing.rawBuyDepth} />
            <Row label="عمق خام فروش" field={v.sizing.rawSellDepth} />
            <Row label="ظرفیت خرید" field={v.sizing.usableBuyCapacity} />
            <Row label="ظرفیت فروش" field={v.sizing.usableSellCapacity} />
            <Row label="IRT در دسترس" field={v.sizing.availableIrt} />
            <Row label="USDT در دسترس" field={v.sizing.availableUsdt} />
            <Row label="سقف سیاست سفارش" field={v.sizing.orderSizePolicyCap} />
            <Row label="سقف تمرکز صرافی" field={v.sizing.venueExposureCap} />
            <Row label="سقف مسیر" field={v.sizing.routeExposureCap} />
            <Row label="بافر لغزش (تومان)" field={v.sizing.slippageCap}>
              <TomanAmount value={v.sizing.slippageCap.value as number} />
            </Row>
            <Row label="سقف سرمایه (USDT)" field={v.sizing.capitalCapUsdt}>
              <Bidi>{toFaDigits(Number(v.sizing.capitalCapUsdt.value).toFixed(4))}</Bidi>
            </Row>
            <Row label="سقف عمق (USDT)" field={v.sizing.depthCapUsdt}>
              <Bidi>{toFaDigits(Number(v.sizing.depthCapUsdt.value).toFixed(4))}</Bidi>
            </Row>
            <Row label="محدودکنندهٔ قطعی" field={v.sizing.bindingConstraint}>
              <span className="sa-strong">{v.sizing.bindingConstraint.value as string}</span>
            </Row>
            <Row label="دلیل حجم" field={v.sizing.sizingReason}>
              {v.sizing.sizingReason.value as string}
            </Row>
            <Row label="حجم بعدی ردشده" field={v.sizing.nextLargerSizeUsdt}>
              <Bidi>{toFaDigits(Number(v.sizing.nextLargerSizeUsdt.value).toFixed(4))}</Bidi>
            </Row>
            <Row label="کد رد حجم بعدی" field={v.sizing.nextLargerRejectionCode}>
              {v.sizing.nextLargerRejectionCode.value as string}
            </Row>
            <Row label="دلیل رد حجم بعدی" field={v.sizing.nextLargerRejectionReason}>
              {v.sizing.nextLargerRejectionReason.value as string}
            </Row>
            <Row label="درصد از ظرفیت قابل‌استفاده" field={v.sizing.selectedPercentOfUsable}>
              <Bidi>{toFaDigits(Number(v.sizing.selectedPercentOfUsable.value).toFixed(2))}٪</Bidi>
            </Row>
            <Row label="سمت محدودکننده" field={v.sizing.limitingSide}>
              {v.sizing.limitingSide.value as string}
            </Row>
            <Row label="صرافی محدودکننده" field={v.sizing.limitingSourceId}>
              {v.sizing.limitingSourceId.value as string}
            </Row>
            <Row label="ظرفیت محدودکننده (USDT)" field={v.sizing.limitingUsableUsdt}>
              <Bidi>{toFaDigits(Number(v.sizing.limitingUsableUsdt.value).toFixed(4))}</Bidi>
            </Row>
          </dl>
          <div className="sa-callout sa-callout-muted sa-td-answers" role="note">
            <p>
              <strong>۱. چرا این حجم؟</strong>{" "}
              {v.sizing.sizingReason.status === "present"
                ? String(v.sizing.sizingReason.value)
                : MISSING_FA}
              {v.sizing.bindingConstraint.status === "present"
                ? ` · محدودکننده: ${String(v.sizing.bindingConstraint.value)}`
                : ""}
            </p>
            <p>
              <strong>۲. چه چیزی حجم بزرگ‌تر را منع کرد؟</strong>{" "}
              {v.sizing.nextLargerRejectionReason.status === "present"
                ? String(v.sizing.nextLargerRejectionReason.value)
                : v.sizing.nextLargerRejectionCode.status === "present"
                  ? String(v.sizing.nextLargerRejectionCode.value)
                  : MISSING_FA}
            </p>
            <p>
              <strong>۳. چقدر باز بود؟</strong>{" "}
              <Bidi>{toFaDigits(v.timeline.duration.durationMs)}</Bidi> ms —{" "}
              {v.timeline.duration.explanationFa}
            </p>
            <p>
              <strong>۴. پس از کارمزد چقدر ماند؟</strong>{" "}
              {v.transaction.economicNetPnl.status === "present" ? (
                <span className={pnlClass(v.transaction.economicNetPnl.value as number)}>
                  <TomanAmount value={v.transaction.economicNetPnl.value as number} />
                </span>
              ) : (
                MISSING_FA
              )}
            </p>
          </div>
        </section>

        <details className="sa-advanced-details sa-td-tech">
          <summary className="sa-panel-note">شواهد فنی</summary>
          <dl className="sa-td-grid sa-td-tech-grid">
            <Row label="runId" field={v.technical.runId}>
              <code className="sa-copyable sa-ps-key">{v.technical.runId.value as string}</code>
            </Row>
            <Row label="sessionId" field={v.technical.sessionId}>
              <code className="sa-copyable sa-ps-key">{v.technical.sessionId.value as string}</code>
            </Row>
            <Row label="cycleId / runId" field={v.technical.cycleId}>
              <code className="sa-copyable sa-ps-key">{v.technical.cycleId.value as string}</code>
            </Row>
            <Row label="decisionId" field={v.technical.decisionId} />
            <Row label="ledger / trade id" field={v.technical.ledgerId}>
              <code className="sa-copyable sa-ps-key">{v.technical.ledgerId.value as string}</code>
            </Row>
            <Row label="lifecycleId" field={v.technical.lifecycleId}>
              <code className="sa-copyable sa-ps-key">{v.technical.lifecycleId.value as string}</code>
            </Row>
            <Row label="orderId" field={v.technical.orderId} />
            <Row label="fillId" field={v.technical.fillId} />
            <Row label="experimentId" field={v.technical.experimentId}>
              <code className="sa-copyable sa-ps-key">
                {v.technical.experimentId.value as string}
              </code>
            </Row>
            <Row label="policy fingerprint" field={v.technical.policyFingerprint}>
              <code className="sa-copyable sa-ps-key">
                {v.technical.policyFingerprint.value as string}
              </code>
            </Row>
            <Row label="release version" field={v.technical.releaseVersion}>
              <Bidi>{v.technical.releaseVersion.value as string}</Bidi>
            </Row>
            <Row label="idempotency key" field={v.technical.idempotencyKey} />
            <div className="sa-td-row sa-td-row-full">
              <dt>UTC (پر / اتمام)</dt>
              <dd>
                <code className="sa-copyable">{trade.occurredAt}</code>
              </dd>
            </div>
          </dl>
        </details>
      </div>
    </div>
  );
}
