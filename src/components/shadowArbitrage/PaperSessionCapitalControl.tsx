"use client";

/**
 * Admin Paper session setup (Step 6).
 * Capital (whole toman), duration (days), order-cap AUTO/MANUAL.
 * Passive mount issues no POST — only on explicit preview/apply.
 */
import { useCallback, useEffect, useState } from "react";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { toFaDigits } from "@/components/shadowArbitrage/labels";
import { useDeskRole } from "@/hooks/useDeskRole";

type OrderCapChoice = "AUTO_CAPITAL_DERIVED" | "MANUAL";

type ActiveSession = {
  id: string;
  name: string;
  status: string;
  totalCapitalToman: number;
  valuationPriceToman: number;
  startedAt?: string | null;
  setup?: {
    durationDays: number;
    endsAt: string;
    orderCapChoice: OrderCapChoice;
    orderCapUsdt: number;
    paperPolicyMinUsdt: number;
  } | null;
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
  limits?: {
    maxUtilizationPercent: number;
    minReservePercent: number;
    maxRouteCapitalPercent: number;
    maxVenueExposurePercent: number;
  };
  usableCapitalToman?: number;
  reserveCapitalToman?: number;
  orderCap?: {
    mode: string;
    choice?: OrderCapChoice;
    derivedMaxOrderUsdt: number;
    effectiveMaxOrderUsdt: number;
    willWritePolicy: boolean;
  };
  orderCapChoice?: OrderCapChoice;
  durationDays?: number;
  startedAt?: string;
  endsAt?: string;
  paperPolicyMinUsdt?: number;
  smartSizeCeilingUsdt?: number;
};

function fmtToman(n: number): string {
  return toFaDigits(Math.round(n).toLocaleString("en-US"));
}

function fmtUsdt(n: number): string {
  return toFaDigits(n.toLocaleString("en-US", { maximumFractionDigits: 4 }));
}

