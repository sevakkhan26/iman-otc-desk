"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatTehran } from "@/components/format";
import { formatCountFa, formatPercentFa, toFaDigits } from "@/components/shadowArbitrage/labels";

type Estimate<T> =
  | { status: "KNOWN"; value: T }
  | { status: "UNKNOWN"; reason: string }
  | { status: "BLOCKED"; reason: string };

type VenueState = {
  sourceId: string;
  nameFa: string;
  capitalClass: "EXECUTABLE" | "WHATIF_DISABLED" | "REFERENCE_ONLY";
  executable: boolean;
  takerFeeBps: number | null;
  feeStale: boolean;
  blockingReason: string | null;
};

type Allocation = { sourceId: string; irtToman: number; usdtUnits: number };

type VenueView = {
  sourceId: string;
  nameFa: string;
  capitalClass: VenueState["capitalClass"];
  irtToman: number;
  usdtUnits: number;
  usdtValueToman: number;
  totalValueToman: number;
  sharePercent: number;
  maxBuyUsdt: number;
  maxSellUsdt: number;
  blockingReason: string | null;
};

type Simulation = {
  ok: boolean;
  violations: Array<{ code: string; sourceId: string | null; messageFa: string }>;
  mode: "MANUAL" | "OPTIMIZED";
  totalCapitalToman: number;
  valuationPriceToman: number;
  allocatedToman: number;
  unusedReserveToman: number;
  unusedReservePercent: number;
  capitalUtilizationPercent: number;
  idleOnDisabledVenuesToman: number;
  venues: VenueView[];
  concentration: Estimate<{
    hhi: number;
    maxVenueSharePercent: number;
    venueCount: number;
    band: "LOW" | "MODERATE" | "HIGH";
    labelFa: string;
  }>;
  opportunityCoveragePercent: Estimate<number>;
  coverage: {
    observedRouteSamples: number;
    executableRouteSamples: number;
    fundedRouteSamples: number;
    fundedOfExecutablePercent: Estimate<number>;
    unfundedTopReasons: Array<{ reasonFa: string; samples: number }>;
  };
  rebalance: {
    costToman: Estimate<number>;
    expectedMonthlyRebalances: Estimate<number>;
  };
  recommendation: {
    status: "PROVISIONAL";
    locked: boolean;
    reasonFa: string;
    observationStatus: string;
    successCoveragePercent: number;
    requiredCoveragePercent: number;
    observationGatePassed: boolean;
  };
  conservationResidualToman: number;
  notesFa: string[];
};

type Payload = {
  defaults: { capitalToman: number; minCapitalToman: number; maxCapitalToman: number };
  valuationPriceToman: number | null;
  venues: VenueState[];
  plan: { totalCapitalToman: number; allocations: Allocation[]; mode: "MANUAL" | "OPTIMIZED" } | null;
  planSource?: string;
  simulation: Simulation | null;
  smallestFundableSizeUsdt?: number | null;
  optimization?: { basisFa: string; reasonFa: string };
  history?: Array<{ id: string; name: string; mode: string; createdBy: string; createdAt: string }>;
  unavailableReason?: string;
  observationId?: string | null;
};

const CLASS_FA: Record<VenueState["capitalClass"], string> = {
  EXECUTABLE: "اجراپذیر",
  WHATIF_DISABLED: "غیرفعال — فقط سناریو",
  REFERENCE_ONLY: "فقط مرجع"
};

const CLASS_TONE: Record<VenueState["capitalClass"], string> = {
  EXECUTABLE: "good",
  WHATIF_DISABLED: "warn",
  REFERENCE_ONLY: "muted"
};

const CONCENTRATION_TONE: Record<"LOW" | "MODERATE" | "HIGH", string> = {
  LOW: "good",
  MODERATE: "warn",
  HIGH: "danger"
};

function toman(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${toFaDigits(Math.round(value).toLocaleString("en-US"))} تومان`;
}

function usdt(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${toFaDigits(value.toFixed(2))} تتر`;
}

