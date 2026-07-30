"use client";

import { useMemo } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import {
  TOOLTIP_FA,
  formatCountFa,
  formatDurationFa,
  formatPercentFa,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import type { CostRecord, ShadowAnalytics } from "@/components/shadowArbitrage/types";

type Props = {
  analytics: ShadowAnalytics | null;
  costRecords: CostRecord[];
  loading: boolean;
};

/** Horizontal bar, used instead of a chart library for compact distributions. */
function Bar({ value, max, tone }: { value: number; max: number; tone?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(2, (value / max) * 100)) : 0;
  return (
    <div className="sa-bar" aria-hidden="true">
      <div className={`sa-bar-fill${tone ? ` sa-bar-${tone}` : ""}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

/**
 * Section F — analytics from recorded data only. Nothing here is projected or
 * extrapolated; when there is too little data the panel says so.
 */
export function AnalyticsPanels({ analytics, costRecords, loading }: Props) {
  const routes = useMemo(() => analytics?.routes ?? [], [analytics]);
  const maxRouteSamples = routes.reduce((m, r) => Math.max(m, r.samples), 0);
  const blocked = analytics?.blockedByReason ?? [];
  const maxBlocked = blocked.reduce((m, b) => Math.max(m, b.count), 0);

  const rawOnlyRoutes = useMemo(
    () => routes.filter((r) => r.feeUnknown && (r.maxRawSpread ?? 0) > 0).slice(0, 12),
    [routes]
  );
  const netRoutes = useMemo(
    () => routes.filter((r) => !r.feeUnknown).slice(0, 12),
    [routes]
  );

  if (loading && !analytics) {
    return (
      <section className="panel sa-panel">
        <div className="panel-body">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="sa-skeleton-line" />
          ))}
        </div>
      </section>
    );
  }

  if (!analytics) {
    return (
      <section className="panel sa-panel">
        <div className="panel-body">
          <div className="sa-empty">
            <strong>تحلیلی در دسترس نیست</strong>
            <span>پس از چند چرخهٔ جمع‌آوری، تحلیل‌ها اینجا ساخته می‌شوند.</span>
          </div>
        </div>
      </section>
    );
  }

  const pnlEntries = Object.entries(analytics.estimatedNetPnlBySize);

  return (
    <>
      <section className="panel sa-panel">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">تحلیل دورهٔ پایش</h3>
          <div className="sa-panel-note">
            {analytics.collectedFrom ? formatTehran(analytics.collectedFrom) : "—"} تا{" "}
            {analytics.collectedTo ? formatTehran(analytics.collectedTo) : "—"}
          </div>
        </div>
        <div className="panel-body">
          {analytics.insufficientData ? (
            <div className="sa-callout sa-callout-warn">{analytics.dataNote}</div>
          ) : (
            <div className="sa-callout sa-callout-muted">{analytics.dataNote}</div>
          )}

          <div className="sa-cards sa-cards-compact">
            <div className="sa-card">
              <div className="sa-card-label">فرصت‌های یکتا</div>
              <div className="sa-card-value">{formatCountFa(analytics.uniqueLifecycles)}</div>
              <div className="sa-card-hint">هر فرصت یک‌بار، نه یک‌بار در هر چرخه</div>
            </div>
            <div className="sa-card">
              <div className="sa-card-label">مسیرهای سود خالص مثبت</div>
              <div className="sa-card-value">{formatCountFa(analytics.uniqueNetPositiveAllTime)}</div>
              <div className="sa-card-hint">با کارمزد معلوم در هر دو طرف</div>
            </div>
            <div className="sa-card">
              <div className="sa-card-label">مسیرهای فقط پتانسیل خام</div>
              <div className="sa-card-value">{formatCountFa(analytics.uniqueRawPotentialOnly)}</div>
              <div className="sa-card-hint">کارمزد تأییدنشده</div>
            </div>
            <div className="sa-card">
              <div className="sa-card-label">میانهٔ دوام فرصت</div>
              <div className="sa-card-value">{formatDurationFa(analytics.medianDurationMs)}</div>
              <div className="sa-card-hint">
                بیشینه: {formatDurationFa(analytics.maxDurationMs)}
              </div>
            </div>
            <div className="sa-card">
              <div className="sa-card-label">میانهٔ حاشیهٔ خالص</div>
              <div className="sa-card-value">
                {formatPercentFa(analytics.medianNetEdgePercent, 3)}
              </div>
              <div className="sa-card-hint">
                بیشینه: {formatPercentFa(analytics.maxNetEdgePercent, 3)}
              </div>
            </div>
            <div className="sa-card">
              <div className="sa-card-label">چرخه‌های ثبت‌شده</div>
              <div className="sa-card-value">{formatCountFa(analytics.runCount)}</div>
              <div className="sa-card-hint">
                موفق {formatCountFa(analytics.successfulRuns)} · جزئی{" "}
                {formatCountFa(analytics.partialRuns)} · ناموفق {formatCountFa(analytics.failedRuns)}
              </div>
            </div>
          </div>

          {pnlEntries.length ? (
            <>
              <h4 className="sa-subhead">سود خالص نظری به تفکیک حجم</h4>
              <div className="sa-inline-list">
                {pnlEntries.map(([size, pnl]) => (
                  <div key={size} className="sa-inline-item">
                    <span className="sa-inline-label">{toFaDigits(size)} تتر</span>
                    <TomanAmount value={pnl} />
                  </div>
                ))}
              </div>
              <div className="sa-footnote">
                مجموع سود نظری هر چرخهٔ عمر یکتا، فقط برای مسیرهایی که کارمزد هر دو طرف معلوم است.
              </div>
            </>
          ) : (
            <div className="sa-callout sa-callout-muted">
              هنوز هیچ مسیری با کارمزد معلوم و سود مثبت ثبت نشده است، بنابراین سود نظری به تفکیک حجم
              محاسبه نمی‌شود.
            </div>
          )}
        </div>
      </section>

      <section className="panel sa-panel">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">مسیرهای پرتکرار</h3>
        </div>
        <div className="panel-body sa-table-wrap">
          <table className="sa-table">
            <thead>
              <tr>
                <th>مسیر</th>
                <th className="num">حجم</th>
                <th className="num">نمونه</th>
                <th>فراوانی</th>
                <th className="num">بیشینه اسپرد خام</th>
                <th className="num">میانگین اسپرد خام</th>
                <th className="num">بیشینه حاشیهٔ خالص</th>
                <th>مبنای رتبه</th>
              </tr>
            </thead>
            <tbody>
              {routes.slice(0, 15).map((r) => (
                <tr key={r.routeKey}>
                  <td className="sa-route-cell">{r.routeKey.replace("->", " ← ").replace("@", " · ")}</td>
                  <td className="num">{toFaDigits(r.sizeUsdt)}</td>
                  <td className="num">{formatCountFa(r.samples)}</td>
                  <td>
                    <Bar value={r.samples} max={maxRouteSamples} />
                  </td>
                  <td className="num">{formatPercentFa(r.maxRawSpread, 3)}</td>
                  <td className="num">{formatPercentFa(r.avgRawSpread, 3)}</td>
                  <td className="num">
                    {r.feeUnknown ? "—" : formatPercentFa(r.maxEdge, 3)}
                  </td>
                  <td>
                    <span
                      className={`sa-chip sa-chip-${r.rankingBasis === "net" ? "muted" : "warn"} sa-chip-sm`}
                    >
                      {r.rankingBasis === "net" ? "سود خالص" : "پتانسیل خام"}
                    </span>
                  </td>
                </tr>
              ))}
              {!routes.length ? (
                <tr>
                  <td colSpan={8}>
                    <div className="sa-empty">
                      <strong>مسیری ثبت نشده</strong>
                      <span>پس از چند چرخه، مسیرها و فراوانی آن‌ها اینجا می‌آید.</span>
                    </div>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <div className="sa-grid-2">
        <section className="panel sa-panel">
          <details className="sa-details">
            <summary>کارایی و تأخیر منابع (پیشرفته)</summary>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>منبع</th>
                  <th className="num">دردسترس‌بودن</th>
                  <th className="num">نرخ خطا</th>
                  <th className="num" title={TOOLTIP_FA.p50}>p50</th>
                  <th className="num" title={TOOLTIP_FA.p95}>p95</th>
                  <th className="num">تازگی</th>
                </tr>
              </thead>
              <tbody>
                {analytics.sourceUptime.map((s) => (
                  <tr key={s.sourceId}>
                    <td>{s.sourceName}</td>
                    <td className="num">{formatPercentFa(s.uptimePercent, 1)}</td>
                    <td className="num">{formatPercentFa(s.errorRatePercent, 1)}</td>
                    <td className="num">{s.latencyP50Ms != null ? `${toFaDigits(s.latencyP50Ms)}` : "—"}</td>
                    <td className="num">{s.latencyP95Ms != null ? `${toFaDigits(s.latencyP95Ms)}` : "—"}</td>
                    <td className="num">{formatPercentFa(s.freshnessPercent, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </details>
        </section>

        <section className="panel sa-panel">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title sa-panel-title">دلایل مسدودشدن فرصت‌ها</h3>
          </div>
          <div className="panel-body">
            {blocked.length ? (
              <div className="sa-bars">
                {blocked.slice(0, 10).map((b) => (
                  <div key={b.reason} className="sa-bar-row">
                    <span className="sa-bar-label">{b.label}</span>
                    <Bar value={b.count} max={maxBlocked} tone="warn" />
                    <span className="sa-bar-value">{formatCountFa(b.count)}</span>
                  </div>
                ))}
                <div className="sa-footnote">شمارش مربوط به آخرین چرخهٔ جمع‌آوری است.</div>
              </div>
            ) : (
              <div className="sa-empty">
                <strong>موردی ثبت نشده</strong>
                <span>هیچ فرصتی در آخرین چرخه مسدود نشده است.</span>
              </div>
            )}
          </div>
        </section>
      </div>

      {rawOnlyRoutes.length ? (
        <section className="panel sa-panel">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title sa-panel-title">
              مسیرهای با کارمزد نامشخص (فقط پتانسیل خام)
            </h3>
          </div>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>مسیر</th>
                  <th className="num">حجم</th>
                  <th className="num">بیشینه اسپرد خام</th>
                  <th className="num">میانگین اسپرد خام</th>
                  <th className="num">نمونه</th>
                </tr>
              </thead>
              <tbody>
                {rawOnlyRoutes.map((r) => (
                  <tr key={r.routeKey}>
                    <td className="sa-route-cell">
                      {r.routeKey.replace("->", " ← ").replace("@", " · ")}
                    </td>
                    <td className="num">{toFaDigits(r.sizeUsdt)}</td>
                    <td className="num">{formatPercentFa(r.maxRawSpread, 3)}</td>
                    <td className="num">{formatPercentFa(r.avgRawSpread, 3)}</td>
                    <td className="num">{formatCountFa(r.samples)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="sa-footnote">
              این ارقام سود انتظاری نیستند. تا زمانی که کارمزد رسمی هر دو طرف تأیید نشود، نتیجه فقط
              «پتانسیل خام» است.
            </div>
          </div>
        </section>
      ) : null}

      {netRoutes.length ? (
        <section className="panel sa-panel">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title sa-panel-title">مسیرهای با کارمزد معلوم</h3>
          </div>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>مسیر</th>
                  <th className="num">حجم</th>
                  <th className="num">بیشینه حاشیهٔ خالص</th>
                  <th className="num">میانگین حاشیهٔ خالص</th>
                  <th className="num">چرخه‌های سودده</th>
                </tr>
              </thead>
              <tbody>
                {netRoutes.map((r) => (
                  <tr key={r.routeKey}>
                    <td className="sa-route-cell">
                      {r.routeKey.replace("->", " ← ").replace("@", " · ")}
                    </td>
                    <td className="num">{toFaDigits(r.sizeUsdt)}</td>
                    <td className="num">{formatPercentFa(r.maxEdge, 3)}</td>
                    <td className="num">{formatPercentFa(r.medianEdge, 3)}</td>
                    <td className="num">{formatCountFa(r.count)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {costRecords.length ? (
        <section className="panel sa-panel">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title sa-panel-title">فرض‌های هزینه</h3>
            <div className="sa-panel-note">همه موقت</div>
          </div>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>مورد</th>
                  <th className="num">مقدار</th>
                  <th>وضعیت</th>
                  <th>بازبینی</th>
                  <th>توضیح</th>
                </tr>
              </thead>
              <tbody>
                {costRecords.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td className="num">
                      {c.unit === "bps_of_buy_cost"
                        ? `${formatPercentFa(c.value / 100, 3)} از هزینهٔ خرید`
                        : <TomanAmount value={c.value} />}
                    </td>
                    <td>
                      <span className="sa-chip sa-chip-warn sa-chip-sm">موقت</span>
                    </td>
                    <td>{c.verifiedAt ?? "—"}</td>
                    <td className="sa-wrap-cell">{c.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </>
  );
}
