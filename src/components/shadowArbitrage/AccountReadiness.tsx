"use client";

import { useCallback, useEffect, useState } from "react";
import { formatTehran } from "@/components/format";
import { formatPercentFa, toFaDigits } from "@/components/shadowArbitrage/labels";

type Venue = {
  sourceId: string;
  nameFa: string;
  accountState: "VERIFIED" | "NEEDS_ACCOUNT" | "REFERENCE_ONLY";
  takerFeeBps: number | null;
  feeProvenance: "OFFICIAL_PUBLISHED" | "ADMIN_CONFIRMED" | "PROVISIONAL" | "UNKNOWN";
  feeTier: string | null;
  officialSourceUrl: string | null;
  feeVerifiedAt: string | null;
  feeStale: boolean;
  apiCapabilities: string[];
  requiredAction: string;
  blockingReason: string | null;
  notes: string;
};

type Audit = {
  id: string;
  sourceId: string;
  takerFeeBps: number;
  feeTier: string | null;
  confirmedBy: string;
  confirmedAt: string;
  note: string | null;
};

const ACCOUNT_FA: Record<Venue["accountState"], string> = {
  VERIFIED: "حساب موجود",
  NEEDS_ACCOUNT: "نیازمند افتتاح حساب",
  REFERENCE_ONLY: "فقط مرجع"
};

const PROVENANCE_FA: Record<Venue["feeProvenance"], string> = {
  OFFICIAL_PUBLISHED: "سند رسمی",
  ADMIN_CONFIRMED: "تأیید مدیر",
  PROVISIONAL: "موقت",
  UNKNOWN: "نامشخص"
};

const CAPABILITY_FA: Record<string, string> = {
  PUBLIC_MARKET_DATA: "دادهٔ عمومی بازار",
  ACCOUNT_FEE_TIER: "پلهٔ کارمزد حساب",
  NONE_VERIFIED: "تأییدنشده"
};

