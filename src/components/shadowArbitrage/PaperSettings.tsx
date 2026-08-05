"use client";

/**
 * Paper settings — one reviewed set, one decision.
 *
 * The six numbers the Paper Broker needs used to be six rows with six «ثبت»
 * buttons in a table that also held live-execution policies and evidence
 * thresholds. That shape taught the wrong thing: it made configuring the desk
 * look like six small unrelated chores, and it let an operator leave four set
 * and two missing without the screen ever saying the desk was still blocked.
 *
 * Here the set is the unit. It is shown whole — current against proposed, with
 * what each value controls — reviewed in one step, confirmed in a second, and
 * applied in a single transaction. Individual editing still exists, because an
 * approved set is not the only legitimate decision, but it lives behind a fold
 * and is labelled as the advanced path it is.
 */
import { useCallback, useEffect, useState } from "react";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";

type PolicyRowView = {
  key: string;
  labelFa: string;
  unitFa: string;
  controlsFa: string;
  proposedValue: number;
  proposedDisplayFa: string;
  currentValue: number | null;
  currentDisplayFa: string | null;
  setBy: string | null;
  setAt: string | null;
  expiresAt: string | null;
  expired: boolean;
  configured: boolean;
  status: "MATCHES" | "DIFFERS" | "EXPIRED" | "MISSING";
  statusFa: string;
  blockerFa: string | null;
};

export type PaperPolicySetPayload = {
  setKey: string;
  validForDays: number;
  canonical: string;
  fingerprint: string;
  status: "EFFECTIVE" | "PARTIALLY_APPLIED" | "DRIFTED" | "EXPIRED" | "NOT_APPLIED";
  statusFa: string;
  effective: boolean;
  missingKeys: string[];
  differingKeys: string[];
  expiredKeys: string[];
  expiresAt: string | null;
  rows: PolicyRowView[];
};

type PolicyHistoryRow = {
  policyKey: string;
  value: number;
  provenance: string;
  validForDays: number | null;
  setBy: string;
  setAt: string;
  note: string | null;
};

type Payload = {
  paperPolicySet?: PaperPolicySetPayload;
  policyHistory?: PolicyHistoryRow[];
  policies?: Array<{
    definition: { key: string; labelFa: string; unit: string; min: number; max: number };
    value: number | null;
    configured: boolean;
    expired: boolean;
    setBy: string | null;
    setAt: string | null;
    expiresAt: string | null;
    blockerFa: string | null;
    requiredActionFa: string;
  }>;
  message?: string;
};

const STATUS_TONE: Record<PaperPolicySetPayload["status"], string> = {
  EFFECTIVE: "good",
  PARTIALLY_APPLIED: "warn",
  DRIFTED: "warn",
  EXPIRED: "danger",
  NOT_APPLIED: "danger"
};

const ROW_TONE: Record<PolicyRowView["status"], string> = {
  MATCHES: "good",
  DIFFERS: "warn",
  EXPIRED: "danger",
  MISSING: "danger"
};

const DASH = <span className="sa-unknown">—</span>;

