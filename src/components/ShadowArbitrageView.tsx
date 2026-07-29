"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DeskPageHeader } from "@/components/DeskPageHeader";
import { TomanAmount } from "@/components/TomanAmount";
import { formatNumber } from "@/components/format";
import type {
  NormalizedSourceSnapshot,
  ShadowAnalytics,
  ShadowMatrixResponse,
  ShadowOpportunity
} from "@/lib/shadowArbitrage/types";

type FilterState = {
  size: "all" | string;
  source: "all" | string;
  eligibility: "all" | string;
  netPositiveOnly: boolean;
  showEnded: boolean;
};

type Certification = {
  sourceId: string;
  sourceName: string;
  status: string;
  statusReason: string | null;
  endpoint: string;
  documentationUrl: string | null;
  marketSymbol: string;
  marketModel: string;
  priceUnit: string;
  quantityUnit: string;
  observedPriceUnit: string | null;
  directionNote: string;
  depthNote: string;
  timestampNote: string;
  rateLimitNote: string;
  limitations: string;
  lastProbeAt: string | null;
  lastHttpStatus: number | null;
  lastLatencyMs: number | null;
  lastAttempts: number | null;
  lastRateLimited: boolean;
  lastError: string | null;
  depthAvailable: boolean | null;
  directionVerified: boolean | null;
  maxExecutableUsdt: number | null;
  exchangeTimestamp: string | null;
  verifiedAt: string | null;
  feeStatus: string;
  feeValueBps: number | null;
  feeReferenceUrl: string | null;
  feeVerifiedAt: string | null;
  feeExplanation: string;
};

type SourceHealthRow = {
  sourceId: string;
  sourceName: string;
  samples: number;
  uptimePercent: number;
  errorRatePercent: number;
  freshnessPercent: number;
  latencyP50Ms: number | null;
  latencyP95Ms: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  rateLimitNote: string;
};

type Observation = {
  id: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  pausedAt: string | null;
  lastHeartbeatAt: string | null;
  lastSuccessAt: string | null;
  completedCycles: number;
  successfulCycles: number;
  failedCycles: number;
  partialCycles: number;
  pollIntervalMs: number;
  targetDurationMs: number;
  elapsedMs: number;
  remainingMs: number;
  progressPercent: number;
  cycleCoveragePercent: number;
  expectedCycles: number;
  workerId: string | null;
};

type WorkerState = {
  workerId: string | null;
  status: string;
  lastHeartbeatAt: string | null;
  lastCycleAt: string | null;
  lastCycleStatus: string | null;
  pollIntervalMs: number;
  leaseExpiresAt: string | null;
  stale: boolean;
  leaseHeld: boolean;
  nextExpectedCycleAt: string | null;
};

type CostRecord = {
  key: string;
  label: string;
  value: number;
  unit: string;
  status: string;
  reference: string | null;
  verifiedAt: string | null;
  explanation: string;
};

type ObservationPayload = {
  observation: Observation | null;
  worker: WorkerState;
  certifications: Certification[];
  sourceHealth: SourceHealthRow[];
  costRecords: CostRecord[];
  runStats: {
    runCount: number;
    successfulRuns: number;
    partialRuns: number;
    failedRuns: number;
    duplicateIdempotencyKeys: number;
  };
  workerCommand: string;
};

const ELIG_FA: Record<string, string> = {
  EXECUTABLE_NOW: "قابل اجرا (نظری)",
  ACCOUNT_REQUIRED: "نیاز به حساب",
  REFERENCE_ONLY: "فقط مرجع",
  BLOCKED: "مسدود"
};

const HEALTH_FA: Record<string, string> = {
  healthy: "سالم",
  degraded: "تضعیف‌شده",
  unavailable: "ناموجود"
};

const ACCOUNT_FA: Record<string, string> = {
  verified: "تأییدشده",
  unverified: "بدون حساب",
  unknown: "نامشخص"
};

const OBS_FA: Record<string, string> = {
  NOT_STARTED: "شروع نشده",
  RUNNING: "در حال اجرا",
  PAUSED: "متوقف موقت",
  DEGRADED: "تضعیف‌شده",
  COMPLETED: "کامل شده"
};

