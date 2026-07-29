"use client";

import { useMemo } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import {
  ACCOUNT_FA,
  CERT_FA,
  FEE_STATUS_FA,
  MARKET_MODEL_FA,
  accountPriorityLabel,
  certTone,
  formatAgoFa,
  formatCountFa,
  formatPercentFa,
  freshnessLabel,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import type {
  Certification,
  NormalizedSourceSnapshot,
  ShadowAnalytics,
  SourceHealthRow
} from "@/components/shadowArbitrage/types";

type Props = {
  certifications: Certification[];
  health: SourceHealthRow[];
  sources: NormalizedSourceSnapshot[];
  analytics: ShadowAnalytics | null;
  pollIntervalMs: number;
  loading: boolean;
};

/**
 * Section E — per-source status and, for venues without an account, how much
 * observed evidence there is that opening one would be worth it.
 */
export function SourceTable({
  certifications,
  health,
  sources,
  analytics,
  pollIntervalMs,
  loading
}: Props) {
  const healthById = useMemo(() => new Map(health.map((h) => [h.sourceId, h])), [health]);
  const snapById = useMemo(
    () => new Map<string, NormalizedSourceSnapshot>(sources.map((s) => [s.sourceId, s])),
    [sources]
  );

  /**
   * Account-opening evidence: the best observed raw spread on any route that
   * requires this venue. Derived only from recorded route metrics — never a
   * projection.
   */
  const evidenceById = useMemo(() => {
    const out = new Map<string, { bestRaw: number; routes: number; samples: number }>();
    for (const r of analytics?.routes ?? []) {
      for (const id of [r.buySourceId, r.sellSourceId]) {
        const cur = out.get(id) ?? { bestRaw: 0, routes: 0, samples: 0 };
        cur.bestRaw = Math.max(cur.bestRaw, r.maxRawSpread ?? 0);
        cur.routes += 1;
        cur.samples += r.samples;
        out.set(id, cur);
      }
    }
    return out;
  }, [analytics]);

  if (loading && !certifications.length) {
    return (
      <section className="panel sa-panel">
        <div className="panel-body">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="sa-skeleton-line" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <section className="panel sa-panel">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title sa-panel-title">وضعیت منابع و حساب‌ها</h3>
        <div className="sa-panel-note">۹ منبع عمومی</div>
      </div>
      <div className="panel-body sa-table-wrap">
        <table className="sa-table">
          <thead>
            <tr>
              <th>منبع</th>
              <th>وضعیت داده</th>
              <th>حساب</th>
              <th>مدل بازار</th>
              <th className="num">خرید / فروش</th>
              <th>حجم‌های پشتیبانی‌شده</th>
              <th>کارمزد</th>
              <th className="num">تازگی</th>
              <th className="num">دردسترس‌بودن</th>
              <th className="num">نرخ خطا</th>
              <th className="num">تأخیر پاسخ</th>
              <th>اولویت افتتاح حساب</th>
            </tr>
          </thead>
          <tbody>
            {certifications.map((c) => {
              const h = healthById.get(c.sourceId);
              const snap = snapById.get(c.sourceId);
              const ev = evidenceById.get(c.sourceId);
              const fresh = freshnessLabel(snap?.ageMs, pollIntervalMs);
              const accountStatus = snap?.accountStatus ?? "unknown";
              const verified = accountStatus === "verified";
              const reference = c.status === "REFERENCE_ONLY";

              // Only meaningful for venues we cannot trade on yet.
              const priorityScore = verified || reference ? null : (ev?.bestRaw ?? 0);
              const priority = accountPriorityLabel(priorityScore);

              const fillable = (snap?.sizeExecutables ?? []).filter((s) => s.buyFillable || s.sellFillable);

              return (
                <tr key={c.sourceId}>
                  <td>
                    <strong>{c.sourceName ?? c.sourceId}</strong>
                    <div className="sa-route-hint">{c.marketSymbol}</div>
                  </td>
                  <td>
                    <span className={`sa-chip sa-chip-${certTone(c.status)} sa-chip-sm`}>
                      {CERT_FA[c.status] ?? c.status}
                    </span>
                    <div className="sa-flags">
                      {c.directionVerified === false ? (
                        <span className="sa-reason" title={c.directionNote}>
                          جهت قیمت تأییدنشده
                        </span>
                      ) : null}
                      {c.depthAvailable === false && c.marketModel === "ORDER_BOOK" ? (
                        <span className="sa-reason" title={c.depthNote}>
                          عمق ناکافی
                        </span>
                      ) : null}
                      {c.observedPriceUnit === "ambiguous" ? (
                        <span className="sa-reason">واحد قیمت مبهم</span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <span className={`sa-chip sa-chip-${verified ? "good" : "warn"} sa-chip-sm`}>
                      {reference ? "فقط مرجع" : ACCOUNT_FA[accountStatus]}
                    </span>
                  </td>
                  <td>{MARKET_MODEL_FA[c.marketModel] ?? c.marketModel}</td>
                  <td className="num">
                    {snap?.userBuyPriceToman != null ? (
                      <div className="sa-dual">
                        <TomanAmount value={snap.userBuyPriceToman} />
                        <TomanAmount value={snap.userSellPriceToman} />
                      </div>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td>
                    {fillable.length ? (
                      <span className="sa-sizes">
                        {fillable.map((s) => toFaDigits(s.sizeUsdt)).join(" · ")} تتر
                      </span>
                    ) : (
                      <span className="sa-reason">هیچ حجمی تأیید نشد</span>
                    )}
                    {c.maxExecutableUsdt != null ? (
                      <div className="sa-route-hint">
                        حد اجرا: {formatCountFa(Math.round(c.maxExecutableUsdt))} تتر
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`sa-chip sa-chip-${c.feeStatus === "unknown" ? "warn" : "muted"} sa-chip-sm`}
                    >
                      {FEE_STATUS_FA[c.feeStatus] ?? c.feeStatus}
                    </span>
                    <div className="sa-route-hint">
                      {c.feeValueBps != null ? formatPercentFa(c.feeValueBps / 100, 2) : "نامشخص"}
                      {c.feeVerifiedAt ? ` · بازبینی ${c.feeVerifiedAt}` : ""}
                    </div>
                  </td>
                  <td className="num">
                    <span className={`sa-fresh sa-fresh-${fresh.tone}`}>{fresh.label}</span>
                    <div className="sa-route-hint">{formatPercentFa(h?.freshnessPercent ?? null, 0)}</div>
                  </td>
                  <td className="num">
                    {formatPercentFa(h?.uptimePercent ?? null, 1)}
                    <div className="sa-route-hint">{formatCountFa(h?.samples ?? 0)} نمونه</div>
                  </td>
                  <td className="num">{formatPercentFa(h?.errorRatePercent ?? null, 1)}</td>
                  <td className="num">
                    {h?.latencyP50Ms != null ? `${toFaDigits(h.latencyP50Ms)}ms` : "—"}
                    <div className="sa-route-hint">
                      {h?.latencyP95Ms != null ? `p95 ${toFaDigits(h.latencyP95Ms)}ms` : ""}
                    </div>
                  </td>
                  <td>
                    {verified ? (
                      <span className="sa-route-hint">حساب موجود است</span>
                    ) : reference ? (
                      <span className="sa-route-hint">اجرا تأیید نشده</span>
                    ) : (
                      <>
                        <span className={`sa-chip sa-chip-${priority.tone} sa-chip-sm`}>
                          {priority.label}
                        </span>
                        <div className="sa-route-hint">
                          {ev?.bestRaw
                            ? `بهترین اسپرد مشاهده‌شده ${formatPercentFa(ev.bestRaw, 2)}`
                            : "شواهدی ثبت نشده"}
                        </div>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {!certifications.length && !loading ? (
              <tr>
                <td colSpan={12}>
                  <div className="sa-empty">
                    <strong>هنوز گواهی منبعی ثبت نشده است</strong>
                    <span>پس از اولین چرخهٔ جمع‌آوری این جدول پر می‌شود.</span>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      <div className="panel-body sa-footnote">
        «زنده و تأییدشده» تنها پس از پاسخ عمومی واقعی و اعتبارسنجی واحد قیمت، جهت خرید/فروش و عمق داده
        می‌شود. آخرین بررسی:{" "}
        {certifications[0]?.lastProbeAt ? formatTehran(certifications[0].lastProbeAt) : "—"} (
        {formatAgoFa(certifications[0]?.lastProbeAt)}).
      </div>
    </section>
  );
}