/** Phase 4 — admin-only account and fee readiness. No credentials, ever. */
export function AccountReadiness() {
  const [venues, setVenues] = useState<Venue[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [reverifyDays, setReverifyDays] = useState(90);
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState({ takerFeeBps: "", feeTier: "", sourceUrl: "", note: "" });
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/shadow-arbitrage/accounts", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!res.ok) return;
    const j = (await res.json()) as { venues: Venue[]; auditHistory: Audit[]; feeReverifyDays: number };
    setVenues(j.venues ?? []);
    setAudit(j.auditHistory ?? []);
    setReverifyDays(j.feeReverifyDays ?? 90);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "ثبت ناموفق بود");
    }
  };

  return (
    <section className="panel sa-panel">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title sa-panel-title">آمادگی حساب و کارمزد صرافی‌ها</h3>
        <div className="sa-panel-note">
          بازبینی کارمزد هر {toFaDigits(reverifyDays)} روز · بدون کلید API
        </div>
      </div>

      {notice ? (
        <div className="panel-body">
          <div className="sa-callout sa-callout-muted">{notice}</div>
        </div>
      ) : null}

      <div className="panel-body sa-table-wrap">
        <table className="sa-table">
          <thead>
            <tr>
              <th>صرافی</th>
              <th>وضعیت حساب</th>
              <th>وضعیت کارمزد</th>
              <th className="num">کارمزد taker</th>
              <th>پلهٔ کارمزد</th>
              <th>سند رسمی</th>
              <th>تاریخ تأیید</th>
              <th>توان API</th>
              <th>اقدام لازم</th>
              <th>دلیل مسدودی</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {venues.map((v) => (
              <tr key={v.sourceId}>
                <td>
                  <strong>{v.nameFa}</strong>
                </td>
                <td>
                  <span
                    className={`sa-chip sa-chip-sm sa-chip-${
                      v.accountState === "VERIFIED" ? "good" : v.accountState === "NEEDS_ACCOUNT" ? "warn" : "muted"
                    }`}
                  >
                    {ACCOUNT_FA[v.accountState]}
                  </span>
                </td>
                <td>
                  <span
                    className={`sa-chip sa-chip-sm sa-chip-${
                      v.feeProvenance === "OFFICIAL_PUBLISHED" || v.feeProvenance === "ADMIN_CONFIRMED"
                        ? "good"
                        : v.feeProvenance === "PROVISIONAL"
                          ? "warn"
                          : "danger"
                    }`}
                  >
                    {PROVENANCE_FA[v.feeProvenance]}
                  </span>
                  {v.feeStale ? (
                    <div className="sa-reason" title="اعتبار کارمزد منقضی شده است">
                      نیازمند بازبینی
                    </div>
                  ) : null}
                </td>
                <td className="num">
                  {v.takerFeeBps !== null ? formatPercentFa(v.takerFeeBps / 100, 3) : "نامشخص"}
                </td>
                <td>{v.feeTier ?? "—"}</td>
                <td className="sa-wrap-cell">
                  {v.officialSourceUrl ? (
                    <span className="sa-endpoint">{v.officialSourceUrl}</span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="text-micro">
                  {v.feeVerifiedAt ? formatTehran(v.feeVerifiedAt) : "—"}
                </td>
                <td className="text-micro">
                  {v.apiCapabilities.map((c) => CAPABILITY_FA[c] ?? c).join("، ")}
                </td>
                <td className="sa-wrap-cell">{v.requiredAction}</td>
                <td className="sa-wrap-cell">{v.blockingReason ?? "—"}</td>
                <td>
                  {v.accountState === "REFERENCE_ONLY" ? null : (
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost"
                      onClick={() => setEditing(editing === v.sourceId ? null : v.sourceId)}
                    >
                      ثبت کارمزد
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {!venues.length ? (
              <tr>
                <td colSpan={11}>
                  <div className="sa-empty">
                    <strong>در حال بارگذاری…</strong>
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {editing ? (
        <div className="panel-body sa-filters">
          <label className="sa-filter-group">
            <span className="sa-filter-label">کارمزد taker (در ده‌هزار)</span>
            <input
              className="sa-input"
              inputMode="numeric"
              value={form.takerFeeBps}
              onChange={(e) => setForm((f) => ({ ...f, takerFeeBps: e.target.value }))}
              placeholder="مثلاً ۲۵ برای ۰٫۲۵٪"
            />
          </label>
          <label className="sa-filter-group">
            <span className="sa-filter-label">نام پله</span>
            <input
              className="sa-input"
              value={form.feeTier}
              onChange={(e) => setForm((f) => ({ ...f, feeTier: e.target.value }))}
            />
          </label>
          <label className="sa-filter-group">
            <span className="sa-filter-label">نشانی سند رسمی</span>
            <input
              className="sa-input"
              value={form.sourceUrl}
              onChange={(e) => setForm((f) => ({ ...f, sourceUrl: e.target.value }))}
            />
          </label>
          <label className="sa-filter-group">
            <span className="sa-filter-label">توضیح</span>
            <input
              className="sa-input"
              value={form.note}
              onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))}
            />
          </label>
          <button type="button" className="sa-btn sa-btn-primary" onClick={() => void submit(editing)}>
            ثبت برای {venues.find((v) => v.sourceId === editing)?.nameFa}
          </button>
          <div className="sa-footnote">
            فقط شواهد کارمزد ثبت می‌شود. هیچ کلید API، رمز یا دسترسی حسابی در این مرحله دریافت یا
            ذخیره نمی‌شود.
          </div>
        </div>
      ) : null}

      {audit.length ? (
        <div className="panel-body">
          <details className="sa-details">
            <summary>سابقهٔ تأیید کارمزد ({toFaDigits(audit.length)} رکورد)</summary>
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>صرافی</th>
                    <th className="num">کارمزد</th>
                    <th>پله</th>
                    <th>ثبت‌کننده</th>
                    <th>زمان</th>
                    <th>توضیح</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.map((a) => (
                    <tr key={a.id}>
                      <td>{venues.find((v) => v.sourceId === a.sourceId)?.nameFa ?? a.sourceId}</td>
                      <td className="num">{formatPercentFa(a.takerFeeBps / 100, 3)}</td>
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
  );
}