export function PaperSettings() {
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Two-step apply: review first, then an explicit confirmation. */
  const [armed, setArmed] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [validity, setValidity] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/shadow-arbitrage/live-readiness", {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (!res.ok) throw new Error("خواندن تنظیمات ناموفق بود");
      setData((await res.json()) as Payload);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "خواندن تنظیمات ناموفق بود");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const post = useCallback(
    async (payload: Record<string, unknown>, okMessage: string) => {
      setBusy(true);
      setNotice(null);
      setError(null);
      try {
        const res = await fetch("/api/shadow-arbitrage/live-readiness", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(payload)
        });
        const j = (await res.json().catch(() => null)) as Payload | null;
        if (!res.ok) throw new Error(j?.message ?? "درخواست ناموفق بود");
        if (j) setData(j);
        setNotice(okMessage);
        setArmed(false);
      } catch (e) {
        setError(e instanceof Error ? e.message : "درخواست ناموفق بود");
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const set = data?.paperPolicySet ?? null;
  const paperKeys = new Set(set?.rows.map((r) => r.key) ?? []);
  const paperHistory = (data?.policyHistory ?? []).filter((h) => paperKeys.has(h.policyKey));

  return (
    <div className="sa-stack">
      <section className="panel sa-panel" aria-label="مجموعهٔ تنظیمات Paper">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">تنظیمات Paper</h3>
          <div className="sa-panel-note">
            شش سیاستی که حجم‌دهی هوشمند بدون آن‌ها هیچ حجمی انتخاب نمی‌کند
          </div>
        </div>

        {error ? (
          <div className="panel-body">
            <div className="sa-callout sa-callout-danger" role="alert">
              {error}
            </div>
          </div>
        ) : null}
        {notice ? (
          <div className="panel-body">
            <div className="sa-callout sa-callout-muted" role="status">
              {notice}
            </div>
          </div>
        ) : null}

        {loading && !set ? (
          <div className="panel-body">
            <p className="sa-sub">در حال خواندن…</p>
          </div>
        ) : null}

        {set ? (
          <div className="panel-body sa-ps-body">
            {/* ── the set's identity and standing ─────────────────────── */}
            <div className="sa-ps-head">
              <div className="sa-ps-identity">
                <span className="sa-chip sa-chip-sm sa-chip-muted sa-ps-setkey">{set.setKey}</span>
                <span className={`sa-chip sa-chip-sm sa-chip-${STATUS_TONE[set.status]}`}>
                  {set.statusFa}
                </span>
              </div>
              <dl className="sa-ps-meta">
                <div>
                  <dt>اعتبار</dt>
                  <dd>
                    <Bidi>{toFaDigits(set.validForDays)}</Bidi> روز
                  </dd>
                </div>
                <div>
                  <dt>انقضای فعلی</dt>
                  <dd>{set.expiresAt ? formatTehran(set.expiresAt) : DASH}</dd>
                </div>
                <div>
                  <dt>اثر انگشت مجموعه</dt>
                  <dd className="sa-ps-fingerprint">
                    <Bidi>{set.fingerprint}</Bidi>
                  </dd>
                </div>
              </dl>
            </div>

            {!set.effective ? (
              <div className="sa-callout sa-callout-warn" role="status">
                تا وقتی این مجموعه به‌طور کامل و معتبر اعمال نشده باشد، حجم‌دهی هوشمند هیچ حجمی
                انتخاب نمی‌کند و هیچ معاملهٔ کاغذی تازه‌ای ثبت نمی‌شود.
                {set.missingKeys.length ? (
                  <>
                    {" "}
                    تعیین‌نشده: <span className="sa-strong">{set.missingKeys.join("، ")}</span>.
                  </>
                ) : null}
                {set.expiredKeys.length ? (
                  <>
                    {" "}
                    منقضی: <span className="sa-strong">{set.expiredKeys.join("، ")}</span>.
                  </>
                ) : null}
                {set.differingKeys.length ? (
                  <>
                    {" "}
                    متفاوت با مجموعه:{" "}
                    <span className="sa-strong">{set.differingKeys.join("، ")}</span>.
                  </>
                ) : null}
              </div>
            ) : (
              <div className="sa-callout sa-callout-muted" role="status">
                هر شش سیاست مطابق مجموعهٔ تأییدشده و معتبرند؛ حجم‌دهی هوشمند فعال است.
              </div>
            )}

            {/* ── desktop: current versus proposed, row by row ──────────── */}
            <div className="sa-table-wrap sa-ps-desktop">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th scope="col">سیاست</th>
                    <th scope="col">مقدار فعلی</th>
                    <th scope="col">مقدار مجموعه</th>
                    <th scope="col">وضعیت</th>
                    <th scope="col">تأییدکننده و تاریخ</th>
                  </tr>
                </thead>
                <tbody>
                  {set.rows.map((r) => (
                    <tr key={r.key}>
                      <td data-label="سیاست">
                        <strong>{r.labelFa}</strong>
                        <span className="sa-reason">{r.controlsFa}</span>
                        <span className="sa-ps-key">{r.key}</span>
                      </td>
                      <td data-label="مقدار فعلی">
                        {r.currentDisplayFa ? <Bidi>{r.currentDisplayFa}</Bidi> : DASH}
                      </td>
                      <td data-label="مقدار مجموعه">
                        <Bidi>{r.proposedDisplayFa}</Bidi>
                      </td>
                      <td data-label="وضعیت">
                        <span className={`sa-chip sa-chip-sm sa-chip-${ROW_TONE[r.status]}`}>
                          {r.statusFa}
                        </span>
                        {r.blockerFa ? <span className="sa-reason">{r.blockerFa}</span> : null}
                      </td>
                      <td data-label="تأییدکننده و تاریخ" className="sa-sub">
                        {r.setAt ? (
                          <>
                            {r.setBy ?? "—"}
                            <br />
                            {formatTehran(r.setAt)}
                          </>
                        ) : (
                          DASH
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ── mobile: one card per policy, no sideways scrolling ────── */}
            <ul className="sa-ps-cards">
              {set.rows.map((r) => (
                <li key={r.key} className="sa-ps-card">
                  <div className="sa-ps-card-head">
                    <span className="sa-ps-card-title">{r.labelFa}</span>
                    <span className={`sa-chip sa-chip-sm sa-chip-${ROW_TONE[r.status]}`}>
                      {r.statusFa}
                    </span>
                  </div>
                  <p className="sa-sub sa-ps-card-note">{r.controlsFa}</p>
                  <dl className="sa-ps-card-grid">
                    <div>
                      <dt>فعلی</dt>
                      <dd>{r.currentDisplayFa ? <Bidi>{r.currentDisplayFa}</Bidi> : DASH}</dd>
                    </div>
                    <div>
                      <dt>مجموعه</dt>
                      <dd>
                        <Bidi>{r.proposedDisplayFa}</Bidi>
                      </dd>
                    </div>
                    <div>
                      <dt>تأییدکننده</dt>
                      <dd>{r.setBy ?? DASH}</dd>
                    </div>
                    <div>
                      <dt>تاریخ</dt>
                      <dd>{r.setAt ? formatTehran(r.setAt) : DASH}</dd>
                    </div>
                  </dl>
                </li>
              ))}
            </ul>

            {/* ── the single atomic action, behind an explicit confirmation ── */}
            <div className="sa-ps-apply">
              {!armed ? (
                <>
                  <p className="sa-sub">
                    اعمال، هر شش مقدار را با هم و در یک تراکنش ثبت می‌کند: یا همه ثبت می‌شوند یا
                    هیچ‌کدام. مقادیر قبلی حذف نمی‌شوند و در تاریخچه باقی می‌مانند.
                  </p>
                  <button
                    type="button"
                    className="sa-btn sa-btn-primary sa-ps-action"
                    disabled={busy}
                    onClick={() => setArmed(true)}
                  >
                    اعمال مجموعه تنظیمات Paper
                  </button>
                </>
              ) : (
                <div className="sa-callout sa-callout-warn sa-ps-confirm" role="status">
                  <p className="sa-ps-confirm-line">
                    <span className="sa-strong">بازبینی: </span>
                    هر شش سیاست با مقادیر مجموعهٔ{" "}
                    <span className="sa-strong">{set.setKey}</span> و اعتبار{" "}
                    <Bidi>{toFaDigits(set.validForDays)}</Bidi> روز ثبت می‌شوند.
                  </p>
                  <ul className="sa-ps-confirm-list">
                    {set.rows.map((r) => (
                      <li key={r.key}>
                        {r.labelFa}: <Bidi>{r.proposedDisplayFa}</Bidi>
                      </li>
                    ))}
                  </ul>
                  <p className="sa-sub">
                    اثر انگشت: <Bidi>{set.fingerprint}</Bidi>
                  </p>
                  <div className="sa-ps-confirm-actions">
                    <button
                      type="button"
                      className="sa-btn sa-btn-primary sa-ps-action"
                      disabled={busy}
                      onClick={() =>
                        void post(
                          {
                            action: "apply_paper_policy_set",
                            fingerprint: set.fingerprint,
                            confirm: true
                          },
                          "مجموعهٔ تنظیمات Paper اعمال شد."
                        )
                      }
                    >
                      بله، انجام بده
                    </button>
                    <button
                      type="button"
                      className="sa-btn sa-btn-ghost sa-ps-action"
                      disabled={busy}
                      onClick={() => setArmed(false)}
                    >
                      انصراف
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </section>

      {/* ── append-only audit history for these six keys ─────────────────── */}
      <section className="panel sa-panel" aria-label="تاریخچهٔ تنظیمات Paper">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title sa-panel-title">تاریخچهٔ تنظیمات Paper</h3>
          <div className="sa-panel-note">فقط افزودنی — هیچ مقداری بازنویسی یا حذف نمی‌شود</div>
        </div>
        <div className="panel-body">
          {paperHistory.length ? (
            <div className="sa-table-wrap">
              <table className="sa-table">
                <thead>
                  <tr>
                    <th scope="col">سیاست</th>
                    <th scope="col" className="num">مقدار</th>
                    <th scope="col">تأییدکننده</th>
                    <th scope="col">تاریخ</th>
                    <th scope="col">یادداشت</th>
                  </tr>
                </thead>
                <tbody>
                  {paperHistory.slice(0, 60).map((h, i) => (
                    <tr key={`${h.policyKey}-${h.setAt}-${i}`}>
                      <td data-label="سیاست">{h.policyKey}</td>
                      <td data-label="مقدار" className="num">
                        <Bidi>{toFaDigits(h.value)}</Bidi>
                      </td>
                      <td data-label="تأییدکننده">{h.setBy}</td>
                      <td data-label="تاریخ">{formatTehran(h.setAt)}</td>
                      <td data-label="یادداشت" className="sa-sub">
                        {h.note ?? DASH}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="sa-sub">هنوز هیچ مقداری برای این شش سیاست ثبت نشده است.</p>
          )}
        </div>
      </section>

      {/* ── advanced: one value at a time, folded away on purpose ────────── */}
      <details className="panel sa-panel sa-advanced-details">
        <summary className="panel-header sa-panel-header">
          <span className="panel-title">ویرایش تکی پیشرفته</span>
          <span className="sa-panel-note">
            تغییر یک سیاست به‌تنهایی — خارج از مجموعهٔ تأییدشده
          </span>
        </summary>
        <div className="panel-body">
          <div className="sa-callout sa-callout-warn" role="status">
            تغییر تکی، مجموعه را از حالت «مطابق» خارج می‌کند و در صفحه به‌صورت «مقدار فعلی متفاوت
            است» نشان داده می‌شود. مسیر عادی، اعمال کل مجموعه است.
          </div>
          <div className="sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th scope="col">سیاست</th>
                  <th scope="col">مقدار فعلی</th>
                  <th scope="col">ثبت مقدار</th>
                </tr>
              </thead>
              <tbody>
                {(data?.policies ?? [])
                  .filter((p) => paperKeys.has(p.definition.key))
                  .map((p) => (
                    <tr key={p.definition.key}>
                      <td data-label="سیاست">
                        <strong>{p.definition.labelFa}</strong>
                        <span className="sa-ps-key">{p.definition.key}</span>
                      </td>
                      <td data-label="مقدار فعلی">
                        {p.configured && p.value !== null ? (
                          <Bidi>{`${toFaDigits(p.value)} ${p.definition.unit}`}</Bidi>
                        ) : (
                          <span className="sa-reason">{p.blockerFa ?? "پیکربندی نشده"}</span>
                        )}
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
        </div>
      </details>
    </div>
  );
}
