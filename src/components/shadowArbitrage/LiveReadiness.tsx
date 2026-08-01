"use client";

import { useCallback, useEffect, useState } from "react";
import { formatTehran } from "@/components/format";
import { formatCountFa, toFaDigits } from "@/components/shadowArbitrage/labels";

/** Permanent, never hidden, never conditional. */
export const LIVE_BANNER_EN = "LIVE EXECUTION IS NOT IMPLEMENTED — NO REAL ORDERS";

type BlockerKind = "SYSTEM_FAILURE" | "MISSING_POLICY" | "MISSING_EVIDENCE" | "GATE_NOT_MATURE";

type Gate = {
  id: string;
  labelFa: string;
  status: "PASSED" | "BLOCKED" | "UNKNOWN";
  blockerKind: BlockerKind | null;
  evidenceFa: string;
  expiresAt: string | null;
  expired: boolean;
  blockerFa: string | null;
  requiredActionFa: string;
};

type PolicyDefinition = {
  key: string;
  category: "RISK" | "EVIDENCE";
  labelFa: string;
  unit: string;
  rationaleFa: string;
  min: number;
  max: number;
};

type PolicyState = {
  definition: PolicyDefinition;
  value: number | null;
  provenance: string;
  setBy: string | null;
  setAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  configured: boolean;
  blockerFa: string | null;
  requiredActionFa: string;
};

type OperationalHealth = {
  healthy: boolean;
  running: boolean;
  heartbeatStale: boolean;
  duplicateIdempotencyKeys: number;
  successfulCycles: number;
  summaryFa: string;
};

type Report = {
  gateState: string;
  operationalHealth?: OperationalHealth;
  blockerCounts?: Record<BlockerKind, number>;
  effectiveState: string;
  liveExecutionImplemented: boolean;
  unavailableReasonFa: string;
  gates: Gate[];
  passedCount: number;
  blockedCount: number;
  blockers: Array<{ gate: string; labelFa: string; blockerFa: string }>;
  nextActionsFa: string[];
};

/**
 * A blocked gate is not automatically an error. Naming the cause lets a reader
 * tell a real fault from a decision nobody has made yet.
 */
const BLOCKER_KIND_FA: Record<BlockerKind, string> = {
  SYSTEM_FAILURE: "خرابی سامانه",
  MISSING_POLICY: "سیاست تعیین‌نشده",
  MISSING_EVIDENCE: "شواهد ثبت‌نشده",
  GATE_NOT_MATURE: "در حال تکمیل"
};

