"use client";

/**
 * Admin control: replace Paper session capital (archive old, open new RUNNING).
 * Passive mount issues no POST — only on explicit preview/apply clicks.
 */
import { useCallback, useEffect, useState } from "react";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { useDeskRole } from "@/hooks/useDeskRole";

type ActiveSession = {
  id: string;
  name: string;
  status: string;
  totalCapitalToman: number;
  valuationPriceToman: number;
};

type Preview = {
  totalCapitalToman: number;
  valuationPriceToman: number;
  allocations: Array<{ sourceId: string; irtToman: number; usdtUnits: number }>;
  allocationSumToman: number;
  residualToman: number;
  perVenue: Array<{
    sourceId: string;
    irtToman: number;
    usdtUnits: number;
    valueToman: number;
    sharePercent: number;
  }>;
  previewToken: string;
};

function fmtToman(n: number): string {
  return toFaDigits(Math.round(n).toLocaleString("en-US"));
}

export function PaperSessionCapitalControl() {
  const role = useDeskRole();
  const [roleReady, setRoleReady] = useState(false);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [limits, setLimits] = useState<{ min: number; max: number } | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    // role starts null then resolves; treat first non-null or settled as ready after tick
    const t = setTimeout(() => setRoleReady(true), 0);
    return () => clearTimeout(t);
  }, [role]);

  const loadStatus = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch("/api/shadow-arbitrage/paper/session-capital", {
        cache: "no-store",
        credentials: "same-origin"
      });
      if (res.status === 401 || res.status === 403) {
        setLoadError(res.status === 401 ? "نیاز به ورود" : "فقط مدیر");
        return;
      }
      if (!res.ok) {
        setLoadError("خواندن وضعیت سرمایه ناموفق بود");
        return;
      }
      const j = (await res.json()) as {
        activeSession: ActiveSession | null;
        limits: { minCapitalToman: number; maxCapitalToman: number };
        valuationPriceToman: number | null;
      };
      setActive(j.activeSession);
      setLimits({ min: j.limits.minCapitalToman, max: j.limits.maxCapitalToman });
      setMark(j.valuationPriceToman);
      if (j.activeSession) {
        setInput((prev) => prev || String(j.activeSession!.totalCapitalToman));
      }
    } catch {
      setLoadError("خطای شبکه");
    }
  }, []);

  useEffect(() => {
    if (role !== "admin") return;
    void loadStatus();
  }, [role, loadStatus]);

  if (!roleReady && role === null) return null;
  if (role !== "admin") return null;

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    setPreview(null);
    setConfirmChecked(false);
    try {
      const body: Record<string, unknown> = {
        action: "preview",
        totalCapitalToman: input.replace(/,/g, "").trim()
      };
      if (mark == null) {
        // Local fallback mark only when market mid unavailable — still whole toman.
        body.valuationPriceToman = 200_000;
      }
      const res = await fetch("/api/shadow-arbitrage/paper/session-capital", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = (await res.json()) as {
        message?: string;
        preview?: Preview;
      };
      if (!res.ok) {
        setError(j.message ?? `خطا ${res.status}`);
        return;
      }
      if (!j.preview || j.preview.residualToman !== 0) {
        setError("پیش‌نمایش باقیماندهٔ غیرصفر برگرداند");
        return;
      }
      setPreview(j.preview);
    } catch {
      setError("پیش‌نمایش ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  const runApply = async () => {
    if (!preview || !confirmChecked) return;
    setBusy(true);
    setError(null);
    setOkMsg(null);
    try {
      const body: Record<string, unknown> = {
        action: "apply",
        totalCapitalToman: preview.totalCapitalToman,
        previewToken: preview.previewToken,
        confirm: true,
        valuationPriceToman: preview.valuationPriceToman
      };
      const res = await fetch("/api/shadow-arbitrage/paper/session-capital", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = (await res.json()) as {
        message?: string;
        session?: ActiveSession;
        reused?: boolean;
        residualToman?: number;
        activeSessionCount?: number;
      };
      if (!res.ok) {
        setError(j.message ?? `خطا ${res.status}`);
        return;
      }
      if (j.residualToman !== 0 || j.activeSessionCount !== 1) {
        setError("اعمال سرمایه: شرط residual=0 یا یک نشست RUNNING برقرار نیست");
        return;
      }
      setOkMsg(
        j.reused
          ? "نشست فعلی با همین سرمایه از قبل فعال بود (بدون تکرار)."
          : `نشست جدید با ${fmtToman(j.session!.totalCapitalToman)} تومان ایجاد شد.`
      );
      setPreview(null);
      setConfirmChecked(false);
      await loadStatus();
    } catch {
      setError("اعمال سرمایه ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel sa-panel" aria-label="سرمایهٔ نشست کاغذی">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title">سرمایهٔ نشست کاغذی</h3>
        <div className="sa-panel-note">فقط تومان صحیح · جایگزینی نشست · بدون سفارش واقعی</div>
      </div>
      <div className="panel-body sa-stack" style={{ gap: 12 }}>
        {loadError ? <p className="sa-sub" style={{ color: "var(--danger, #c44)" }}>{loadError}</p> : null}

        <dl className="sa-inner-metrics" style={{ display: "grid", gap: 6 }}>
          <div>
            <dt className="sa-sub">شناسهٔ نشست فعال</dt>
            <dd>
              {active ? (
                <code dir="ltr">{active.id}</code>
              ) : (
                <span className="sa-sub">نشست فعالی نیست</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="sa-sub">سرمایهٔ فعلی (تومان)</dt>
            <dd>
              {active ? (
                <Bidi>{fmtToman(active.totalCapitalToman)}</Bidi>
              ) : (
                "—"
              )}
            </dd>
          </div>
          <div>
            <dt className="sa-sub">وضعیت</dt>
            <dd>{active?.status ?? "—"}</dd>
          </div>
        </dl>

        <label className="sa-sub" style={{ display: "grid", gap: 4 }}>
          سرمایهٔ جدید (تومان صحیح — مثلاً ۱۰۰٬۰۰۰٬۰۰۰ یا ۱۰٬۰۰۰٬۰۰۰٬۰۰۰)
          <input
            className="sa-control"
            inputMode="numeric"
            dir="ltr"
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setPreview(null);
              setConfirmChecked(false);
              setOkMsg(null);
            }}
            placeholder="100000000"
            disabled={busy}
            style={{ maxWidth: 280 }}
          />
        </label>
        {limits ? (
          <p className="sa-sub">
            محدوده: <Bidi>{fmtToman(limits.min)}</Bidi> …{" "}
            <Bidi>{fmtToman(limits.max)}</Bidi> تومان
          </p>
        ) : null}

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" className="sa-btn sa-btn-ghost" disabled={busy} onClick={() => void runPreview()}>
            پیش‌نمایش تخصیص
          </button>
        </div>

        {preview ? (
          <div
            className="sa-inner-card"
            style={{ border: "1px solid var(--border, #333)", borderRadius: 10, padding: 12 }}
          >
            <h4 className="sa-inner-card-title">پیش‌نمایش (قبل از اعمال)</h4>
            <ul className="sa-sub" style={{ margin: "8px 0", lineHeight: 1.8 }}>
              <li>
                کل سرمایه: <Bidi>{fmtToman(preview.totalCapitalToman)}</Bidi> تومان
              </li>
              <li>
                مجموع تخصیص: <Bidi>{fmtToman(preview.allocationSumToman)}</Bidi> تومان
              </li>
              <li>
                باقیمانده: <Bidi>{fmtToman(preview.residualToman)}</Bidi>{" "}
                {preview.residualToman === 0 ? "✓" : "✗"}
              </li>
              <li>
                قیمت مبنا: <Bidi>{fmtToman(preview.valuationPriceToman)}</Bidi> تومان/تتر
              </li>
            </ul>
            <div style={{ overflowX: "auto" }}>
              <table className="sa-table" style={{ width: "100%", fontSize: 13 }}>
                <thead>
                  <tr>
                    <th>صرافی</th>
                    <th className="num">IRT</th>
                    <th className="num">USDT</th>
                    <th className="num">ارزش</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.perVenue.map((v) => (
                    <tr key={v.sourceId}>
                      <td>{v.sourceId}</td>
                      <td className="num">
                        <Bidi>{fmtToman(v.irtToman)}</Bidi>
                      </td>
                      <td className="num" dir="ltr">
                        {v.usdtUnits.toFixed(6)}
                      </td>
                      <td className="num">
                        <Bidi>{fmtToman(v.valueToman)}</Bidi>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <label
              className="sa-sub"
              style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12 }}
            >
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
                disabled={busy}
              />
              <span>
                تأیید می‌کنم: نشست فعال بایگانی می‌شود (تاریخچه حفظ می‌شود) و دقیقاً یک نشست
                RUNNING جدید با این سرمایه ساخته می‌شود. سرمایهٔ نشست قبلی درجا تغییر نمی‌کند.
              </span>
            </label>
            <button
              type="button"
              className="sa-btn sa-btn-primary"
              style={{ marginTop: 10 }}
              disabled={busy || !confirmChecked || preview.residualToman !== 0}
              onClick={() => void runApply()}
            >
              اعمال سرمایه و جایگزینی نشست
            </button>
          </div>
        ) : null}

        {error ? (
          <p className="sa-sub" style={{ color: "var(--danger, #e07a7a)" }}>
            {error}
          </p>
        ) : null}
        {okMsg ? (
          <p className="sa-sub" style={{ color: "var(--ok, #3dff8a)" }}>
            {okMsg}
          </p>
        ) : null}
      </div>
    </section>
  );
}
