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
import { Kpi, Pager } from "@/components/shadowArbitrage/panelKit";
import { paginate } from "@/components/shadowArbitrage/opportunityModel";
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
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";
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

type SourcesView = "health" | "accounts";

const VIEWS: Array<{ id: SourcesView; labelFa: string; descriptionFa: string }> = [
  {
    id: "health",
    labelFa: "سلامت منابع",
    descriptionFa: "آیا این منبع در چرخه‌های اخیر پاسخ سالم و تازه داده است"
  },
  {
    id: "accounts",
    labelFa: "حساب‌ها و کارمزدها",
    descriptionFa: "آیا اصلاً می‌توان روی این صرافی معامله کرد و کارمزد آن معتبر است"
  }
];

/** Six cards a page keeps the grid one screen tall at every width. */
const VENUES_PER_PAGE = 6;

function parseView(value: string): SourcesView {
  return value === "accounts" ? "accounts" : "health";
}

/**
 * Phase 8B — the «منابع و کارمزدها» tab.
 *
 * Source and data health is shown separately from account and fee readiness: a
 * venue can be perfectly healthy and still be untradeable, and one very wide
 * table hides exactly that distinction. Only the selected dataset is rendered,
 * as venue cards rather than a table that would be clipped on a phone.
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
  const { read, write } = useShadowViewState();
  const view = parseView(read("sv", "health"));
  const requestedPage = readInt(read("spage", "1"), 1, 1, 999);

  const rows = useMemo(
    () => buildVenueRows({ certifications, health, snapshots, venues, feeReverifyDays }),
    [certifications, health, snapshots, venues, feeReverifyDays]
  );
  const summary = useMemo(() => summarizeVenues(rows), [rows]);
  const page = useMemo(() => paginate(rows, requestedPage, VENUES_PER_PAGE), [rows, requestedPage]);

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
        <div className="panel-body sa-skel">
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

  const current = VIEWS.find((v) => v.id === view)!;
  const partial = venues.length === 0;

  return (
    <div className="sa-stack">
      {partial ? (
        <div className="sa-callout sa-callout-warn" role="status">
          وضعیت حساب و کارمزد در این بارگذاری دریافت نشد؛ مقادیر مربوط به آن «—» نمایش داده
          می‌شوند. سلامت منابع همچنان معتبر است.
        </div>
      ) : null}

      <div className="sa-kpi-grid">
        <Kpi
          label="منابع سالم"
          value={<Bidi>{`${toFaDigits(summary.healthy)} / ${toFaDigits(summary.total)}`}</Bidi>}
          hint="در آخرین چرخه پاسخ سالم دادند"
          tone={summary.healthy >= 7 ? "good" : summary.healthy >= 4 ? "warn" : "danger"}
        />
        <Kpi
          label="حساب‌های آماده"
          value={<Bidi>{`${toFaDigits(summary.accountsReady)} / ${toFaDigits(summary.total)}`}</Bidi>}
          hint="حساب احرازشده و قابل استفاده"
          tone={summary.accountsReady ? "good" : "muted"}
        />
        <Kpi
          label="کارمزد معتبر"
          value={<Bidi>{`${toFaDigits(summary.feesCurrent)} / ${toFaDigits(summary.total)}`}</Bidi>}
          hint={`نیازمند بازبینی: ${toFaDigits(summary.feesStale)} · نامشخص: ${toFaDigits(summary.feesUnknown)}`}
          tone={summary.feesCurrent ? "good" : "warn"}
        />
        <Kpi
          label="منابع دارای اختلال"
          value={
            <Bidi>{`${toFaDigits(summary.degraded + summary.unavailable)} / ${toFaDigits(summary.total)}`}</Bidi>
          }
          hint={`فقط مرجع: ${toFaDigits(summary.referenceOnly)} منبع`}
          tone={summary.degraded + summary.unavailable ? "warn" : "muted"}
        />
      </div>

      <div className="sa-segmented sa-segmented-lg glass-tabbar" role="tablist" aria-label="نمای منابع">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            aria-selected={view === v.id}
            className={`sa-seg sa-seg-lg${view === v.id ? " is-active glass-control" : ""}`}
            onClick={() => write({ sv: v.id, spage: "1" })}
          >
            {v.labelFa}
          </button>
        ))}
      </div>

      <section className="panel sa-panel" aria-label={current.labelFa}>
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">{current.labelFa}</h3>
          <div className="sa-panel-note">
            {formatCountFa(rows.length)} صرافی · {current.descriptionFa}
          </div>
        </div>

        {notice ? (
          <div className="panel-body">
            <div className="sa-callout sa-callout-muted">{notice}</div>
          </div>
        ) : null}

        <div className="panel-body sa-venue-grid">
          {page.rows.map((r) =>
            view === "health" ? (
              <HealthCard key={r.sourceId} row={r} pollIntervalMs={pollIntervalMs} />
            ) : (
              <AccountCard
                key={r.sourceId}
                row={r}
                onEdit={() => setEditing(editing === r.sourceId ? null : r.sourceId)}
                editing={editing === r.sourceId}
              />
            )
          )}
        </div>

        <Pager
          page={page.page}
          pageCount={page.pageCount}
          total={page.total}
          from={page.from}
          to={page.to}
          perPage={VENUES_PER_PAGE}
          onPage={(p) => write({ spage: String(p) })}
        />

        {view === "health" ? (
          <div className="panel-body sa-footnote">
            «زنده و تأییدشده» تنها پس از پاسخ عمومی واقعی و اعتبارسنجی واحد قیمت، جهت خرید/فروش و
            عمق داده می‌شود. آخرین بررسی:{" "}
            {rows[0]?.lastProbeAt ? formatTehran(rows[0].lastProbeAt) : "—"} (
            {formatAgoFa(rows[0]?.lastProbeAt ?? null)}).
          </div>
        ) : (
          <div className="panel-body sa-footnote">
            کارمزد taker هر صرافی روی هر دو طرف همان صرافی اعمال می‌شود؛ آنچه بین دو طرف تفاوت دارد
            دارایی تسویه و نحوهٔ کسر آن است. «آرزینجا» فقط مرجع است و هیچ‌گاه مبنای اجرا قرار
            نمی‌گیرد.
            {feeReverifyDays ? ` بازبینی کارمزد هر ${toFaDigits(feeReverifyDays)} روز.` : ""} هیچ
            کلید API یا اطلاعات محرمانه‌ای در این صفحه دریافت یا ذخیره نمی‌شود.
          </div>
        )}
      </section>

      {editing && view === "accounts" ? (
        <section className="panel sa-panel" aria-label="ثبت کارمزد">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">
              ثبت کارمزد برای {rows.find((r) => r.sourceId === editing)?.nameFa}
            </h3>
            <div className="sa-panel-note">فقط شواهد کارمزد · بدون کلید API</div>
          </div>
          <div className="panel-body sa-form-grid">
            <label className="sa-field">
              <span className="sa-field-label">کارمزد taker (در ده‌هزار)</span>
              <input
                className="sa-control glass-control"
                inputMode="numeric"
                value={form.takerFeeBps}
                onChange={(e) => setForm((f) => ({ ...f, takerFeeBps: e.target.value }))}
                placeholder="مثلاً ۲۵ برای ۰٫۲۵٪"
              />
            </label>
            <label className="sa-field">
              <span className="sa-field-label">نام پله</span>
              <input
                className="sa-control glass-control"
                value={form.feeTier}
                onChange={(e) => setForm((f) => ({ ...f, feeTier: e.target.value }))}
              />
            </label>
            <label className="sa-field">
              <span className="sa-field-label">نشانی سند رسمی</span>
              <input
                className="sa-control glass-control"
                value={form.sourceUrl}
                onChange={(e) => setForm((f) => ({ ...f, sourceUrl: e.target.value }))}
              />
            </label>
            <label className="sa-field">
              <span className="sa-field-label">توضیح</span>
              <input
                className="sa-control glass-control"
                value={form.note}
                onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
              />
            </label>
            <button
              type="button"
              className="sa-btn-clear glass-control"
              onClick={() => void submit(editing)}
            >
              ثبت کارمزد
            </button>
          </div>
        </section>
      ) : null}

      {view === "accounts" && auditHistory.length ? (
        <section className="panel sa-panel" aria-label="سابقهٔ تأیید کارمزد">
          <div className="panel-header sa-panel-header">
            <h3 className="panel-title">سابقهٔ تأیید کارمزد</h3>
            <div className="sa-panel-note">{formatCountFa(auditHistory.length)} رکورد · افزودنی</div>
          </div>
          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
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
                    <td>{formatTehran(a.confirmedAt)}</td>
                    <td className="sa-wrap-cell">{a.note ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </div>
  );
}

/* ── venue cards ───────────────────────────────────────────────────────────── */