/** Renders a value that is allowed to be unavailable, without inventing one. */
function EstimateValue({
  estimate,
  render
}: {
  estimate: Estimate<number> | undefined;
  render: (v: number) => string;
}) {
  if (!estimate) return <span className="sa-reason">نامشخص</span>;
  if (estimate.status === "KNOWN") return <>{render(estimate.value)}</>;
  return (
    <span className="sa-reason" title={estimate.reason}>
      {estimate.status === "BLOCKED" ? "مسدود" : "نامشخص"}
    </span>
  );
}

/**
 * Phase 5 — capital allocation simulator.
 *
 * Read-only with respect to the market: this panel never places an order or
 * moves funds, and it does not run paper execution (that is Phase 6).
 */
export function CapitalSimulator() {
  const [data, setData] = useState<Payload | null>(null);
  const [capital, setCapital] = useState<string>("");
  const [rows, setRows] = useState<Record<string, { irt: string; usdt: string }>>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const applyPayload = useCallback((j: Payload) => {
    setData(j);
    if (j.plan) {
      setCapital(String(j.plan.totalCapitalToman));
      const next: Record<string, { irt: string; usdt: string }> = {};
      for (const a of j.plan.allocations) {
        next[a.sourceId] = { irt: String(Math.round(a.irtToman)), usdt: String(a.usdtUnits) };
      }
      setRows(next);
    } else {
      setCapital(String(j.defaults?.capitalToman ?? 50_000_000));
    }
  }, []);

  const load = useCallback(async () => {
    const res = await fetch("/api/shadow-arbitrage/capital", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!res.ok) return;
    applyPayload((await res.json()) as Payload);
  }, [applyPayload]);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const allocations = useMemo<Allocation[]>(
    () =>
      Object.entries(rows)
        .map(([sourceId, v]) => ({
          sourceId,
          irtToman: Number(v.irt) || 0,
          usdtUnits: Number(v.usdt) || 0
        }))
        .filter((a) => a.irtToman > 0 || a.usdtUnits > 0),
    [rows]
  );

  const post = useCallback(
    async (action: "simulate" | "optimize" | "save") => {
      setBusy(true);
      setNotice(null);
      try {
        const res = await fetch("/api/shadow-arbitrage/capital", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            action,
            totalCapitalToman: Number(capital) || 0,
            mode: action === "optimize" ? "OPTIMIZED" : "MANUAL",
            allocations
          })
        });
        const j = (await res.json().catch(() => null)) as (Payload & { message?: string }) | null;
        if (!res.ok) throw new Error(j?.message ?? "درخواست ناموفق بود");
        if (j) applyPayload(j);
        if (action === "save") setNotice("طرح ذخیره شد و در سابقه نگهداری می‌شود.");
        if (action === "optimize") setNotice("تخصیص پیشنهادی و موقت ساخته شد.");
      } catch (e) {
        setNotice(e instanceof Error ? e.message : "درخواست ناموفق بود");
      } finally {
        setBusy(false);
      }
    },
    [capital, allocations, applyPayload]
  );

  const sim = data?.simulation ?? null;
  const venues = data?.venues ?? [];

  return (
    <section className="panel sa-panel">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title sa-panel-title">شبیه‌ساز تخصیص سرمایه</h3>
        <div className="sa-panel-note">
          موجودی‌ها مجازی‌اند · بدون سفارش و بدون انتقال وجه ·{" "}
          <button type="button" className="sa-linkish" onClick={() => setOpen((v) => !v)}>
            {open ? "بستن" : "باز کردن"}
          </button>
        </div>
      </div>

      {!open ? null : (
        <>
          {data?.unavailableReason ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-warn">{data.unavailableReason}</div>
            </div>
          ) : null}

          {notice ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-muted">{notice}</div>
            </div>
          ) : null}

          {sim && !sim.ok ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-danger">
                <div>طرح تخصیص معتبر نیست:</div>
                <ul className="sa-list">
                  {sim.violations.map((v, i) => (
                    <li key={`${v.code}-${i}`}>
                      {v.messageFa}
                      {v.sourceId ? ` — ${v.sourceId}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          ) : null}

          <div className="panel-body sa-capital-controls">
            <label className="sa-field">
              <span>سرمایهٔ کل (تومان)</span>
              <input
                type="number"
                inputMode="numeric"
                value={capital}
                min={data?.defaults?.minCapitalToman ?? 1_000_000}
                max={data?.defaults?.maxCapitalToman ?? 100_000_000_000}
                onChange={(e) => setCapital(e.target.value)}
              />
            </label>
            <div className="sa-field">
              <span>قیمت ارزش‌گذاری تتر</span>
              <strong>{toman(data?.valuationPriceToman ?? null)}</strong>
            </div>
            <div className="sa-capital-actions">
              <button type="button" className="sa-btn" disabled={busy} onClick={() => void post("simulate")}>
                محاسبهٔ دستی
              </button>
              <button type="button" className="sa-btn" disabled={busy} onClick={() => void post("optimize")}>
                تخصیص پیشنهادی (موقت)
              </button>
              <button
                type="button"
                className="sa-btn sa-btn-primary"
                disabled={busy || !sim?.ok}
                onClick={() => void post("save")}
              >
                ذخیرهٔ طرح
              </button>
            </div>
          </div>

          {data?.optimization ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-muted">
                {data.optimization.basisFa} · {data.optimization.reasonFa}
              </div>
            </div>
          ) : null}

          {sim ? (
            <div className="panel-body sa-metric-grid">
              <div className="sa-metric">
                <div className="sa-metric-label">بهره‌وری سرمایه</div>
                <div className="sa-metric-value">{formatPercentFa(sim.capitalUtilizationPercent)}</div>
                <div className="sa-metric-note">سهم سرمایه روی صرافی‌های اجراپذیر</div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">پوشش فرصت‌ها</div>
                <div className="sa-metric-value">
                  <EstimateValue
                    estimate={sim.opportunityCoveragePercent}
                    render={(v) => formatPercentFa(v)}
                  />
                </div>
                <div className="sa-metric-note">
                  {formatCountFa(sim.coverage.fundedRouteSamples)} از{" "}
                  {formatCountFa(sim.coverage.observedRouteSamples)} نمونهٔ مسیر
                </div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">ذخیرهٔ استفاده‌نشده</div>
                <div className="sa-metric-value">{toman(sim.unusedReserveToman)}</div>
                <div className="sa-metric-note">
                  {formatPercentFa(sim.unusedReservePercent)} از کل سرمایه
                </div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">ریسک تمرکز</div>
                <div className="sa-metric-value">
                  {sim.concentration.status === "KNOWN" ? (
                    <span className={`sa-chip sa-chip-${CONCENTRATION_TONE[sim.concentration.value.band]}`}>
                      {sim.concentration.value.labelFa}
                    </span>
                  ) : (
                    <span className="sa-reason" title={sim.concentration.reason}>
                      نامشخص
                    </span>
                  )}
                </div>
                <div className="sa-metric-note">
                  {sim.concentration.status === "KNOWN"
                    ? `HHI ${toFaDigits(sim.concentration.value.hhi)} · بیشترین سهم ${formatPercentFa(
                        sim.concentration.value.maxVenueSharePercent
                      )}`
                    : "بدون تخصیص"}
                </div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">هزینهٔ بازتوازن ماهانه</div>
                <div className="sa-metric-value">
                  <EstimateValue estimate={sim.rebalance.costToman} render={(v) => toman(v)} />
                </div>
                <div className="sa-metric-note">
                  دفعات ماهانه:{" "}
                  <EstimateValue
                    estimate={sim.rebalance.expectedMonthlyRebalances}
                    render={(v) => formatCountFa(v)}
                  />
                </div>
              </div>
              <div className="sa-metric">
                <div className="sa-metric-label">سرمایهٔ راکد</div>
                <div className="sa-metric-value">{toman(sim.idleOnDisabledVenuesToman)}</div>
                <div className="sa-metric-note">روی صرافی‌های غیراجراپذیر</div>
              </div>
            </div>
          ) : null}

          <div className="panel-body sa-table-wrap">
            <table className="sa-table">
              <thead>
                <tr>
                  <th>صرافی</th>
                  <th>وضعیت</th>
                  <th className="num">موجودی تومانی</th>
                  <th className="num">موجودی تتری</th>
                  <th className="num">ارزش کل</th>
                  <th className="num">سهم</th>
                  <th className="num">حداکثر خرید</th>
                  <th className="num">حداکثر فروش</th>
                  <th>دلیل غیرفعال بودن</th>
                </tr>
              </thead>
              <tbody>
                {venues.map((v) => {
                  const view = sim?.venues.find((x) => x.sourceId === v.sourceId) ?? null;
                  const row = rows[v.sourceId] ?? { irt: "", usdt: "" };
                  return (
                    <tr key={v.sourceId}>
                      <td>
                        <strong>{v.nameFa}</strong>
                      </td>
                      <td>
                        <span className={`sa-chip sa-chip-sm sa-chip-${CLASS_TONE[v.capitalClass]}`}>
                          {CLASS_FA[v.capitalClass]}
                        </span>
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          inputMode="numeric"
                          min={0}
                          className="sa-cell-input"
                          value={row.irt}
                          disabled={v.capitalClass === "REFERENCE_ONLY"}
                          onChange={(e) =>
                            setRows((r) => ({
                              ...r,
                              [v.sourceId]: { irt: e.target.value, usdt: r[v.sourceId]?.usdt ?? "" }
                            }))
                          }
                        />
                      </td>
                      <td className="num">
                        <input
                          type="number"
                          inputMode="decimal"
                          min={0}
                          step="0.01"
                          className="sa-cell-input"
                          value={row.usdt}
                          disabled={v.capitalClass === "REFERENCE_ONLY"}
                          onChange={(e) =>
                            setRows((r) => ({
                              ...r,
                              [v.sourceId]: { irt: r[v.sourceId]?.irt ?? "", usdt: e.target.value }
                            }))
                          }
                        />
                      </td>
                      <td className="num">{view ? toman(view.totalValueToman) : "—"}</td>
                      <td className="num">{view ? formatPercentFa(view.sharePercent) : "—"}</td>
                      <td className="num">{view ? usdt(view.maxBuyUsdt) : "—"}</td>
                      <td className="num">{view ? usdt(view.maxSellUsdt) : "—"}</td>
                      <td className="sa-wrap-cell">
                        {v.blockingReason ? <span className="sa-reason">{v.blockingReason}</span> : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {sim ? (
            <div className="panel-body">
              <div className="sa-callout sa-callout-warn">
                <strong>توصیهٔ نهایی قفل است — وضعیت: موقت.</strong> {sim.recommendation.reasonFa} (وضعیت
                مشاهده: {sim.recommendation.observationStatus} · پوشش موفق{" "}
                {formatPercentFa(sim.recommendation.successCoveragePercent)} · حداقل لازم{" "}
                {formatPercentFa(sim.recommendation.requiredCoveragePercent, 0)})
              </div>

              {sim.coverage.unfundedTopReasons.length ? (
                <div className="sa-subpanel">
                  <div className="sa-subpanel-title">چرا بخشی از فرصت‌ها پوشش داده نشد</div>
                  <ul className="sa-list">
                    {sim.coverage.unfundedTopReasons.map((r) => (
                      <li key={r.reasonFa}>
                        {r.reasonFa} — {formatCountFa(r.samples)} نمونه
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              <ul className="sa-list sa-list-muted">
                {sim.notesFa.map((n, i) => (
                  <li key={i}>{n}</li>
                ))}
                <li>
                  تراز پرتفوی: مانده{" "}
                  {toFaDigits(sim.conservationResidualToman)} تومان (باید صفر باشد)
                </li>
              </ul>
            </div>
          ) : null}

          {data?.history?.length ? (
            <div className="panel-body sa-table-wrap">
              <div className="sa-subpanel-title">سابقهٔ طرح‌های ذخیره‌شده</div>
              <table className="sa-table">
                <thead>
                  <tr>
                    <th>نام</th>
                    <th>حالت</th>
                    <th>ثبت‌کننده</th>
                    <th>زمان</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((h) => (
                    <tr key={h.id}>
                      <td>{h.name}</td>
                      <td>{h.mode === "OPTIMIZED" ? "پیشنهادی" : "دستی"}</td>
                      <td>{h.createdBy}</td>
                      <td className="text-micro">{formatTehran(h.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}