const CERT_FA: Record<string, string> = {
  LIVE_VERIFIED: "تأیید زنده",
  LIVE_DEGRADED: "زندهٔ تضعیف‌شده",
  REFERENCE_ONLY: "فقط مرجع",
  UNSUPPORTED: "پشتیبانی‌نشده",
  PENDING_PROBE: "در انتظار probe"
};

const FEE_FA: Record<string, string> = {
  official: "رسمی",
  account_api: "از API حساب",
  provisional: "موقت",
  unknown: "نامشخص"
};

function eligibilityTone(e: string): string {
  if (e === "EXECUTABLE_NOW") return "good";
  if (e === "ACCOUNT_REQUIRED") return "warn";
  if (e === "REFERENCE_ONLY") return "muted";
  return "danger";
}

function certTone(status: string): string {
  if (status === "LIVE_VERIFIED") return "good";
  if (status === "LIVE_DEGRADED") return "warn";
  if (status === "REFERENCE_ONLY" || status === "PENDING_PROBE") return "muted";
  return "danger";
}

function fmtDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d} روز و ${h} ساعت`;
  if (h > 0) return `${h} ساعت و ${m} دقیقه`;
  return `${m} دقیقه`;
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("fa-IR", { hour12: false });
}

export function ShadowArbitrageView() {
  const [matrix, setMatrix] = useState<ShadowMatrixResponse | null>(null);
  const [history, setHistory] = useState<ShadowOpportunity[]>([]);
  const [analytics, setAnalytics] = useState<ShadowAnalytics | null>(null);
  const [obs, setObs] = useState<ObservationPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [serverNow, setServerNow] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    size: "all",
    source: "all",
    eligibility: "all",
    netPositiveOnly: false,
    showEnded: false
  });

  /**
   * Reads persisted server results only. `refresh` asks the server for one
   * rate-limited collection cycle; the browser never contacts an exchange.
   */
  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      const q = refresh ? "?refresh=1" : "";
      const [mRes, hRes, aRes, oRes] = await Promise.all([
        fetch(`/api/shadow-arbitrage/matrix${q}`, { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/history", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/analytics", { cache: "no-store", credentials: "same-origin" }),
        fetch("/api/shadow-arbitrage/observation", { cache: "no-store", credentials: "same-origin" })
      ]);

      if (mRes.status === 403) {
        setError("این صفحه فقط برای مدیر سیستم است.");
        setMatrix(null);
        return;
      }
      if (mRes.ok) {
        const m = (await mRes.json()) as ShadowMatrixResponse;
        setMatrix(m);
        setServerNow(m.serverNow);
      } else {
        const body = (await mRes.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? `matrix HTTP ${mRes.status}`);
      }
      if (hRes.ok) {
        const h = (await hRes.json()) as { opportunities?: ShadowOpportunity[] };
        setHistory(h.opportunities ?? []);
      }
      if (aRes.ok) {
        const a = (await aRes.json()) as { analytics?: ShadowAnalytics };
        setAnalytics(a.analytics ?? null);
      }
      if (oRes.ok) {
        setObs((await oRes.json()) as ObservationPayload);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  const control = useCallback(
    async (action: "pause" | "resume" | "start") => {
      setNotice(null);
      try {
        const res = await fetch("/api/shadow-arbitrage/observation", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action })
        });
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
        setNotice(action === "pause" ? "مشاهده متوقف شد." : "مشاهده ادامه یافت.");
        await load(false);
      } catch (e) {
        setNotice(e instanceof Error ? e.message : String(e));
      }
    },
    [load]
  );

  useEffect(() => {
    // Cache-first on mount: the worker is the collection mechanism, not the UI.
    void load(false);
    const id = window.setInterval(() => void load(false), 35_000);
    return () => window.clearInterval(id);
  }, [load]);

  const opportunities = useMemo(() => {
    const list = filters.showEnded ? history : (matrix?.opportunities ?? history.filter((o) => o.isActive));
    return list.filter((o) => {
      if (filters.size !== "all" && String(o.sizeUsdt) !== filters.size) return false;
      if (
        filters.source !== "all" &&
        o.buySourceId !== filters.source &&
        o.sellSourceId !== filters.source
      ) {
        return false;
      }
      if (filters.eligibility !== "all" && o.eligibility !== filters.eligibility) return false;
      if (filters.netPositiveOnly) {
        if (
          o.netProfitToman <= 0 ||
          o.feeUnknown ||
          o.blockedReasons.includes("fee_unknown") ||
          o.eligibility === "BLOCKED"
        ) {
          return false;
        }
      }
      return true;
    });
  }, [matrix, history, filters]);

  const sources: NormalizedSourceSnapshot[] = matrix?.sources ?? [];
  const observation = obs?.observation ?? null;
  const worker = obs?.worker ?? null;
  const healthById = useMemo(
    () => new Map((obs?.sourceHealth ?? []).map((h) => [h.sourceId, h])),
    [obs]
  );

  return (
    <div className="shadow-arb-page">
      <DeskPageHeader
        title="آربیتراژ سایه"
        serverNow={serverNow}
        loading={loading}
        onRefresh={() => void load(true)}
        lastUpdated={serverNow ? Date.parse(serverNow) : null}
      />

      {/* Permanent — never hidden, in any state. */}
      <div className="shadow-banner" role="status">
        <strong>SHADOW MODE</strong>
        <span> — NO REAL ORDERS OR FUND TRANSFERS</span>
        <div className="shadow-banner-fa">حالت سایه — بدون سفارش واقعی یا انتقال وجه</div>
      </div>

      {error ? (
        <div className="panel panel-body" style={{ color: "var(--red)" }}>
          {error}
        </div>
      ) : null}
      {notice ? <div className="panel panel-body text-caption">{notice}</div> : null}

      {/* ===== Observation status ===== */}
      <section className="panel shadow-section">
        <div className="panel-header">
          <h3 className="panel-title">وضعیت مشاهدهٔ ۱۴ روزه</h3>
          <div className="shadow-obs-actions">
            {observation?.status === "PAUSED" ? (
              <button type="button" className="btn" onClick={() => void control("resume")}>
                ادامه
              </button>
            ) : (
              <button type="button" className="btn" onClick={() => void control("pause")}>
                توقف موقت
              </button>
            )}
          </div>
        </div>
        <div className="panel-body">
          <div className="metrics grid shadow-obs-grid">
            <div className="metric">
              <div className="metric-label">وضعیت مشاهده</div>
              <div className="metric-value">
                <span className={`badge ${observation?.status === "RUNNING" ? "good" : observation?.status === "DEGRADED" ? "warn" : "muted"}`}>
                  {OBS_FA[observation?.status ?? ""] ?? "—"}
                </span>
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">وضعیت worker</div>
              <div className="metric-value text-callout">
                <span className={`badge ${worker && !worker.stale ? "good" : "danger"}`}>
                  {worker?.status ?? "stopped"}
                  {worker?.stale ? " (کهنه)" : ""}
                </span>
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">قفل/lease فعال</div>
              <div className="metric-value text-callout">
                {worker?.leaseHeld ? `بله — ${worker.workerId ?? "?"}` : "خیر"}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">شروع مشاهده</div>
              <div className="metric-value text-micro">{fmtTime(observation?.startedAt)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">مدت سپری‌شده</div>
              <div className="metric-value text-callout">{fmtDuration(observation?.elapsedMs)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">پیشرفت تا ۱۴ روز</div>
              <div className="metric-value">
                {observation ? `${formatNumber(observation.progressPercent, 2)}٪` : "—"}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">چرخه‌های کامل</div>
              <div className="metric-value">{observation?.completedCycles ?? 0}</div>
            </div>
            <div className="metric">
              <div className="metric-label">موفق / جزئی / ناموفق</div>
              <div className="metric-value text-callout">
                {observation?.successfulCycles ?? 0} / {observation?.partialCycles ?? 0} /{" "}
                {observation?.failedCycles ?? 0}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">پوشش چرخه‌ها</div>
              <div className="metric-value">
                {observation ? `${formatNumber(observation.cycleCoveragePercent, 1)}٪` : "—"}
                <div className="text-micro">
                  {observation ? `${observation.completedCycles} از ${observation.expectedCycles} انتظاری` : ""}
                </div>
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">پوشش داده منابع</div>
              <div className="metric-value">
                {analytics ? `${formatNumber(analytics.dataCoveragePercent, 1)}٪` : "—"}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">آخرین heartbeat</div>
              <div className="metric-value text-micro">
                {fmtTime(worker?.lastHeartbeatAt ?? observation?.lastHeartbeatAt)}
              </div>
            </div>
            <div className="metric">
              <div className="metric-label">آخرین چرخهٔ موفق</div>
              <div className="metric-value text-micro">{fmtTime(observation?.lastSuccessAt)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">چرخهٔ بعدی (انتظاری)</div>
              <div className="metric-value text-micro">{fmtTime(worker?.nextExpectedCycleAt)}</div>
            </div>
            <div className="metric">
              <div className="metric-label">فاصلهٔ polling</div>
              <div className="metric-value text-callout">
                {observation ? `${Math.round(observation.pollIntervalMs / 1000)} ثانیه` : "—"}
              </div>
            </div>
          </div>

          {observation ? (
            <div className="shadow-progress" aria-hidden="true">
              <div
                className="shadow-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, observation.progressPercent))}%` }}
              />
            </div>
          ) : null}

          <p className="text-caption" style={{ marginTop: 10 }}>
            جمع‌آوری خودکار توسط worker پس‌زمینه انجام می‌شود:{" "}
            <code className="text-mono-tech">{obs?.workerCommand ?? "pnpm shadow:worker"}</code>. مرورگر
            هرگز مستقیم به صرافی‌ها وصل نمی‌شود و Refresh دستی محدودشده و single-flight است.
            {obs?.runStats ? (
              <>
                {" "}چرخه‌های ثبت‌شده: {obs.runStats.runCount} (تکراری: {obs.runStats.duplicateIdempotencyKeys}).
              </>
            ) : null}
          </p>
        </div>
      </section>

      {/* ===== Source certification ===== */}
      <section className="panel shadow-section">
        <div className="panel-header">
          <h3 className="panel-title">گواهی منابع (۹ منبع عمومی)</h3>
        </div>
        <div className="panel-body table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>منبع</th>
                <th>وضعیت گواهی</th>
                <th>مدل بازار</th>
                <th>واحد نرمال‌شده</th>
                <th>آخرین پاسخ</th>
                <th>Latency</th>
                <th>تازگی</th>
                <th>کارمزد</th>
                <th>Uptime</th>
                <th>نرخ خطا</th>
                <th>تاریخ تأیید</th>
                <th>آخرین خطا / محدودیت</th>
              </tr>
            </thead>
            <tbody>
              {(obs?.certifications ?? []).map((c) => {
                const h = healthById.get(c.sourceId);
                return (
                  <tr key={c.sourceId}>
                    <td>
                      <strong>{c.sourceName ?? c.sourceId}</strong>
                      <div className="text-micro">{c.marketSymbol}</div>
                      <div className="text-micro shadow-endpoint">{c.endpoint}</div>
                    </td>
                    <td>
                      <span className={`badge ${certTone(c.status)}`}>
                        {CERT_FA[c.status] ?? c.status}
                      </span>
                      <div className="shadow-flags">
                        {c.depthAvailable === false && c.marketModel === "ORDER_BOOK" ? (
                          <span className="badge warn">بدون عمق</span>
                        ) : null}
                        {c.directionVerified === false ? (
                          <span className="badge warn">جهت تأییدنشده</span>
                        ) : null}
                        {c.feeStatus === "unknown" ? (
                          <span className="badge warn">کارمزد نامشخص</span>
                        ) : null}
                        {c.status === "REFERENCE_ONLY" ? (
                          <span className="badge muted">فقط مرجع</span>
                        ) : null}
                        {c.lastRateLimited ? <span className="badge warn">rate limit</span> : null}
                      </div>
                    </td>
                    <td>
                      {c.marketModel}
                      <div className="text-micro">{c.quantityUnit}</div>
                    </td>
                    <td>
                      تومان (IRT)
                      <div className="text-micro">منبع: {c.priceUnit}</div>
                      {c.observedPriceUnit === "ambiguous" ? (
                        <div className="text-micro" style={{ color: "var(--yellow)" }}>
                          واحد مشاهده‌شده مبهم
                        </div>
                      ) : null}
                    </td>
                    <td className="text-micro">
                      {fmtTime(c.lastProbeAt)}
                      <div>HTTP {c.lastHttpStatus ?? "—"}</div>
                      {c.lastAttempts && c.lastAttempts > 1 ? (
                        <div>تلاش: {c.lastAttempts}</div>
                      ) : null}
                    </td>
                    <td className="number">
                      {c.lastLatencyMs != null ? `${c.lastLatencyMs}ms` : "—"}
                      {h?.latencyP50Ms != null ? (
                        <div className="text-micro">
                          p50 {h.latencyP50Ms} / p95 {h.latencyP95Ms ?? "—"}
                        </div>
                      ) : null}
                    </td>
                    <td className="number">
                      {h ? `${formatNumber(h.freshnessPercent, 1)}٪` : "—"}
                      {c.exchangeTimestamp ? (
                        <div className="text-micro">ts صرافی دارد</div>
                      ) : (
                        <div className="text-micro">بدون ts صرافی</div>
                      )}
                    </td>
                    <td className="text-micro">
                      <span className={`badge ${c.feeStatus === "unknown" ? "warn" : "muted"}`}>
                        {FEE_FA[c.feeStatus] ?? c.feeStatus}
                      </span>
                      <div>
                        {c.feeValueBps != null ? `${formatNumber(c.feeValueBps / 100, 2)}٪` : "نامشخص"}
                      </div>
                      {c.feeVerifiedAt ? <div>تأیید: {c.feeVerifiedAt}</div> : null}
                      {c.feeReferenceUrl ? (
                        <div className="shadow-endpoint">{c.feeReferenceUrl}</div>
                      ) : null}
                    </td>
                    <td className="number">
                      {h ? `${formatNumber(h.uptimePercent, 1)}٪` : "—"}
                      {h ? <div className="text-micro">{h.samples} نمونه</div> : null}
                    </td>
                    <td className="number">{h ? `${formatNumber(h.errorRatePercent, 1)}٪` : "—"}</td>
                    <td className="text-micro">{c.verifiedAt ? fmtTime(c.verifiedAt) : "تأییدنشده"}</td>
                    <td className="text-micro shadow-note-cell">
                      {c.statusReason ? <div>{c.statusReason}</div> : null}
                      {c.lastError ? <div>{c.lastError}</div> : null}
                      <div className="text-micro">{c.limitations}</div>
                    </td>
                  </tr>
                );
              })}
              {!(obs?.certifications ?? []).length ? (
                <tr>
                  <td colSpan={12}>پس از اولین چرخهٔ worker پر می‌شود.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="text-caption" style={{ marginTop: 10 }}>
            «تأیید زنده» تنها پس از پاسخ عمومی واقعی و اعتبارسنجی نرمال‌سازی داده می‌شود. منبعی که فقط
            قیمت سرصفحه دارد، جهت آن تأیید نشده، یا واحدش مبهم است هرگز «تأیید زنده» نمی‌گیرد.
          </p>
        </div>
      </section>

      {/* ===== Live source snapshot ===== */}
      <section className="panel shadow-section">
        <div className="panel-header">
          <h3 className="panel-title">آخرین snapshot منابع</h3>
        </div>
        <div className="panel-body table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>منبع</th>
                <th>مدل</th>
                <th>حساب</th>
                <th>سلامت</th>
                <th>خرید کاربر</th>
                <th>فروش کاربر</th>
                <th>عمق / حد اجرا</th>
                <th>سن داده</th>
                <th>پیام</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <tr key={s.sourceId}>
                  <td>
                    <strong>{s.sourceName}</strong>
                    <div className="text-micro">{s.sourceId}</div>
                  </td>
                  <td>{s.marketModel}</td>
                  <td>
                    <span className={`badge ${s.accountStatus === "verified" ? "muted" : "warn"}`}>
                      {ACCOUNT_FA[s.accountStatus] ?? s.accountStatus}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`badge ${s.health === "healthy" ? "good" : s.health === "degraded" ? "warn" : "danger"}`}
                    >
                      {HEALTH_FA[s.health] ?? s.health}
                    </span>
                    {s.stale ? <div className="text-micro">کهنه</div> : null}
                  </td>
                  <td className="number">
                    {s.userBuyPriceToman != null ? <TomanAmount value={s.userBuyPriceToman} /> : "—"}
                  </td>
                  <td className="number">
                    {s.userSellPriceToman != null ? <TomanAmount value={s.userSellPriceToman} /> : "—"}
                  </td>
                  <td className="number">
                    {s.meta?.depthAvailable === false ? (
                      <span className="text-micro">عمق تأییدنشده</span>
                    ) : s.maxExecutableUsdt != null ? (
                      `${formatNumber(s.maxExecutableUsdt, 1)} USDT`
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="number text-micro">{Math.round((s.ageMs ?? 0) / 1000)}s</td>
                  <td className="text-micro shadow-note-cell">
                    {s.errorReason ?? s.degradedReason ?? "—"}
                  </td>
                </tr>
              ))}
              {!sources.length && !loading ? (
                <tr>
                  <td colSpan={9}>
                    هنوز چرخه‌ای ثبت نشده — <code className="text-mono-tech">pnpm shadow:worker</code> را
                    اجرا کنید.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      {/* ===== Opportunities ===== */}
      <section className="panel shadow-section">
        <div className="panel-header">
          <h3 className="panel-title">فرصت‌ها (چرخهٔ عمر یکتا)</h3>
        </div>
        <div className="panel-body shadow-filters">
          <label>
            حجم
            <select
              value={filters.size}
              onChange={(e) => setFilters((f) => ({ ...f, size: e.target.value }))}
            >
              <option value="all">همه</option>
              {(matrix?.sizes ?? [5, 10, 20, 25]).map((s) => (
                <option key={s} value={String(s)}>
                  {s} USDT
                </option>
              ))}
            </select>
          </label>
          <label>
            منبع
            <select
              value={filters.source}
              onChange={(e) => setFilters((f) => ({ ...f, source: e.target.value }))}
            >
              <option value="all">همه</option>
              {sources.map((s) => (
                <option key={s.sourceId} value={s.sourceId}>
                  {s.sourceName}
                </option>
              ))}
            </select>
          </label>
          <label>
            وضعیت
            <select
              value={filters.eligibility}
              onChange={(e) => setFilters((f) => ({ ...f, eligibility: e.target.value }))}
            >
              <option value="all">همه</option>
              {Object.entries(ELIG_FA).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          <label className="shadow-check">
            <input
              type="checkbox"
              checked={filters.netPositiveOnly}
              onChange={(e) => setFilters((f) => ({ ...f, netPositiveOnly: e.target.checked }))}
            />
            فقط سود خالص مثبت (کارمزد معلوم)
          </label>
          <label className="shadow-check">
            <input
              type="checkbox"
              checked={filters.showEnded}
              onChange={(e) => setFilters((f) => ({ ...f, showEnded: e.target.checked }))}
            />
            شامل پایان‌یافته‌ها
          </label>
        </div>
        <div className="panel-body table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>خرید از</th>
                <th>فروش در</th>
                <th>حجم</th>
                <th>VWAP خرید</th>
                <th>VWAP فروش</th>
                <th>اسپرد خام٪</th>
                <th>کارمزدها</th>
                <th>بافر</th>
                <th>حاشیه خالص٪</th>
                <th>سود خالص</th>
                <th>وضعیت</th>
                <th>دلیل مسدودی</th>
                <th>مدت / مشاهده</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((o) => (
                <tr key={o.id}>
                  <td>{o.buySourceName}</td>
                  <td>{o.sellSourceName}</td>
                  <td className="number">{o.sizeUsdt}</td>
                  <td className="number">
                    <TomanAmount value={o.buyVwapToman} />
                  </td>
                  <td className="number">
                    <TomanAmount value={o.sellVwapToman} />
                  </td>
                  <td className="number shadow-raw-spread">{formatNumber(o.rawSpreadPercent, 3)}٪</td>
                  <td className="text-micro">
                    {o.feeUnknown ? (
                      <span className="badge warn">نامشخص</span>
                    ) : (
                      <>
                        B {o.buyFeeBps}bps / S {o.sellFeeBps}bps
                        <div>مجموع {formatNumber(o.totalFeePercent, 3)}٪</div>
                      </>
                    )}
                  </td>
                  <td className="text-micro number">
                    <TomanAmount value={o.slippageBufferToman} />
                    <div>بازتوازن {o.rebalanceCostToman}</div>
                  </td>
                  <td
                    className={`number ${!o.feeUnknown && o.netEdgePercent > 0 ? "shadow-net-pos" : "shadow-net-neg"}`}
                  >
                    {o.feeUnknown ? "—" : `${formatNumber(o.netEdgePercent, 3)}٪`}
                  </td>
                  <td
                    className={`number ${!o.feeUnknown && o.netProfitToman > 0 ? "shadow-net-pos" : "shadow-net-neg"}`}
                  >
                    {o.feeUnknown ? (
                      <span className="text-micro">پتانسیل خام</span>
                    ) : (
                      <TomanAmount value={o.netProfitToman} />
                    )}
                  </td>
                  <td>
                    <span className={`badge ${eligibilityTone(o.eligibility)}`}>
                      {ELIG_FA[o.eligibility] ?? o.eligibility}
                    </span>
                    {!o.isActive ? <div className="text-micro">پایان‌یافته</div> : null}
                  </td>
                  <td className="text-micro shadow-note-cell">{o.blockedReasons.join(", ") || "—"}</td>
                  <td className="text-micro number">
                    {o.durationMs > 0 ? `${Math.round(o.durationMs / 1000)}s` : "—"}
                    <div>×{o.observationCount ?? 1}</div>
                  </td>
                </tr>
              ))}
              {!opportunities.length && !loading ? (
                <tr>
                  <td colSpan={13}>فرصتی با فیلتر فعلی نیست.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <p className="text-caption" style={{ marginTop: 12 }}>
            اسپرد خام ≠ سود خالص. سود خالص فقط زمانی محاسبه می‌شود که کارمزد هر دو طرف معلوم باشد؛ در غیر
            این صورت نتیجه «پتانسیل خام» است. هیچ سفارشی ارسال نمی‌شود.
          </p>
        </div>
      </section>

      {/* ===== Cost assumptions ===== */}
      {obs?.costRecords?.length ? (
        <section className="panel shadow-section">
          <div className="panel-header">
            <h3 className="panel-title">فرض‌های هزینه (موقت)</h3>
          </div>
          <div className="panel-body table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>مورد</th>
                  <th>مقدار</th>
                  <th>وضعیت</th>
                  <th>تاریخ بازبینی</th>
                  <th>توضیح</th>
                </tr>
              </thead>
              <tbody>
                {obs.costRecords.map((c) => (
                  <tr key={c.key}>
                    <td>{c.label}</td>
                    <td className="number">
                      {c.unit === "bps_of_buy_cost"
                        ? `${formatNumber(c.value / 100, 3)}٪ از هزینهٔ خرید`
                        : `${formatNumber(c.value, 0)} تومان`}
                    </td>
                    <td>
                      <span className="badge warn">{FEE_FA[c.status] ?? c.status}</span>
                    </td>
                    <td className="text-micro">{c.verifiedAt ?? "—"}</td>
                    <td className="text-micro shadow-note-cell">{c.explanation}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ===== Analytics ===== */}
      <section className="panel shadow-section">
        <div className="panel-header">
          <h3 className="panel-title">تحلیل ۱۴ روزه (فقط دادهٔ جمع‌آوری‌شده)</h3>
        </div>
        <div className="panel-body">
          {analytics ? (
            <div className="shadow-analytics">
              <p className="text-caption">{analytics.dataNote}</p>
              <div className="metrics grid">
                <div className="metric">
                  <div className="metric-label">چرخهٔ عمر یکتا</div>
                  <div className="metric-value">{analytics.uniqueLifecycles}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">مسیر خالص مثبت</div>
                  <div className="metric-value">{analytics.uniqueNetPositiveAllTime}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">فقط پتانسیل خام</div>
                  <div className="metric-value">{analytics.uniqueRawPotentialOnly}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">چرخه‌های ثبت‌شده</div>
                  <div className="metric-value">{analytics.runCount}</div>
                  <div className="text-micro">
                    {analytics.successfulRuns}/{analytics.partialRuns}/{analytics.failedRuns}
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">پوشش داده</div>
                  <div className="metric-value">
                    {formatNumber(analytics.dataCoveragePercent, 1)}٪
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">snapshot ثبت‌شده</div>
                  <div className="metric-value">{analytics.snapshotCount}</div>
                </div>
                <div className="metric">
                  <div className="metric-label">حداکثر حاشیه خالص٪</div>
                  <div className="metric-value">
                    {analytics.maxNetEdgePercent != null
                      ? `${formatNumber(analytics.maxNetEdgePercent, 3)}٪`
                      : "—"}
                  </div>
                </div>
                <div className="metric">
                  <div className="metric-label">میانه مدت (ثانیه)</div>
                  <div className="metric-value">
                    {analytics.medianDurationMs != null
                      ? Math.round(analytics.medianDurationMs / 1000)
                      : "—"}
                  </div>
                </div>
              </div>

              <h4 className="text-section" style={{ marginTop: 16 }}>
                رتبه‌بندی مسیرها بر پایهٔ شواهد مشاهده‌شده
              </h4>
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>مسیر</th>
                      <th>حجم</th>
                      <th>نمونه</th>
                      <th>چرخهٔ عمر</th>
                      <th>حداکثر اسپرد خام٪</th>
                      <th>میانگین اسپرد خام٪</th>
                      <th>حداکثر حاشیه خالص٪</th>
                      <th>مبنای رتبه</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.routes.slice(0, 20).map((r) => (
                      <tr key={r.routeKey}>
                        <td className="text-micro">{r.routeKey}</td>
                        <td className="number">{r.sizeUsdt}</td>
                        <td className="number">{r.samples}</td>
                        <td className="number">{r.count}</td>
                        <td className="number">
                          {r.maxRawSpread != null ? `${formatNumber(r.maxRawSpread, 3)}٪` : "—"}
                        </td>
                        <td className="number">
                          {r.avgRawSpread != null ? `${formatNumber(r.avgRawSpread, 3)}٪` : "—"}
                        </td>
                        <td className="number">
                          {r.feeUnknown || r.maxEdge == null ? "—" : `${formatNumber(r.maxEdge, 3)}٪`}
                        </td>
                        <td>
                          <span className={`badge ${r.rankingBasis === "net" ? "muted" : "warn"}`}>
                            {r.rankingBasis === "net" ? "سود خالص" : "پتانسیل خام"}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {!analytics.routes.length ? (
                      <tr>
                        <td colSpan={8}>هنوز مسیری ثبت نشده.</td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>

              <h4 className="text-section" style={{ marginTop: 16 }}>
                کارایی منابع
              </h4>
              <div className="table-wrap">
                <table className="admin-table">
                  <thead>
                    <tr>
                      <th>منبع</th>
                      <th>گواهی</th>
                      <th>نمونه</th>
                      <th>Uptime</th>
                      <th>نرخ خطا</th>
                      <th>p50</th>
                      <th>p95</th>
                      <th>تازگی</th>
                      <th>آخرین خطا</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analytics.sourceUptime.map((s) => (
                      <tr key={s.sourceId}>
                        <td>{s.sourceName}</td>
                        <td>
                          <span className={`badge ${certTone(s.certStatus)}`}>
                            {CERT_FA[s.certStatus] ?? s.certStatus}
                          </span>
                        </td>
                        <td className="number">{s.samples}</td>
                        <td className="number">{formatNumber(s.uptimePercent, 1)}٪</td>
                        <td className="number">{formatNumber(s.errorRatePercent, 1)}٪</td>
                        <td className="number">{s.latencyP50Ms ?? "—"}</td>
                        <td className="number">{s.latencyP95Ms ?? "—"}</td>
                        <td className="number">{formatNumber(s.freshnessPercent, 1)}٪</td>
                        <td className="text-micro shadow-note-cell">{s.lastError ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <h4 className="text-section" style={{ marginTop: 16 }}>
                فرصت‌های مسدودشده بر اساس دلیل (آخرین چرخه)
              </h4>
              <ul className="text-body shadow-blocked-list">
                {analytics.blockedByReason.slice(0, 12).map((b) => (
                  <li key={b.reason}>
                    {b.label}: <strong>{b.count}</strong>
                  </li>
                ))}
                {!analytics.blockedByReason.length ? <li>—</li> : null}
              </ul>

              {Object.keys(analytics.estimatedNetPnlBySize).length ? (
                <>
                  <h4 className="text-section" style={{ marginTop: 16 }}>
                    سود خالص تخمینی تجمعی (فقط کارمزد معلوم، یک‌بار به ازای هر چرخهٔ عمر)
                  </h4>
                  <ul className="text-body">
                    {Object.entries(analytics.estimatedNetPnlBySize).map(([size, pnl]) => (
                      <li key={size}>
                        {size} USDT: <TomanAmount value={pnl} />
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
          ) : (
            <p className="text-caption">پس از چند چرخهٔ worker، آمار تاریخی پر می‌شود.</p>
          )}
        </div>
      </section>
    </div>
  );
}