function VenueHead({ row, chip }: { row: VenueRow; chip: React.ReactNode }) {
  return (
    <header className="sa-venue-head">
      <div className="sa-venue-name">
        <strong>{row.nameFa}</strong>
        <span className="sa-sub">
          <Bidi>{row.marketSymbol ?? "—"}</Bidi>
          {row.marketModel ? ` · ${MARKET_MODEL_FA[row.marketModel] ?? row.marketModel}` : ""}
        </span>
      </div>
      <div className="sa-venue-chips">
        {chip}
        {row.referenceOnly ? (
          <span
            className="sa-chip sa-chip-sm sa-chip-muted"
            title="این منبع فقط برای مقایسه است و هیچ‌گاه مبنای اجرا قرار نمی‌گیرد"
          >
            فقط مرجع
          </span>
        ) : null}
      </div>
    </header>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="sa-venue-metric">
      <span className="sa-venue-metric-label">{label}</span>
      <span className="sa-venue-metric-value">{value}</span>
    </div>
  );
}

function HealthCard({ row, pollIntervalMs }: { row: VenueRow; pollIntervalMs: number }) {
  const fresh = freshnessLabel(row.ageMs, pollIntervalMs);
  return (
    <article className="panel sa-panel sa-venue-card">
      <div className="panel-body">
        <VenueHead
          row={row}
          chip={
            <span className={`sa-chip sa-chip-sm sa-chip-${certTone(row.certStatus ?? "")}`}>
              {row.certStatus ? (CERT_FA[row.certStatus] ?? row.certStatus) : "—"}
            </span>
          }
        />
        <div className="sa-venue-metrics">
          <Metric
            label="تازگی داده"
            value={<span className={`sa-fresh sa-fresh-${fresh.tone}`}>{fresh.label}</span>}
          />
          <Metric label="در دسترس‌بودن" value={<Bidi>{formatPercentFa(row.availabilityPercent, 1)}</Bidi>} />
          <Metric label="نرخ خطا" value={<Bidi>{formatPercentFa(row.errorRatePercent, 1)}</Bidi>} />
          <Metric
            label="تأخیر پاسخ"
            value={
              <Bidi>
                {row.latencyP50Ms !== null ? `p50 ${toFaDigits(row.latencyP50Ms)}ms` : "—"}
                {row.latencyP95Ms !== null ? ` · p95 ${toFaDigits(row.latencyP95Ms)}ms` : ""}
              </Bidi>
            }
          />
        </div>
        <details className="sa-venue-details">
          <summary>جزئیات</summary>
          <div className="sa-venue-detail-body">
            <Metric label="سهم تازگی" value={<Bidi>{formatPercentFa(row.freshnessPercent, 0)}</Bidi>} />
            <Metric
              label="نمونه‌های ثبت‌شده"
              value={row.samples !== null ? formatCountFa(row.samples) : "—"}
            />
            <Metric
              label="آخرین خطا"
              value={
                row.lastError ? (
                  <>
                    {row.lastError}
                    {row.lastErrorAt ? <span className="sa-sub"> · {formatAgoFa(row.lastErrorAt)}</span> : null}
                  </>
                ) : (
                  "خطایی ثبت نشده"
                )
              }
            />
            <Metric
              label="آخرین بررسی"
              value={row.lastProbeAt ? formatTehran(row.lastProbeAt) : "—"}
            />
          </div>
        </details>
      </div>
    </article>
  );
}