export function PaperSessionCapitalControl() {
  const role = useDeskRole();
  const [roleReady, setRoleReady] = useState(false);
  const [active, setActive] = useState<ActiveSession | null>(null);
  const [limits, setLimits] = useState<{ min: number; max: number } | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [paperMin, setPaperMin] = useState(5);
  const [capitalInput, setCapitalInput] = useState("");
  const [durationDays, setDurationDays] = useState("4");
  const [orderCapChoice, setOrderCapChoice] = useState<OrderCapChoice>("AUTO_CAPITAL_DERIVED");
  const [manualCap, setManualCap] = useState("500");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [okMsg, setOkMsg] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
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
        setLoadError("خواندن وضعیت نشست ناموفق بود");
        return;
      }
      const j = (await res.json()) as {
        activeSession: ActiveSession | null;
        limits: { minCapitalToman: number; maxCapitalToman: number };
        valuationPriceToman: number | null;
        paperPolicyMinUsdt?: number;
        currentOrderCap?: { valueUsdt: number; mode: string } | null;
      };
      setActive(j.activeSession);
      setLimits({ min: j.limits.minCapitalToman, max: j.limits.maxCapitalToman });
      setMark(j.valuationPriceToman);
      if (typeof j.paperPolicyMinUsdt === "number") setPaperMin(j.paperPolicyMinUsdt);
      if (j.activeSession) {
        setCapitalInput((prev) => prev || String(j.activeSession!.totalCapitalToman));
        const setup = j.activeSession.setup;
        if (setup) {
          setDurationDays(String(setup.durationDays));
          setOrderCapChoice(setup.orderCapChoice);
          if (setup.orderCapChoice === "MANUAL") {
            setManualCap(String(setup.orderCapUsdt));
          }
        } else if (j.currentOrderCap?.mode === "MANUAL") {
          setOrderCapChoice("MANUAL");
          setManualCap(String(j.currentOrderCap.valueUsdt));
        }
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

  const invalidatePreview = () => {
    setPreview(null);
    setConfirmChecked(false);
    setOkMsg(null);
  };

  const runPreview = async () => {
    setBusy(true);
    setError(null);
    setOkMsg(null);
    setPreview(null);
    setConfirmChecked(false);
    try {
      const body: Record<string, unknown> = {
        action: "preview",
        totalCapitalToman: capitalInput.replace(/,/g, "").trim(),
        durationDays: Number(durationDays),
        orderCapMode: orderCapChoice
      };
      if (orderCapChoice === "MANUAL") {
        body.manualOrderCapUsdt = Number(manualCap);
      }
      if (mark == null) {
        body.valuationPriceToman = 200_000;
      }
      const res = await fetch("/api/shadow-arbitrage/paper/session-capital", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = (await res.json()) as { message?: string; preview?: Preview };
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
        valuationPriceToman: preview.valuationPriceToman,
        durationDays: preview.durationDays ?? Number(durationDays),
        orderCapMode: preview.orderCapChoice ?? orderCapChoice
      };
      if ((preview.orderCapChoice ?? orderCapChoice) === "MANUAL") {
        body.manualOrderCapUsdt =
          preview.orderCap?.effectiveMaxOrderUsdt ?? Number(manualCap);
      }
      const res = await fetch("/api/shadow-arbitrage/paper/session-capital", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const j = (await res.json()) as {
        message?: string;
        session?: ActiveSession & { setup?: ActiveSession["setup"] };
        reused?: boolean;
        residualToman?: number;
        activeSessionCount?: number;
        endsAt?: string;
        durationDays?: number;
      };
      if (!res.ok) {
        setError(j.message ?? `خطا ${res.status}`);
        return;
      }
      if (j.residualToman !== 0 || j.activeSessionCount !== 1) {
        setError("اعمال: residual≠0 یا بیش از یک نشست فعال");
        return;
      }
      const ends = j.endsAt ?? j.session?.setup?.endsAt ?? "—";
      setOkMsg(
        j.reused
          ? "نشست با همین پیکربندی از قبل فعال بود (بدون تکرار)."
          : `نشست جدید ${fmtToman(j.session!.totalCapitalToman)} تومان · ${toFaDigits(
              j.durationDays ?? 0
            )} روز · endsAt=${ends}`
      );
      setPreview(null);
      setConfirmChecked(false);
      await loadStatus();
    } catch {
      setError("اعمال نشست ناموفق بود");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel sa-panel" aria-label="پیکربندی نشست کاغذی">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title">پیکربندی نشست کاغذی</h3>
        <div className="sa-panel-note">
          سرمایه · مدت · سقف سفارش · حداقل Paper {toFaDigits(paperMin)} تتر (ثابت)
        </div>
      </div>
      <div className="panel-body sa-stack" style={{ gap: 12 }}>
        {loadError ? (
          <p className="sa-sub" style={{ color: "var(--danger, #c44)" }}>
            {loadError}
          </p>
        ) : null}

        <dl className="sa-inner-metrics" style={{ display: "grid", gap: 6 }}>
          <div>
            <dt className="sa-sub">نشست فعال</dt>
            <dd>
              {active ? (
                <code dir="ltr">{active.id}</code>
              ) : (
                <span className="sa-sub">—</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="sa-sub">سرمایهٔ فعلی</dt>
            <dd>
              {active ? <Bidi>{fmtToman(active.totalCapitalToman)}</Bidi> : "—"} تومان
            </dd>
          </div>
          <div>
            <dt className="sa-sub">وضعیت</dt>
            <dd>{active?.status ?? "—"}</dd>
          </div>
          {active?.setup ? (
            <>
              <div>
                <dt className="sa-sub">endsAt (ثابت)</dt>
                <dd dir="ltr">{active.setup.endsAt}</dd>
              </div>
              <div>
                <dt className="sa-sub">سقف سفارش نشست</dt>
                <dd>
                  {active.setup.orderCapChoice} ·{" "}
                  <Bidi>{fmtUsdt(active.setup.orderCapUsdt)}</Bidi> تتر
                </dd>
              </div>
            </>
          ) : null}
        </dl>

        <label className="sa-sub" style={{ display: "grid", gap: 4 }}>
          سرمایه (تومان صحیح)
          <input
            className="sa-control"
            inputMode="numeric"
            dir="ltr"
            value={capitalInput}
            onChange={(e) => {
              setCapitalInput(e.target.value);
              invalidatePreview();
            }}
            placeholder="100000000"
            disabled={busy}
            style={{ maxWidth: 280 }}
          />
        </label>
        {limits ? (
          <p className="sa-sub">
            محدوده: <Bidi>{fmtToman(limits.min)}</Bidi> …{" "}
            <Bidi>{fmtToman(limits.max)}</Bidi>
          </p>
        ) : null}

        <label className="sa-sub" style={{ display: "grid", gap: 4 }}>
          مدت نشست (روز صحیح)
          <input
            className="sa-control"
            inputMode="numeric"
            dir="ltr"
            value={durationDays}
            onChange={(e) => {
              setDurationDays(e.target.value);
              invalidatePreview();
            }}
            placeholder="4"
            disabled={busy}
            style={{ maxWidth: 120 }}
          />
        </label>

        <fieldset style={{ border: "none", padding: 0, margin: 0 }}>
          <legend className="sa-sub">حالت سقف سفارش</legend>
          <div className="sa-segmented glass-tabbar" role="group" aria-label="order cap mode">
            <button
              type="button"
              className={`sa-seg${orderCapChoice === "AUTO_CAPITAL_DERIVED" ? " is-active glass-control" : ""}`}
              aria-pressed={orderCapChoice === "AUTO_CAPITAL_DERIVED"}
              disabled={busy}
              onClick={() => {
                setOrderCapChoice("AUTO_CAPITAL_DERIVED");
                invalidatePreview();
              }}
            >
              AUTO_CAPITAL_DERIVED
            </button>
            <button
              type="button"
              className={`sa-seg${orderCapChoice === "MANUAL" ? " is-active glass-control" : ""}`}
              aria-pressed={orderCapChoice === "MANUAL"}
              disabled={busy}
              onClick={() => {
                setOrderCapChoice("MANUAL");
                invalidatePreview();
              }}
            >
              MANUAL
            </button>
          </div>
        </fieldset>

        {orderCapChoice === "MANUAL" ? (
          <label className="sa-sub" style={{ display: "grid", gap: 4 }}>
            سقف سفارش دستی (تتر، ≥ {toFaDigits(paperMin)})
            <input
              className="sa-control"
              inputMode="decimal"
              dir="ltr"
              value={manualCap}
              onChange={(e) => {
                setManualCap(e.target.value);
                invalidatePreview();
              }}
              placeholder="500"
              disabled={busy}
              style={{ maxWidth: 160 }}
            />
          </label>
        ) : null}

        <p className="sa-sub">
          حداقل Paper: <Bidi>{toFaDigits(paperMin)}</Bidi> تتر (
          <code dir="ltr">paper_policy_min</code>) — ثابت، قابل تنظیم در این فرم نیست.
        </p>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button
            type="button"
            className="sa-btn sa-btn-ghost"
            disabled={busy}
            onClick={() => void runPreview()}
          >
            پیش‌نمایش نشست
          </button>
        </div>

        {preview ? (
          <div
            className="sa-inner-card"
            style={{ border: "1px solid var(--border, #333)", borderRadius: 10, padding: 12 }}
          >
            <h4 className="sa-inner-card-title">پیش‌نمایش (قبل از اعمال)</h4>
            <ul className="sa-sub" style={{ margin: "8px 0", lineHeight: 1.85 }}>
              <li>
                سرمایه: <Bidi>{fmtToman(preview.totalCapitalToman)}</Bidi> تومان
              </li>
              <li>
                ذخیره (reserve{" "}
                {preview.limits ? toFaDigits(preview.limits.minReservePercent) : "—"}٪):{" "}
                <Bidi>{fmtToman(preview.reserveCapitalToman ?? 0)}</Bidi> تومان
              </li>
              <li>
                قابل استفاده (util ≤{" "}
                {preview.limits ? toFaDigits(preview.limits.maxUtilizationPercent) : "—"}٪):{" "}
                <Bidi>{fmtToman(preview.usableCapitalToman ?? 0)}</Bidi> تومان
              </li>
              <li>
                سقف مسیر / تمرکز: route ≤{" "}
                {preview.limits ? toFaDigits(preview.limits.maxRouteCapitalPercent) : "—"}٪ ·
                venue ≤{" "}
                {preview.limits ? toFaDigits(preview.limits.maxVenueExposurePercent) : "—"}٪
              </li>
              <li>
                سقف سفارش (
                {preview.orderCapChoice ?? orderCapChoice}):{" "}
                <Bidi>{fmtUsdt(preview.orderCap?.effectiveMaxOrderUsdt ?? 0)}</Bidi> تتر
                {preview.orderCap ? (
                  <>
                    {" "}
                    · derived <Bidi>{fmtUsdt(preview.orderCap.derivedMaxOrderUsdt)}</Bidi>
                  </>
                ) : null}
              </li>
              <li>
                سقف حجم هوشمند (setup):{" "}
                <Bidi>{fmtUsdt(preview.smartSizeCeilingUsdt ?? 0)}</Bidi> تتر
              </li>
              <li>
                حداقل Paper: <Bidi>{fmtUsdt(preview.paperPolicyMinUsdt ?? paperMin)}</Bidi> تتر
              </li>
              <li>
                مدت: <Bidi>{toFaDigits(preview.durationDays ?? 0)}</Bidi> روز
              </li>
              <li>
                endsAt: <code dir="ltr">{preview.endsAt ?? "—"}</code>
              </li>
              <li>
                باقیمانده تخصیص: <Bidi>{fmtToman(preview.residualToman)}</Bidi>{" "}
                {preview.residualToman === 0 ? "✓" : "✗"}
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
                تأیید: نشست فعال بایگانی می‌شود (تاریخچه حذف نمی‌شود) و دقیقاً یک نشست RUNNING
                جدید با endsAt ثابت ساخته می‌شود. نشست فعلی به‌صورت خاموش تمدید یا ویرایش
                نمی‌شود.
              </span>
            </label>
            <button
              type="button"
              className="sa-btn sa-btn-primary"
              style={{ marginTop: 10 }}
              disabled={busy || !confirmChecked || preview.residualToman !== 0}
              onClick={() => void runApply()}
            >
              اعمال و جایگزینی نشست
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
