"use client";

import { useCallback, useEffect, useState } from "react";
import { formatTehran } from "@/components/format";
import { formatCountFa, toFaDigits } from "@/components/shadowArbitrage/labels";

/** Permanent, never hidden, never conditional. */
export const LIVE_BANNER_EN = "LIVE EXECUTION IS NOT IMPLEMENTED — NO REAL ORDERS";

type Gate = {
  id: string;
  labelFa: string;
  status: "PASSED" | "BLOCKED" | "UNKNOWN";
  evidenceFa: string;
  expiresAt: string | null;
  expired: boolean;
  blockerFa: string | null;
  requiredActionFa: string;
};

type PolicyDefinition = {
  key: string;
  labelFa: string;
  unit: string;
  rationaleFa: string;
  min: number;
  max: number;
};

type PolicyState = {
  definition: PolicyDefinition;
  value: number | null;
  setBy: string | null;
  setAt: string | null;
  configured: boolean;
  blockerFa: string | null;
};

type Report = {
  gateState: string;
  effectiveState: string;
  liveExecutionImplemented: boolean;
  unavailableReasonFa: string;
  gates: Gate[];
  passedCount: number;
  blockedCount: number;
  blockers: Array<{ gate: string; labelFa: string; blockerFa: string }>;
  nextActionsFa: string[];
};

type Review = {
  id: string;
  reviewedBy: string;
  reviewedAt: string;
  gateState: string;
  effectiveState: string;
  passedCount: number;
  blockedCount: number;
  note: string | null;
};

type PolicyHistory = {
  policyKey: string;
  value: number;
  setBy: string;
  setAt: string;
  note: string | null;
};

type Attestation = {
  kind: string;
  confirmedBy: string;
  confirmedAt: string;
  claims: Record<string, boolean | number | string | null>;
  note: string | null;
};

type Payload = {
  liveBanner: string;
  liveExecutionImplemented: boolean;
  canArm: boolean;
  canPlaceRealOrders: boolean;
  unavailableReasonFa: string;
  report: Report;
  policies: PolicyState[];
  attestations: Attestation[];
  policyHistory: PolicyHistory[];
  reviews: Review[];
  message?: string;
};

const STATUS_FA: Record<Gate["status"], string> = {
  PASSED: "برقرار",
  BLOCKED: "مسدود",
  UNKNOWN: "نامشخص"
};

const STATUS_TONE: Record<Gate["status"], string> = {
  PASSED: "good",
  BLOCKED: "danger",
  UNKNOWN: "warn"
};

const GATE_STATE_FA: Record<string, string> = {
  DISARMED: "غیرمسلح",
  READY_FOR_REVIEW: "آمادهٔ بازبینی",
  MANUAL_CANARY_ELIGIBLE: "واجد شرایط آزمایش دستی محدود"
};

const ATTESTATION_FA: Record<string, string> = {
  api_capability: "توان API و حداقل دسترسی",
  key_permissions: "محدودیت کلیدها",
  transfer_costs: "هزینهٔ انتقال و بازتوازن",
  reconciliation_runbook: "رویهٔ تطبیق و حادثه"
};

/**
 * Phase 7A — admin-only live-execution readiness.
 *
 * There is deliberately no control on this page that can arm or execute live
 * trading: live execution is not implemented in this build at all.
 */