function AccountCard({
  row,
  onEdit,
  editing
}: {
  row: VenueRow;
  onEdit: () => void;
  editing: boolean;
}) {
  return (
    <article className="panel sa-panel sa-venue-card">
      <div className="panel-body">
        <VenueHead
          row={row}
          chip={
            row.accountState ? (
              <span
                className={`sa-chip sa-chip-sm sa-chip-${
                  row.accountState === "VERIFIED"
                    ? "good"
                    : row.accountState === "NEEDS_ACCOUNT"
                      ? "warn"
                      : "muted"
                }`}
              >
                {ACCOUNT_STATE_FA[row.accountState]}
              </span>
            ) : (
              <span className="sa-chip sa-chip-sm sa-chip-muted">وضعیت نامشخص</span>
            )
          }
        />
        <div className="sa-venue-metrics">
          <Metric
            label="کارمزد taker"
            value={
              row.takerFeeBps !== null ? (
                <Bidi>{formatPercentFa(row.takerFeeBps / 100, 3)}</Bidi>
              ) : (
                <span className="sa-unknown" title="کارمزد این صرافی هنوز تأیید نشده است">
                  —
                </span>
              )
            }
          />
          <Metric
            label="اعتبار کارمزد"
            value={
              <span className={row.feeStale ? "sa-neg" : undefined}>
                {row.feeProvenance ? FEE_PROVENANCE_FA[row.feeProvenance] : "—"}
                {row.feeStale ? " · منقضی" : ""}
              </span>
            }
          />
          <Metric
            label="تسویهٔ کارمزد خرید"
            value={<Settlement side={row.buySettlement} />}
          />
          <Metric
            label="تسویهٔ کارمزد فروش"
            value={<Settlement side={row.sellSettlement} />}
          />
        </div>
        <details className="sa-venue-details">
          <summary>جزئیات</summary>
          <div className="sa-venue-detail-body">
            <Metric
              label="تاریخ تأیید"
              value={row.feeVerifiedAt ? formatTehran(row.feeVerifiedAt) : "—"}
            />
            <Metric
              label="انقضای اعتبار"
              value={row.feeExpiresAt ? formatTehran(row.feeExpiresAt) : "—"}
            />
            <Metric label="پلهٔ کارمزد" value={row.feeTier ?? "—"} />
            <Metric
              label="توان API"
              value={
                row.apiCapabilities.length
                  ? row.apiCapabilities.map((c) => API_CAPABILITY_FA[c] ?? c).join("، ")
                  : "—"
              }
            />
            <Metric label="اقدام لازم" value={row.requiredAction ?? "—"} />
            <Metric label="دلیل مسدودی" value={row.blockingReason ?? "—"} />
            {row.referenceOnly ? null : (
              <button
                type="button"
                className="sa-btn-details glass-control"
                onClick={onEdit}
                aria-expanded={editing}
              >
                ثبت کارمزد
              </button>
            )}
          </div>
        </details>
      </div>
    </article>
  );
}

/** Settlement asset and debit mode for one side of one venue. */
function Settlement({ side }: { side: SideSettlement }) {
  const unknown = side.feeAsset === "UNKNOWN" || side.debitMode === "UNKNOWN";
  return (
    <span
      className="sa-settlement"
      title={
        unknown
          ? "دارایی تسویه و نحوهٔ کسر کارمزد برای این طرف تأیید نشده است؛ اجرا مسدود می‌ماند."
          : `${DEBIT_MODE_FA[side.debitMode]} · ${SETTLEMENT_PROVENANCE_FA[side.provenance]}`
      }
    >
      <span className={`sa-chip sa-chip-sm sa-chip-${unknown ? "warn" : "muted"}`}>
        {FEE_ASSET_FA[side.feeAsset] ?? side.feeAsset}
      </span>
      <span className="sa-sub">{DEBIT_MODE_FA[side.debitMode] ?? side.debitMode}</span>
    </span>
  );
}
