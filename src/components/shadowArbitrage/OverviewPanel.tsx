"use client";

import { useEffect, useMemo, useState } from "react";
import { formatTehran } from "@/components/format";
import {
  COLLECTOR_STATE_FA,
  classifyOpportunity,
  collectorTone,
  deriveCollectorState,
  formatCountFa,
  formatDurationFa,
  formatPercentFa,
  toFaDigits,
  NO_VALID_OPPORTUNITY_FA,
  TOOLTIP_FA
} from "@/components/shadowArbitrage/labels";
import type {
  Observation,
  RunStats,
  ShadowAnalytics,
  ShadowOpportunity,
  WorkerState
} from "@/components/shadowArbitrage/types";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import type { ShadowTabId } from "@/components/shadowArbitrage/tabs";

type PaperSummary = {
  present: boolean;
  status: string;
  mode: string | null;
  filled: number;
  skipped: number;
  economicNetPnlToman: number;
} | null;

type ReadinessSummary = {
  passed: number;
  total: number;
  effectiveState: string;
  topBlockerFa: string | null;
} | null;

type AccountSummary = { executable: number; total: number; blockedFa: string | null } | null;

type Props = {
  loading: boolean;
  error: string | null;
  stale: boolean;
  observation: Observation | null;
  worker: WorkerState | null;
  runStats: RunStats | null;
  analytics: ShadowAnalytics | null;
  opportunities: ShadowOpportunity[];
  sources: NormalizedSourceSnapshot[];
  serverNow: string | null;
  paper: PaperSummary;
  readiness: ReadinessSummary;
  accounts: AccountSummary;
  onRefresh: () => void;
  onOpenTab: (id: ShadowTabId) => void;
};