const BLOCKER_KIND_TONE: Record<BlockerKind, string> = {
  SYSTEM_FAILURE: "danger",
  MISSING_POLICY: "warn",
  MISSING_EVIDENCE: "warn",
  GATE_NOT_MATURE: "muted"
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
  provenance: string;
  validForDays: number | null;
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

type EvidenceEnvironment = {
  kind: "TEMPORARY_LOCAL" | "LOCAL" | "SHARED";
  noteFa: string;
};

type Payload = {
  liveBanner: string;
  /** Whether this picture came from a throwaway local database. */
  evidenceEnvironment?: EvidenceEnvironment;
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

const PROVENANCE_FA: Record<string, string> = {
  ADMIN_APPROVED: "تأیید مدیر",
  UNSET: "تعیین‌نشده"
};

const CATEGORY_FA: Record<string, string> = {
  RISK: "حدود ریسک",
  EVIDENCE: "آستانه‌های شواهد"
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
  const [validity, setValidity] = useState<Record<string, string>>({});

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

      {/*
        A throwaway local database has its own observation window starting at
        zero. Saying so stops a reviewer reading a local 0-day window as a
        production regression.
      */}
      {data?.evidenceEnvironment?.kind === "TEMPORARY_LOCAL" ? (
        <div className="sa-callout sa-callout-warn" role="status">
          شواهد موقت محلی — {data.evidenceEnvironment.noteFa}
        </div>
      ) : null}

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
              {report.operationalHealth ? (
                <div className="sa-metric">
                  <div className="sa-metric-label">سلامت عملیاتی</div>
                  <div className="sa-metric-value">
                    <span
                      className={`sa-chip sa-chip-sm sa-chip-${report.operationalHealth.healthy ? "good" : "danger"}`}
                    >
                      {report.operationalHealth.healthy ? "سالم" : "دارای اشکال"}
                    </span>
                  </div>
                  <div className="sa-metric-note">{report.operationalHealth.summaryFa}</div>
                </div>
              ) : null}
            </div>
          ) : null}

          {report?.blockerCounts ? (
            <div className="panel-body">
              <div className="sa-subpanel-title">تفکیک موانع</div>
              <div className="sa-blocker-kinds">
                {(
                  ["SYSTEM_FAILURE", "MISSING_POLICY", "MISSING_EVIDENCE", "GATE_NOT_MATURE"] as const
                ).map((kind) => (
                  <span
                    key={kind}
                    className={`sa-chip sa-chip-sm sa-chip-${
                      report.blockerCounts![kind] ? BLOCKER_KIND_TONE[kind] : "muted"
                    }`}
                  >
                    {BLOCKER_KIND_FA[kind]}: {toFaDigits(report.blockerCounts![kind])}
                  </span>
                ))}
              </div>
              <div className="sa-footnote">
                فقط «خرابی سامانه» به‌معنای اشکال فعلی است. «سیاست تعیین‌نشده» یعنی عددی هنوز انتخاب
                نشده، «شواهد ثبت‌نشده» یعنی مدرکی ثبت نشده و «در حال تکمیل» یعنی شواهد در حال جمع‌شدن است.
              </div>
            </div>
          ) : null}

          {report ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">دروازه‌های آمادگی</div>
              <table className="sa-table sa-readiness-table">
                <colgroup>
                  <col className="sa-col-gate" />
                  <col className="sa-col-status" />
                  <col className="sa-col-status" />
                  <col className="sa-col-evidence" />
                  <col className="sa-col-expiry" />
                  <col className="sa-col-blocker" />
                  <col className="sa-col-action" />
                </colgroup>
                <thead>
                  <tr>
                    <th>دروازه</th>
                    <th>وضعیت</th>
                    <th>نوع مانع</th>
                    <th className="sa-col-optional">شواهد</th>
                    <th className="sa-col-optional">انقضا</th>
                    <th>مانع</th>
                    <th>اقدام لازم</th>
                  </tr>
                </thead>
                <tbody>
                  {report.gates.map((g) => (
                    <tr key={g.id}>
                      <td data-label="دروازه">
                        <strong>{g.labelFa}</strong>
                      </td>
                      <td data-label="وضعیت">
                        <span className={`sa-chip sa-chip-sm sa-chip-${STATUS_TONE[g.status]}`}>
                          {STATUS_FA[g.status]}
                        </span>
                      </td>
                      <td data-label="نوع مانع">
                        {g.blockerKind ? (
                          <span
                            className={`sa-chip sa-chip-sm sa-chip-${BLOCKER_KIND_TONE[g.blockerKind]}`}
                          >
                            {BLOCKER_KIND_FA[g.blockerKind]}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td data-label="شواهد" className="sa-col-optional text-micro">
                        {g.evidenceFa}
                      </td>
                      <td data-label="انقضا" className="sa-col-optional text-micro">
                        {g.expiresAt ? formatTehran(g.expiresAt) : "—"}
                        {g.expired ? <span className="sa-reason">منقضی</span> : null}
                      </td>
                      <td data-label="مانع">
                        {g.blockerFa ? <span className="sa-reason">{g.blockerFa}</span> : "—"}
                      </td>
                      <td data-label="اقدام لازم" className="text-micro">
                        {g.requiredActionFa}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data?.policies?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">
                سیاست‌های اجباری — هیچ مقدار پیش‌فرضی در کد وجود ندارد
              </div>
              <table className="sa-table sa-readiness-table">
                <colgroup>
                  <col className="sa-col-gate" />
                  <col className="sa-col-status" />
                  <col className="sa-col-value" />
                  <col className="sa-col-who" />
                  <col className="sa-col-expiry" />
                  <col className="sa-col-action" />
                  <col className="sa-col-edit" />
                </colgroup>
                <thead>
                  <tr>
                    <th>سیاست</th>
                    <th>دسته</th>
                    <th>مقدار</th>
                    <th className="sa-col-optional">تأییدکننده و تاریخ</th>
                    <th className="sa-col-optional">انقضا</th>
                    <th>اقدام لازم</th>
                    <th>ثبت مقدار</th>
                  </tr>
                </thead>
                <tbody>
                  {data.policies.map((p) => (
                    <tr key={p.definition.key}>
                      <td data-label="سیاست">
                        <strong>{p.definition.labelFa}</strong>
                        <span className="sa-reason">{p.definition.rationaleFa}</span>
                      </td>
                      <td data-label="دسته" className="text-micro">
                        {CATEGORY_FA[p.definition.category] ?? p.definition.category}
                      </td>
                      <td data-label="مقدار">
                        {p.configured ? (
                          <>
                            <strong>{toFaDigits(p.value ?? 0)}</strong>{" "}
                            <span className="text-micro">{p.definition.unit}</span>
                            <span className="sa-reason">
                              {PROVENANCE_FA[p.provenance] ?? p.provenance}
                            </span>
                          </>
                        ) : (
                          <span className="sa-reason">
                            تعیین‌نشده — {PROVENANCE_FA[p.provenance] ?? p.provenance}
                          </span>
                        )}
                      </td>
                      <td data-label="تأییدکننده و تاریخ" className="sa-col-optional text-micro">
                        {p.setBy ? `${p.setBy} · ${formatTehran(p.setAt)}` : "—"}
                      </td>
                      <td data-label="انقضا" className="sa-col-optional text-micro">
                        {p.expiresAt ? formatTehran(p.expiresAt) : "بدون انقضا"}
                        {p.expired ? <span className="sa-reason">منقضی</span> : null}
                      </td>
                      <td data-label="اقدام لازم" className="text-micro">
                        {p.blockerFa ? (
                          <span className="sa-reason">{p.blockerFa}</span>
                        ) : null}
                        {p.requiredActionFa}
                      </td>
                      <td data-label="ثبت مقدار">
                        <input
                          type="number"
                          className="sa-cell-input"
                          placeholder={`${p.definition.min}–${p.definition.max}`}
                          value={draft[p.definition.key] ?? ""}
                          onChange={(e) =>
                            setDraft((d) => ({ ...d, [p.definition.key]: e.target.value }))
                          }
                        />
                        <input
                          type="number"
                          className="sa-cell-input"
                          placeholder="اعتبار (روز، اختیاری)"
                          value={validity[p.definition.key] ?? ""}
                          onChange={(e) =>
                            setValidity((d) => ({ ...d, [p.definition.key]: e.target.value }))
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
                                value: Number(draft[p.definition.key]),
                                validForDays: validity[p.definition.key]
                                  ? Number(validity[p.definition.key])
                                  : null
                              },
                              "مقدار سیاست ثبت شد."
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
              <table className="sa-table sa-readiness-table">
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
                      <td data-label="نوع">{ATTESTATION_FA[a.kind] ?? a.kind}</td>
                      <td data-label="تأییدکننده">{a.confirmedBy}</td>
                      <td data-label="زمان" className="text-micro">
                        {formatTehran(a.confirmedAt)}
                      </td>
                      <td data-label="موارد تأییدشده" className="text-micro">
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
              <table className="sa-table sa-readiness-table">
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
                      <td data-label="بازبین">{r.reviewedBy}</td>
                      <td data-label="زمان" className="text-micro">
                        {formatTehran(r.reviewedAt)}
                      </td>
                      <td data-label="وضعیت دروازه‌ها">
                        {GATE_STATE_FA[r.gateState] ?? r.gateState}
                      </td>
                      <td data-label="وضعیت مؤثر">
                        {GATE_STATE_FA[r.effectiveState] ?? r.effectiveState}
                      </td>
                      <td data-label="برقرار">{toFaDigits(r.passedCount)}</td>
                      <td data-label="مسدود">{toFaDigits(r.blockedCount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}

          {data?.policyHistory?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">سابقهٔ تغییر سیاست‌های ریسک</div>
              <table className="sa-table sa-readiness-table">
                <thead>
                  <tr>
                    <th>سیاست</th>
                    <th>مقدار</th>
                    <th className="sa-col-optional">منشأ</th>
                    <th className="sa-col-optional">اعتبار</th>
                    <th>تعیین‌کننده</th>
                    <th>زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {data.policyHistory.slice(0, 30).map((h, i) => (
                    <tr key={`${h.policyKey}-${i}`}>
                      <td data-label="سیاست" className="text-micro">
                        {h.policyKey}
                      </td>
                      <td data-label="مقدار">{toFaDigits(h.value)}</td>
                      <td data-label="منشأ" className="sa-col-optional text-micro">
                        {PROVENANCE_FA[h.provenance] ?? h.provenance}
                      </td>
                      <td data-label="اعتبار" className="sa-col-optional text-micro">
                        {h.validForDays === null ? "بدون انقضا" : `${toFaDigits(h.validForDays)} روز`}
                      </td>
                      <td data-label="تعیین‌کننده">{h.setBy}</td>
                      <td data-label="زمان" className="text-micro">
                        {formatTehran(h.setAt)}
                      </td>
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
