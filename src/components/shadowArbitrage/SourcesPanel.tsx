"use client";

import { useMemo, useState } from "react";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import {
  CERT_FA,
  MARKET_MODEL_FA,
  certTone,
  formatAgoFa,
  formatCountFa,
  formatPercentFa,
  freshnessLabel,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import {
  ACCOUNT_STATE_FA,
  API_CAPABILITY_FA,
  DEBIT_MODE_FA,
  FEE_ASSET_FA,
  FEE_PROVENANCE_FA,
  SETTLEMENT_PROVENANCE_FA,
  buildVenueRows,
  summarizeVenues,
  type FeeConfirmationAudit,
  type VenueReadiness,
  type VenueRow
} from "@/components/shadowArbitrage/sourcesModel";
import type { SideSettlement } from "@/lib/shadowArbitrage/paper/broker";
import type {
  Certification,
  NormalizedSourceSnapshot,
  SourceHealthRow
} from "@/components/shadowArbitrage/types";

type Props = {
  certifications: Certification[];
  health: SourceHealthRow[];
  snapshots: NormalizedSourceSnapshot[];
  venues: VenueReadiness[];
  auditHistory: FeeConfirmationAudit[];
  feeReverifyDays: number | null;
  pollIntervalMs: number;
  loading: boolean;
  error: string | null;
  onReload: () => void;
};

/**
 * Phase 8B — the «منابع و کارمزدها» tab.
 *
 * Source and data health is presented separately from account and fee
 * readiness: a venue can be perfectly healthy and still be untradeable, and one
 * very wide table hides exactly that distinction. Every value is server-supplied
 * — a field the API did not return renders as «—» with the reason.
 *
 * No credential of any kind is requested, displayed or stored here. The only
 * write is the existing append-only fee-evidence confirmation.
 */
export function SourcesPanel({
  certifications,
  health,
  snapshots,
  venues,
  auditHistory,
  feeReverifyDays,
  pollIntervalMs,
  loading,
  error,
  onReload
}: Props) {
  const rows = useMemo(
    () =>
      buildVenueRows({
        certifications,
        health,
        snapshots,
        venues,
        feeReverifyDays
      }),
    [certifications, health, snapshots, venues, feeReverifyDays]
  );
  const summary = useMemo(() => summarizeVenues(rows), [rows]);

  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ takerFeeBps: "", feeTier: "", sourceUrl: "", note: "" });
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (sourceId: string) => {
    setNotice(null);
    try {
      const res = await fetch("/api/shadow-arbitrage/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          sourceId,
          takerFeeBps: Number(form.takerFeeBps),
          feeTier: form.feeTier || null,
          sourceUrl: form.sourceUrl || null,
          note: form.note || null
        })
      });
      const j = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(j?.message ?? "ثبت ناموفق بود");
      setNotice("کارمزد ثبت شد و در سابقه نگهداری می‌شود.");
      setEditing(null);
      setForm({ takerFeeBps: "", feeTier: "", sourceUrl: "", note: "" });
      onReload();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "ثبت ناموفق بود");
    }
  };

  if (error) {
    return (
      <section className="panel sa-panel sa-empty" role="alert">
        <strong>دریافت وضعیت منابع ممکن نشد</strong>
        <span>{error}</span>
      </section>
    );
  }

  if (loading && !rows.length) {
    return (
      <section className="panel sa-panel" aria-busy="true">
        <div className="panel-body sa-op-skeleton">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="sa-skeleton-line" />
          ))}
        </div>
      </section>
    );
  }

  if (!rows.length) {
    return (
      <section className="panel sa-panel sa-empty">
        <strong>هنوز منبعی ثبت نشده است</strong>
        <span>پس از نخستین چرخهٔ جمع‌آوری، وضعیت هر ۹ منبع اینجا نمایش داده می‌شود.</span>
      </section>
    );
  }

  const partial = venues.length === 0;

  return (
    <div className="sa-sr">
      {partial ? (
        <div className="sa-callout sa-callout-warn" role="status">
          وضعیت حساب و کارمزد در این بارگذاری دریافت نشد؛ ستون‌های مربوط به آن «—» نمایش داده
          می‌شوند. سلامت منابع همچنان معتبر است.
        </div>
      ) : null}

      {/* Compact summary — health and readiness counted separately. */}
      <section className="panel sa-panel sa-sr-summary" aria-label="خلاصهٔ وضعیت منابع">
        <div className="panel-body sa-sr-summary-grid">
          <Stat
            label="منابع سالم"
            value={<Bidi>{`${toFaDigits(summary.healthy)} / ${toFaDigits(summary.total)}`}</Bidi>}
            hint="در آخرین چرخه پاسخ سالم دادند"
            tone={summary.healthy >= 7 ? "good" : summary.healthy >= 4 ? "warn" : "danger"}
          />
          <Stat
            label="حساب‌های آماده"
            value={<Bidi>{`${toFaDigits(summary.accountsReady)} / ${toFaDigits(summary.total)}`}</Bidi>}
            hint="حساب احرازشده و قابل استفاده"
            tone={summary.accountsReady ? "good" : "muted"}
          />
          <Stat
            label="کارمزد معتبر"
            value={<Bidi>{`${toFaDigits(summary.feesCurrent)} / ${toFaDigits(summary.total)}`}</Bidi>}
            hint={`نیازمند بازبینی: ${toFaDigits(summary.feesStale)} · نامشخص: ${toFaDigits(summary.feesUnknown)}`}
            tone={summary.feesCurrent ? "good" : "warn"}
          />
          <Stat
            label="منابع دارای اختلال"
            value={<Bidi>{`${toFaDigits(summary.degraded + summary.unavailable)} / ${toFaDigits(summary.total)}`}</Bidi>}
            hint={`فقط مرجع: ${toFaDigits(summary.referenceOnly)} منبع`}
            tone={summary.degraded + summary.unavailable ? "warn" : "muted"}
          />
        </div>
      </section>

      {/* 1 — source and data health. */}
      <section className="panel sa-panel" aria-label="سلامت منبع و داده">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">سلامت منبع و داده</h3>
          <div className="sa-panel-note">
            آخرین بررسی:{" "}
            {rows[0]?.lastProbeAt ? formatTehran(rows[0].lastProbeAt) : "—"} (
            {formatAgoFa(rows[0]?.lastProbeAt ?? null)})
          </div>
        </div>
        <div className="panel-body sa-table-wrap sa-sr-table-wrap">
          <table className="sa-table sa-sr-table">
            <thead>
              <tr>
                <th scope="col">صرافی و بازار</th>
                <th scope="col">وضعیت منبع</th>
                <th scope="col">تازگی داده</th>
                <th scope="col" className="num">در دسترس‌بودن</th>
                <th scope="col" className="num">نرخ خطا</th>
                <th scope="col" className="num">تأخیر پاسخ</th>
                <th scope="col">آخرین خطا</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const fresh = freshnessLabel(r.ageMs, pollIntervalMs);
                return (
                  <tr key={`h-${r.sourceId}`}>
                    <td>
                      <VenueName row={r} />
                    </td>
                    <td>
                      <span className={`sa-chip sa-chip-sm sa-chip-${certTone(r.certStatus ?? "")}`}>
                        {r.certStatus ? (CERT_FA[r.certStatus] ?? r.certStatus) : "—"}
                      </span>
                      <div className="sa-sr-sub">
                        {r.marketModel ? (MARKET_MODEL_FA[r.marketModel] ?? r.marketModel) : "—"}
                      </div>
                    </td>
                    <td>
                      <span className={`sa-fresh sa-fresh-${fresh.tone}`}>{fresh.label}</span>
                      <div className="sa-sr-sub">
                        سهم تازگی: <Bidi>{formatPercentFa(r.freshnessPercent, 0)}</Bidi>
                      </div>
                    </td>
                    <td className="num">
                      <Bidi>{formatPercentFa(r.availabilityPercent, 1)}</Bidi>
                      <div className="sa-sr-sub">
                        {r.samples !== null ? `${formatCountFa(r.samples)} نمونه` : "—"}
                      </div>
                    </td>
                    <td className="num">
                      <Bidi>{formatPercentFa(r.errorRatePercent, 1)}</Bidi>
                    </td>
                    <td className="num">
                      <Bidi>
                        {r.latencyP50Ms !== null ? `p50 ${toFaDigits(r.latencyP50Ms)}ms` : "—"}
                      </Bidi>
                      <div className="sa-sr-sub">
                        <Bidi>
                          {r.latencyP95Ms !== null ? `p95 ${toFaDigits(r.latencyP95Ms)}ms` : "—"}
                        </Bidi>
                      </div>
                    </td>
                    <td className="sa-wrap-cell">
                      {r.lastError ? (
                        <>
                          <span>{r.lastError}</span>
                          {r.lastErrorAt ? (
                            <div className="sa-sr-sub">{formatAgoFa(r.lastErrorAt)}</div>
                          ) : null}
                        </>
                      ) : (
                        <span className="sa-sr-sub">خطایی ثبت نشده</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* 2 — account and fee readiness, including per-side settlement. */}
      <section className="panel sa-panel" aria-label="آمادگی حساب و کارمزد">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">آمادگی حساب و کارمزد</h3>
          <div className="sa-panel-note">
            {feeReverifyDays ? `بازبینی کارمزد هر ${toFaDigits(feeReverifyDays)} روز · ` : ""}
            بدون کلید API
          </div>
        </div>

        {notice ? (
          <div className="panel-body">
            <div className="sa-callout sa-callout-muted">{notice}</div>
          </div>
        ) : null}

        <div className="panel-body sa-table-wrap sa-sr-table-wrap">
          <table className="sa-table sa-sr-table">
            <thead>
              <tr>
                <th scope="col">صرافی</th>
                <th scope="col">وضعیت حساب</th>
                <th scope="col" className="num">کارمزد taker خرید</th>
                <th scope="col" className="num">کارمزد taker فروش</th>
                <th scope="col">تسویهٔ کارمزد خرید</th>
                <th scope="col">تسویهٔ کارمزد فروش</th>
                <th scope="col">اعتبار کارمزد</th>
                <th scope="col">اقدام لازم</th>
                <th scope="col">دلیل مسدودی</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`a-${r.sourceId}`}>
                  <td>
                    <VenueName row={r} />
                    <div className="sa-sr-sub">
                      {r.apiCapabilities.length
                        ? r.apiCapabilities.map((c) => API_CAPABILITY_FA[c] ?? c).join("، ")
                        : "—"}
                    </div>
                  </td>
                  <td>
                    {r.accountState ? (
                      <span
                        className={`sa-chip sa-chip-sm sa-chip-${
                          r.accountState === "VERIFIED"
                            ? "good"
                            : r.accountState === "NEEDS_ACCOUNT"
                              ? "warn"
                              : "muted"
                        }`}
                      >
                        {ACCOUNT_STATE_FA[r.accountState]}
                      </span>
                    ) : (
                      <span title="وضعیت حساب گزارش نشده است">—</span>
                    )}
                  </td>
                  <td className="num">
                    <FeeValue bps={r.takerFeeBps} provenance={r.feeProvenance} />
                  </td>
                  <td className="num">
                    <FeeValue bps={r.takerFeeBps} provenance={r.feeProvenance} />
                  </td>
                  <td>
                    <Settlement side={r.buySettlement} />
                  </td>
                  <td>
                    <Settlement side={r.sellSettlement} />
                  </td>
                  <td>
                    <div className="sa-sr-stack">
                      <span>
                        {r.feeProvenance ? FEE_PROVENANCE_FA[r.feeProvenance] : "—"}
                      </span>
                      <span className="sa-sr-sub">
                        تأیید: {r.feeVerifiedAt ? formatTehran(r.feeVerifiedAt) : "—"}
                      </span>
                      <span className={`sa-sr-sub${r.feeStale ? " sa-neg" : ""}`}>
                        انقضا: {r.feeExpiresAt ? formatTehran(r.feeExpiresAt) : "—"}
                        {r.feeStale ? " · منقضی شده" : ""}
                      </span>
                    </div>
                  </td>
                  <td className="sa-wrap-cell">{r.requiredAction ?? "—"}</td>
                  <td className="sa-wrap-cell">{r.blockingReason ?? "—"}</td>
                  <td>
                    {r.referenceOnly ? null : (
                      <button
                        type="button"
                        className="sa-op-clear glass-control"
                        onClick={() => setEditing(editing === r.sourceId ? null : r.sourceId)}
                        aria-expanded={editing === r.sourceId}
                      >
                        ثبت کارمزد
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panel-body sa-footnote">
          کارمزد taker هر صرافی روی هر دو طرف همان صرافی اعمال می‌شود؛ آنچه بین دو طرف تفاوت دارد
          دارایی تسویه و نحوهٔ کسر آن است. «آرزینجا» فقط مرجع است و هیچ‌گاه مبنای اجرا قرار نمی‌گیرد.
        </div>

        {editing ? (
          <div className="panel-body sa-sr-form">
            <label className="sa-op-field">
              <span className="sa-op-field-label">کارمزد taker (در ده‌هزار)</span>
              <input
                className="sa-input glass-control sa-op-control"
                inputMode="numeric"
                value={form.takerFeeBps}
                onChange={(e) => setForm((f) => ({ ...f, takerFeeBps: e.target.value }))}
                placeholder="مثلاً ۲۵ برای ۰٫۲۵٪"
              />
            </label>
            <label className="sa-op-field">
              <span className="sa-op-field-label">نام پله</span>
              <input
                className="sa-input glass-control sa-op-control"
                value={form.feeTier}
                onChange={(e) => setForm((f) => ({ ...f, feeTier: e.target.value }))}
              />
            </label>
            <label className="sa-op-field">
              <span className="sa-op-field-label">نشانی سند رسمی</span>
              <input
                className="sa-input glass-control sa-op-control"
                value={form.sourceUrl}
                onChange={(e) => setForm((f) => ({ ...f, sourceUrl: e.target.value }))}
              />
            </label>
            <label className="sa-op-field">
              <span className="sa-op-field-label">توضیح</span>
              <input
                className="sa-input glass-control sa-op-control"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              />
            </label>
            <button
              type="button"
              className="sa-op-clear glass-control"
              onClick={() => void submit(editing)}
            >
              ثبت برای {rows.find((r) => r.sourceId === editing)?.nameFa}
            </button>
            <div className="sa-footnote">
              فقط شواهد کارمزد ثبت می‌شود. هیچ کلید API، رمز یا دسترسی حسابی در این مرحله دریافت یا
              ذخیره نمی‌شود.
            </div>
          </div>
        ) : null}

        {auditHistory.length ? (
          <div className="panel-body">
            <details className="sa-details">
              <summary>سابقهٔ تأیید کارمزد ({toFaDigits(auditHistory.length)} رکورد)</summary>
              <div className="sa-table-wrap sa-sr-table-wrap">
                <table className="sa-table sa-sr-table">
                  <thead>
                    <tr>
                      <th scope="col">صرافی</th>
                      <th scope="col" className="num">کارمزد</th>
                      <th scope="col">پله</th>
                      <th scope="col">ثبت‌کننده</th>
                      <th scope="col">زمان</th>
                      <th scope="col">توضیح</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditHistory.map((a) => (
                      <tr key={a.id}>
                        <td>{rows.find((r) => r.sourceId === a.sourceId)?.nameFa ?? a.sourceId}</td>
                        <td className="num">
                          <Bidi>{formatPercentFa(a.takerFeeBps / 100, 3)}</Bidi>
                        </td>
                        <td>{a.feeTier ?? "—"}</td>
                        <td>{a.confirmedBy}</td>
                        <td className="text-micro">{formatTehran(a.confirmedAt)}</td>
                        <td className="sa-wrap-cell">{a.note ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </div>
        ) : null}
      </section>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
  tone: "good" | "warn" | "danger" | "muted";
}) {
  return (
    <div className={`sa-sr-stat sa-rail-${tone}`}>
      <div className="sa-sr-stat-label">{label}</div>
      <div className="sa-sr-stat-value">{value}</div>
      <div className="sa-sr-stat-hint">{hint}</div>
    </div>
  );
}

/** Persian venue name, its market symbol, and the reference-only marking. */
function VenueName({ row }: { row: VenueRow }) {
  return (
    <div className="sa-sr-venue">
      <strong>{row.nameFa}</strong>
      {row.referenceOnly ? (
        <span
          className="sa-chip sa-chip-sm sa-chip-muted sa-sr-reference"
          title="این منبع فقط برای مقایسه است و هیچ‌گاه مبنای اجرا قرار نمی‌گیرد"
        >
          فقط مرجع
        </span>
      ) : null}
      <div className="sa-sr-sub">
        <Bidi>{row.marketSymbol ?? "—"}</Bidi>
      </div>
    </div>
  );
}

function FeeValue({
  bps,
  provenance
}: {
  bps: number | null;
  provenance: VenueRow["feeProvenance"];
}) {
  if (bps === null) {
    return (
      <span title="کارمزد این صرافی هنوز تأیید نشده است">—</span>
    );
  }
  return (
    <div className="sa-sr-stack">
      <Bidi>{formatPercentFa(bps / 100, 3)}</Bidi>
      <span className="sa-sr-sub">{provenance ? FEE_PROVENANCE_FA[provenance] : "—"}</span>
    </div>
  );
}

/** Settlement asset and debit mode for one side of one venue. */
function Settlement({ side }: { side: SideSettlement }) {
  const unknown = side.feeAsset === "UNKNOWN" || side.debitMode === "UNKNOWN";
  return (
    <div className="sa-sr-stack">
      <span
        className={`sa-chip sa-chip-sm sa-chip-${unknown ? "warn" : "muted"}`}
        title={
          unknown
            ? "دارایی تسویه و نحوهٔ کسر کارمزد برای این طرف تأیید نشده است؛ اجرا مسدود می‌ماند."
            : "دارایی تسویه و نحوهٔ کسر کارمزد برای این طرف تأیید شده است."
        }
      >
        {FEE_ASSET_FA[side.feeAsset] ?? side.feeAsset}
      </span>
      <span className="sa-sr-sub">{DEBIT_MODE_FA[side.debitMode] ?? side.debitMode}</span>
      <span className="sa-sr-sub">
        {SETTLEMENT_PROVENANCE_FA[side.provenance] ?? side.provenance}
      </span>
    </div>
  );
}