export function LiveReadiness() {
  const [data, setData] = useState<Payload | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const res = await fetch("/api/shadow-arbitrage/live-readiness", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!res.ok) return;
    setData((await res.json()) as Payload);
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const post = useCallback(
    async (payload: Record<string, unknown>, okMessage: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/shadow-arbitrage/live-readiness", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload)
        });
        const j = (await res.json().catch(() => null)) as (Payload & { message?: string }) | null;
        if (!res.ok) throw new Error(j?.message ?? "درخواست ناموفق بود");
        if (j) setData(j);
        setNotice(okMessage);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "درخواست ناموفق بود");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const report = data?.report ?? null;

  return (
    <section className="panel sa-panel">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title sa-panel-title">آمادگی اجرای واقعی</h3>
        <div className="sa-panel-note">
          <button type="button" className="sa-linkish" onClick={() => setOpen((v) => !v)}>
            {open ? "بستن" : "باز کردن"}
          </button>
        </div>
      </div>

      {/* Permanent red banner — always rendered, expanded or not. */}
      <div className="sa-live-banner" role="alert">
        <span aria-hidden="true">⛔</span>
        <span>
          {LIVE_BANNER_EN} · اجرای واقعی پیاده‌سازی نشده است — هیچ سفارش واقعی ثبت نمی‌شود
        </span>
      </div>

      {!open ? null : (
        <>
          <div className="panel-body">
            <div className="sa-callout sa-callout-danger">
              {data?.unavailableReasonFa ??
                "اجرای واقعی در این نسخه پیاده‌سازی نشده است؛ هیچ متغیر محیطی یا تنظیمی نمی‌تواند آن را فعال کند."}
            </div>
          </div>

          {notice ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-muted">{notice}</div>
            </div>
          ) : null}

          {report ? (
            <div className="panel-body sa-metric-grid">
              <div className="sa-metric">
                <div className="sa-metric-label">وضعیت مؤثر</div>
                <div className="sa-metric-value">
                  <span className="sa-chip sa-chip-danger">
                    {GATE_STATE_FA[report.effectiveState] ?? report.effectiveState}
                  </span>
                </div>
                <div className="sa-metric-note">همیشه غیرمسلح — اجرای واقعی وجود ندارد</div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">وضعیت دروازه‌ها</div>
                <div className="sa-metric-value">
                  {GATE_STATE_FA[report.gateState] ?? report.gateState}
                </div>
                <div className="sa-metric-note">اگر اجرای واقعی وجود داشت، این وضعیت بود</div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">دروازه‌های برقرار</div>
                <div className="sa-metric-value">
                  {toFaDigits(report.passedCount)} / {toFaDigits(report.gates.length)}
                </div>
                <div className="sa-metric-note">مسدود: {formatCountFa(report.blockedCount)}</div>
              </div>
            </div>
          ) : null}

          {report ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">دروازه‌های آمادگی</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>دروازه</th>
                    <th>وضعیت</th>
                    <th>شواهد</th>
                    <th>انقضا</th>
                    <th>مانع</th>
                    <th>اقدام لازم</th>
                  </tr>
                </thead>
                <tbody>
                  {report.gates.map((g) => (
                    <tr key={g.id}>
                      <td>
                        <strong>{g.labelFa}</strong>
                      </td>
                      <td>
                        <span className={`sa-chip sa-chip-sm sa-chip-${STATUS_TONE[g.status]}`}>
                          {STATUS_FA[g.status]}
                        </span>
                      </td>
                      <td className="sa-wrap-cell text-micro">{g.evidenceFa}</td>
                      <td className="text-micro">
                        {g.expiresAt ? formatTehran(g.expiresAt) : "—"}
                        {g.expired ? <div className="sa-reason">منقضی</div> : null}
                      </td>
                      <td className="sa-wrap-cell">
                        {g.blockerFa ? <span className="sa-reason">{g.blockerFa}</span> : "—"}
                      </td>
                      <td className="sa-wrap-cell text-micro">{g.requiredActionFa}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data?.policies?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">
                حدود ریسک — همه اجباری‌اند و هیچ مقدار پیش‌فرضی فرض نمی‌شود
              </div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>سیاست</th>
                    <th>واحد</th>
                    <th className="num">مقدار</th>
                    <th>وضعیت</th>
                    <th>تعیین‌کننده</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {data.policies.map((p) => (
                    <tr key={p.definition.key}>
                      <td>
                        <strong>{p.definition.labelFa}</strong>
                        {p.blockerFa ? <div className="sa-reason">{p.blockerFa}</div> : null}
                      </td>
                      <td className="text-micro">{p.definition.unit}</td>
                      <td className="num">
                        {p.configured ? toFaDigits(p.value ?? 0) : <span className="sa-reason">تعیین‌نشده</span>}
                      </td>
                      <td>
                        <span
                          className={`sa-chip sa-chip-sm sa-chip-${p.configured ? "good" : "danger"}`}
                        >
                          {p.configured ? "پیکربندی‌شده" : "پیکربندی‌نشده"}
                        </span>
                      </td>
                      <td className="text-micro">
                        {p.setBy ? `${p.setBy} · ${formatTehran(p.setAt)}` : "—"}
                      </td>
                      <td>
                        <input
                          type="number"
                          className="sa-cell-input"
                          placeholder={`${p.definition.min}–${p.definition.max}`}
                          value={draft[p.definition.key] ?? ""}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [p.definition.key]: e.target.value }))
                          }
                        />
                        <button
                          type="button"
                          className="sa-linkish"
                          disabled={busy || !draft[p.definition.key]}
                          onClick={() =>
                            void post(
                              {
                                action: "set_policy",
                                policyKey: p.definition.key,
                                value: Number(draft[p.definition.key])
                              },
                              "سیاست ریسک ثبت شد."
                            )
                          }
                        >
                          ثبت
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data?.attestations?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">تأییدیه‌های ثبت‌شده (بدون هیچ کلید یا رمزی)</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>نوع</th>
                    <th>تأییدکننده</th>
                    <th>زمان</th>
                    <th>موارد تأییدشده</th>
                  </tr>
                </thead>
                <tbody>
                  {data.attestations.slice(0, 20).map((a, i) => (
                    <tr key={`${a.kind}-${i}`}>
                      <td>{ATTESTATION_FA[a.kind] ?? a.kind}</td>
                      <td>{a.confirmedBy}</td>
                      <td className="text-micro">{formatTehran(a.confirmedAt)}</td>
                      <td className="sa-wrap-cell text-micro">
                        {Object.entries(a.claims)
                          .filter(([, v]) => v === true)
                          .map(([k]) => k)
                          .join("، ") || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="panel-body sa-capital-controls">
            <div className="sa-field">
              <span>ثبت بازبینی آمادگی</span>
              <strong className="text-micro">
                بازبینی فقط یک ثبت حسابرسی است و هیچ چیزی را مسلح نمی‌کند.
              </strong>
            </div>
            <div className="sa-capital-actions">
              <button
                type="button"
                className="sa-btn"
                disabled={busy}
                onClick={() => void post({ action: "review" }, "بازبینی ثبت شد.")}
              >
                ثبت بازبینی
              </button>
            </div>
          </div>

          {data?.reviews?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">سابقهٔ بازبینی‌ها</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>بازبین</th>
                    <th>زمان</th>
                    <th>وضعیت دروازه‌ها</th>
                    <th>وضعیت مؤثر</th>
                    <th className="num">برقرار</th>
                    <th className="num">مسدود</th>
                  </tr>
                </thead>
                <tbody>
                  {data.reviews.map((r) => (
                    <tr key={r.id}>
                      <td>{r.reviewedBy}</td>
                      <td className="text-micro">{formatTehran(r.reviewedAt)}</td>
                      <td>{GATE_STATE_FA[r.gateState] ?? r.gateState}</td>
                      <td>{GATE_STATE_FA[r.effectiveState] ?? r.effectiveState}</td>
                      <td className="num">{toFaDigits(r.passedCount)}</td>
                      <td className="num">{toFaDigits(r.blockedCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data?.policyHistory?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">سابقهٔ تغییر سیاست‌های ریسک</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>سیاست</th>
                    <th className="num">مقدار</th>
                    <th>تعیین‌کننده</th>
                    <th>زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {data.policyHistory.slice(0, 30).map((h, i) => (
                    <tr key={`${h.policyKey}-${i}`}>
                      <td className="text-micro">{h.policyKey}</td>
                      <td className="num">{toFaDigits(h.value)}</td>
                      <td>{h.setBy}</td>
                      <td className="text-micro">{formatTehran(h.setAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          <div className="panel-body">
            <div className="sa-footnote">
              هیچ دکمه‌ای در این صفحه توانایی مسلح‌کردن یا اجرای معاملهٔ واقعی ندارد. مدل تهدید،
              دستورالعمل حادثه، سیاهه‌بازبینی دسترسی کلیدها و رویهٔ بازگشت در
              <span className="sa-code"> docs/SHADOW_LIVE_READINESS.md </span> مستند شده‌اند.
            </div>
          </div>
        </>
      )}
    </section>
  );
}