function toman(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${toFaDigits(Math.round(value).toLocaleString("en-US"))} تومان`;
}

/**
 * A "part of whole" figure.
 *
 * Rendered inside its own bidi isolate: without it, an RTL paragraph reorders
 * "۳ / ۹" into "۹ / ۳", which silently reverses the meaning of every ratio on
 * the page.
 */
function Ratio({ part, whole }: { part: number; whole: number }) {
  return (
    <span className="sa-ratio" dir="ltr">
      {toFaDigits(part)}
      <span className="sa-ratio-sep">/</span>
      <span className="sa-ratio-whole">{toFaDigits(whole)}</span>
    </span>
  );
}

/** A metric that has no honest value yet renders as an em dash, never as zero. */
function Metric({
  label,
  value,
  hint,
  tone,
  title
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  tone?: "good" | "warn" | "danger" | "muted";
  title?: string;
}) {
  return (
    <div className={`sa-ov-card${tone ? ` sa-ov-card-${tone}` : ""}`} title={title}>
      <div className="sa-ov-card-label">{label}</div>
      <div className="sa-ov-card-value">{value}</div>
      {hint ? <div className="sa-ov-card-hint">{hint}</div> : null}
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="sa-ov-card sa-ov-card-skeleton" aria-hidden="true">
      <div className="sa-skeleton-line" style={{ width: "44%" }} />
      <div className="sa-skeleton-line" style={{ width: "68%", height: 20, marginTop: 10 }} />
      <div className="sa-skeleton-line" style={{ width: "56%", marginTop: 8 }} />
    </div>
  );
}

/**
 * Phase 8A overview.
 *
 * It answers, in order: is this Shadow-only, is the collector healthy, is paper
 * running, when did a cycle last succeed, and how far through the 14 days are
 * we. Then four primary cards, then restrained secondary summaries.
 *
 * Every figure comes from data the server already returned. Nothing is invented
 * to fill a card: a value that is not known yet shows an em dash and says why.
 */
export function OverviewPanel({
  loading,
  error,
  stale,
  observation,
  worker,
  runStats,
  analytics,
  opportunities,
  sources,
  serverNow,
  paper,
  readiness,
  accounts,
  onRefresh,
  onOpenTab
}: Props) {
  // Ages are computed on the client, so they must not run during SSR.
  const [nowMs, setNowMs] = useState<number | null>(null);
  useEffect(() => {
    setNowMs(Date.now());
    const id = window.setInterval(() => setNowMs(Date.now()), 15_000);
    return () => window.clearInterval(id);
  }, []);

  const pollIntervalMs = worker?.pollIntervalMs ?? observation?.pollIntervalMs ?? 30_000;

  const lastSuccessAgeMs =
    nowMs && observation?.lastSuccessAt ? nowMs - Date.parse(observation.lastSuccessAt) : null;

  const collectorState = deriveCollectorState({
    observationStatus: observation?.status,
    workerStale: worker?.stale,
    workerRunning: worker?.leaseHeld,
    lastSuccessAgeMs,
    pollIntervalMs
  });

  const classified = useMemo(
    () =>
      opportunities.map((o) => ({
        opportunity: o,
        kind: classifyOpportunity({
          eligibility: o.eligibility,
          feeUnknown: o.feeUnknown,
          netProfitToman: o.netProfitToman,
          rawSpreadPercent: o.rawSpreadPercent
        })
      })),
    [opportunities]
  );

  const valid = useMemo(
    () =>
      classified
        .filter((c) => c.kind === "valid" && c.opportunity.isActive)
        .map((c) => c.opportunity)
        .sort((a, b) => b.netProfitToman - a.netProfitToman),
    [classified]
  );

  const best = valid[0] ?? null;

  const healthySources = sources.filter((s) => s.health === "healthy").length;
  const degradedSources = sources.filter((s) => s.health === "degraded").length;
  const downSources = sources.filter((s) => s.health === "unavailable").length;

  const coverage = observation?.successCoveragePercent ?? null;
  const progress = observation?.progressPercent ?? null;

  const hasAnyData = Boolean(observation || worker || sources.length);

  return (
    <div className="sa-ov">
      {/* ── status strip ─────────────────────────────────────────────── */}
      <section className="panel sa-panel sa-ov-status">
        <div className="sa-ov-status-row">
          <div className="sa-ov-status-item">
            <span className="sa-ov-status-label">حالت</span>
            <span className="sa-chip sa-chip-sm sa-chip-warn" title={TOOLTIP_FA.coverage}>
              فقط پایش آزمایشی
            </span>
          </div>

          <div className="sa-ov-status-item">
            <span className="sa-ov-status-label">جمع‌آورنده</span>
            <span className={`sa-chip sa-chip-sm sa-chip-${collectorTone(collectorState)}`}>
              {COLLECTOR_STATE_FA[collectorState]}
            </span>
          </div>

          <div className="sa-ov-status-item">
            <span className="sa-ov-status-label">اجرای کاغذی</span>
            {paper?.present ? (
              <span
                className={`sa-chip sa-chip-sm sa-chip-${
                  paper.status === "RUNNING" ? "good" : paper.status === "PAUSED" ? "warn" : "muted"
                }`}
              >
                {paper.status === "RUNNING"
                  ? "در حال اجرا"
                  : paper.status === "PAUSED"
                    ? "متوقف"
                    : paper.status === "STOPPED"
                      ? "پایان‌یافته"
                      : "شروع‌نشده"}
              </span>
            ) : (
              <span className="sa-chip sa-chip-sm sa-chip-muted">نشستی وجود ندارد</span>
            )}
          </div>

          <div className="sa-ov-status-item">
            <span className="sa-ov-status-label">آخرین چرخهٔ موفق</span>
            <span className="sa-ov-status-value" title={observation?.lastSuccessAt ?? undefined}>
              {observation?.lastSuccessAt ? (
                <>
                  {formatTehran(observation.lastSuccessAt)}
                  {lastSuccessAgeMs !== null ? (
                    <span className="sa-ov-status-sub"> ({formatDurationFa(lastSuccessAgeMs)} پیش)</span>
                  ) : null}
                </>
              ) : (
                "—"
              )}
            </span>
          </div>

          <div className="sa-ov-status-actions">
            <button
              type="button"
              className="sa-btn sa-btn-ghost"
              onClick={onRefresh}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
            </button>
          </div>
        </div>

        {/* 14-day progress lives in the header, where the question is asked. */}
        <div className="sa-ov-progress">
          <div className="sa-ov-progress-head">
            <span>پیشرفت دورهٔ ۱۴ روزه</span>
            <span className="sa-ov-progress-value">
              {progress === null ? "—" : formatPercentFa(progress, 1)}
              {observation ? (
                <span className="sa-ov-status-sub">
                  {" "}
                  · باقی‌مانده {formatDurationFa(observation.remainingMs)}
                </span>
              ) : null}
            </span>
          </div>
          <div className="sa-progress" role="presentation">
            <div
              className="sa-progress-fill"
              style={{ width: `${Math.max(0, Math.min(100, progress ?? 0))}%` }}
            />
          </div>
        </div>
      </section>

      {error ? (
        <div className="sa-callout sa-callout-danger" role="alert">
          {error}
        </div>
      ) : null}

      {stale && !error ? (
        <div className="sa-callout sa-callout-warn">
          دادهٔ نمایش‌داده‌شده از آخرین چرخهٔ جمع‌آوری قدیمی‌تر از حد انتظار است؛ اگر جمع‌آورنده
          متوقف شده باشد، ارقام زیر به‌روز نیستند.
        </div>
      ) : null}

      {/* ── four primary cards ───────────────────────────────────────── */}
      <div className="sa-ov-grid">
        {loading && !hasAnyData ? (
          <>
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </>
        ) : (
          <>
            <Metric
              label="بهترین فرصت معتبر"
              tone={best ? "good" : "muted"}
              title={TOOLTIP_FA.netEdge}
              value={best ? toman(best.netProfitToman) : "—"}
              hint={
                best ? (
                  <>
                    {best.buySourceName} ← {best.sellSourceName} · {toFaDigits(best.sizeUsdt)} تتر ·
                    حاشیهٔ خالص {formatPercentFa(best.netEdgePercent)}
                  </>
                ) : (
                  NO_VALID_OPPORTUNITY_FA
                )
              }
            />

            <Metric
              label="فرصت‌های معتبر مثبت"
              tone={valid.length ? "good" : "muted"}
              value={formatCountFa(valid.length)}
              hint={
                <>
                  از {formatCountFa(classified.length)} فرصت مشاهده‌شده ·{" "}
                  <button type="button" className="sa-linkish" onClick={() => onOpenTab("opportunities")}>
                    مشاهدهٔ فهرست
                  </button>
                </>
              }
            />

            <Metric
              label="سلامت منابع و جمع‌آورنده"
              tone={downSources > 0 ? "danger" : degradedSources > 0 ? "warn" : "good"}
              value={
                sources.length ? <Ratio part={healthySources} whole={sources.length} /> : "—"
              }
              hint={
                sources.length ? (
                  <>
                    منبع سالم · {toFaDigits(degradedSources)} کم‌کیفیت · {toFaDigits(downSources)} خارج
                    از دسترس · جمع‌آورنده: {COLLECTOR_STATE_FA[collectorState]}
                  </>
                ) : (
                  "هنوز دادهٔ منبعی دریافت نشده است"
                )
              }
            />

            <Metric
              label="پیشرفت و پوشش مشاهده"
              tone={coverage === null ? "muted" : coverage >= 80 ? "good" : "warn"}
              title={TOOLTIP_FA.coverage}
              value={coverage === null ? "—" : formatPercentFa(coverage, 1)}
              hint={
                observation ? (
                  <>
                    پوشش موفق · {formatCountFa(observation.successfulCycles)} چرخهٔ موفق از{" "}
                    {formatCountFa(observation.expectedCycles)} مورد انتظار
                    {runStats ? (
                      <> · {formatCountFa(runStats.duplicateIdempotencyKeys)} چرخهٔ تکراری</>
                    ) : null}
                  </>
                ) : (
                  "نشست مشاهده‌ای ثبت نشده است"
                )
              }
            />
          </>
        )}
      </div>

      {/* ── secondary summaries ──────────────────────────────────────── */}
      <div className="sa-ov-secondary">
        <section className="panel sa-panel sa-ov-mini">
          <div className="sa-ov-mini-head">
            <h3 className="sa-ov-mini-title">ارزیابی کاغذی</h3>
            <button type="button" className="sa-linkish" onClick={() => onOpenTab("paper")}>
              جزئیات
            </button>
          </div>
          {paper?.present ? (
            <dl className="sa-ov-mini-list">
              <div>
                <dt>معاملات اجراشده</dt>
                <dd>{formatCountFa(paper.filled)}</dd>
              </div>
              <div>
                <dt>نامزدهای ردشده</dt>
                <dd>{formatCountFa(paper.skipped)}</dd>
              </div>
              <div>
                <dt>سود خالص اقتصادی</dt>
                <dd className={paper.economicNetPnlToman >= 0 ? "sa-pos" : "sa-neg"}>
                  {toman(paper.economicNetPnlToman)}
                </dd>
              </div>
            </dl>
          ) : (
            <p className="sa-ov-mini-empty">
              نشست کاغذی فعالی وجود ندارد. استقرار به‌تنهایی هیچ نشستی را شروع نمی‌کند.
            </p>
          )}
        </section>

        <section className="panel sa-panel sa-ov-mini">
          <div className="sa-ov-mini-head">
            <h3 className="sa-ov-mini-title">آمادگی حساب و کارمزد</h3>
            <button type="button" className="sa-linkish" onClick={() => onOpenTab("sources")}>
              جزئیات
            </button>
          </div>
          {accounts ? (
            <dl className="sa-ov-mini-list">
              <div>
                <dt>صرافی اجراپذیر</dt>
                <dd>
                  <Ratio part={accounts.executable} whole={accounts.total} />
                </dd>
              </div>
              {accounts.blockedFa ? (
                <div className="sa-ov-mini-wide">
                  <dt>مانع اصلی</dt>
                  <dd className="sa-reason">{accounts.blockedFa}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="sa-ov-mini-empty">دادهٔ آمادگی حساب هنوز بارگذاری نشده است.</p>
          )}
        </section>

        <section className="panel sa-panel sa-ov-mini">
          <div className="sa-ov-mini-head">
            <h3 className="sa-ov-mini-title">آمادگی اجرای واقعی</h3>
            <button type="button" className="sa-linkish" onClick={() => onOpenTab("live")}>
              جزئیات
            </button>
          </div>
          <div className="sa-ov-disarmed" role="status">
            <span className="sa-chip sa-chip-sm sa-chip-danger">غیرمسلح</span>
            <span>اجرای واقعی پیاده‌سازی نشده است — هیچ سفارش واقعی ثبت نمی‌شود.</span>
          </div>
          {readiness ? (
            <dl className="sa-ov-mini-list">
              <div>
                <dt>دروازه‌های برقرار</dt>
                <dd>
                  <Ratio part={readiness.passed} whole={readiness.total} />
                </dd>
              </div>
              {readiness.topBlockerFa ? (
                <div className="sa-ov-mini-wide">
                  <dt>نخستین مانع</dt>
                  <dd className="sa-reason">{readiness.topBlockerFa}</dd>
                </div>
              ) : null}
            </dl>
          ) : (
            <p className="sa-ov-mini-empty">وضعیت دروازه‌ها هنوز بارگذاری نشده است.</p>
          )}
        </section>
      </div>

      {!loading && !hasAnyData && !error ? (
        <div className="sa-empty">
          هنوز هیچ داده‌ای برای نمایش وجود ندارد. پس از نخستین چرخهٔ موفق جمع‌آوری، ارقام این صفحه
          پر می‌شوند.
        </div>
      ) : null}

      <p className="sa-ov-foot">
        {serverNow ? <>زمان سرور: {formatTehran(serverNow)}</> : null}
        {analytics?.dataNote ? <span className="sa-ov-foot-note"> · {analytics.dataNote}</span> : null}
      </p>
    </div>
  );
}
