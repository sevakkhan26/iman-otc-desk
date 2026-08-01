"use client";

import { useEffect, useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { formatTehran } from "@/components/format";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
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
import { evidenceFor, type PaperEvidence } from "@/components/shadowArbitrage/opportunityModel";
import {
  summarisePortfolio,
  type VenueAllocation
} from "@/lib/shadowArbitrage/paper/portfolio";
import type {
  Observation,
  ShadowOpportunity,
  WorkerState
} from "@/components/shadowArbitrage/types";
import type { NormalizedSourceSnapshot } from "@/lib/shadowArbitrage/types";
import type { ShadowTabId } from "@/components/shadowArbitrage/tabs";

/* ── the slice of the paper payload this section reads ────────────────────── */

export type CommandSession = {
  id: string;
  name: string;
  status: string;
  mode: string;
  totalCapitalToman: number;
  valuationPriceToman: number;
  openingAllocations: VenueAllocation[];
};

export type CommandBalance = { sourceId: string; irtToman: number; usdt: number };

export type CommandPortfolio = {
  session: CommandSession | null;
  balances: CommandBalance[];
  fills: Array<{
    economicNetPnlToman: number | null;
    riskAdjustedPnlToman: number | null;
    occurredAt: string;
  }>;
  rejected: number;
  markPriceToman: number | null;
};

type Props = {
  loading: boolean;
  error: string | null;
  stale: boolean;
  observation: Observation | null;
  worker: WorkerState | null;
  opportunities: ShadowOpportunity[];
  paperEvidence: Map<string, PaperEvidence>;
  sources: NormalizedSourceSnapshot[];
  portfolio: CommandPortfolio | null;
  accounts: { executable: number; total: number } | null;
  readiness: { passed: number; total: number; topBlockerFa: string | null } | null;
  serverNow: string | null;
  onRefresh: () => void;
  onOpenSection: (id: ShadowTabId) => void;
  /** Session create / start / pause / stop, supplied by the page. */
  sessionControls?: React.ReactNode;
  /** Everything technical, folded away behind one disclosure. */
  advanced?: React.ReactNode;
};

/**
 * A "part of whole" figure inside its own bidi isolate.
 *
 * Without it an RTL paragraph reorders "۳ / ۹" into "۹ / ۳", which silently
 * reverses the meaning of every ratio on the page.
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

/** One headline number. A value that is not known yet is an em dash, never a zero. */
function Kpi({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: React.ReactNode;
  hint: React.ReactNode;
  tone: "good" | "warn" | "danger" | "muted";
}) {
  // .panel is the shared Liquid Glass card material used across the desk.
  return (
    <section className={`panel sa-panel sa-cc-kpi sa-rail-${tone}`}>
      <div className="panel-body sa-cc-kpi-body">
        <div className="sa-cc-kpi-label">{label}</div>
        <div className="sa-cc-kpi-value">{value}</div>
        <div className="sa-cc-kpi-hint">{hint}</div>
      </div>
    </section>
  );
}

const DASH = <span className="sa-unknown">—</span>;

function tone(value: number): "good" | "warn" | "muted" {
  return value > 0 ? "good" : value < 0 ? "warn" : "muted";
}

/**
 * Phase 8C-2 — the Command Center.
 *
 * One screen that answers the operator's standing questions without opening a
 * drawer: how much virtual money exists, how much of it is deployed, how much
 * is free, what today and the session as a whole earned, how bad the worst
 * give-back was, how many trades were taken and refused, and which route is the
 * best one right now with its size, the capital it would tie up and its net
 * result after fees and the slippage buffer.
 *
 * Every figure comes from data the server already returned. Nothing is invented
 * to fill a card: an unknown value shows an em dash and says why. The suggested
 * size is still the fixed diagnostic probe the engine uses today — this section
 * labels it as such rather than implying a sizing engine that does not exist yet.
 */
export function CommandCenter({
  loading,
  error,
  stale,
  observation,
  worker,
  opportunities,
  paperEvidence,
  sources,
  portfolio,
  accounts,
  readiness,
  serverNow,
  onRefresh,
  onOpenSection,
  sessionControls,
  advanced
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

  const session = portfolio?.session ?? null;
  const markPrice = portfolio?.markPriceToman ?? session?.valuationPriceToman ?? null;

  /* ── portfolio ─────────────────────────────────────────────────────────── */

  const summary = useMemo(() => {
    if (!session || !portfolio) return null;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    return summarisePortfolio({
      initialCapitalToman: session.totalCapitalToman,
      balances: portfolio.balances.map((b) => ({
        sourceId: b.sourceId as never,
        irtToman: b.irtToman,
        usdtMicros: Math.round(b.usdt * 1_000_000)
      })),
      markPriceToman: markPrice,
      fills: portfolio.fills,
      rejectedCount: portfolio.rejected,
      todayStartMs: todayStart.getTime()
    });
  }, [session, portfolio, markPrice]);

  /*
   * Free cash is the toman actually available to fund a buy, not "total minus
   * allocated" — allocation is exact by construction, so that figure would
   * always be zero and would tell an operator nothing. Deployed is the same
   * balances valued at today's mark, which is why it moves with the market.
   */
  const freeTomanCash = useMemo(
    () => (portfolio?.balances ?? []).reduce((s, b) => s + b.irtToman, 0),
    [portfolio]
  );
  const usdtInventory = useMemo(
    () => (portfolio?.balances ?? []).reduce((s, b) => s + b.usdt, 0),
    [portfolio]
  );

  /* ── best opportunity ──────────────────────────────────────────────────── */

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
  const bestEvidence = best ? (evidenceFor(best, paperEvidence) ?? null) : null;

  const healthySources = sources.filter((s) => s.health === "healthy").length;
  const progress = observation?.progressPercent ?? null;
  const coverage = observation?.successCoveragePercent ?? null;

  return (
    <div className="sa-cc">
      {/* ── status strip ─────────────────────────────────────────────── */}
      <section className="panel sa-panel sa-cc-status" aria-label="وضعیت لحظه‌ای">
        <div className="sa-cc-status-row">
          <div className="sa-cc-status-group">
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">حالت</span>
              <span className="sa-chip sa-chip-sm sa-chip-warn" title={TOOLTIP_FA.coverage}>
                فقط پایش آزمایشی
              </span>
            </div>
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">جمع‌آورنده</span>
              <span className={`sa-chip sa-chip-sm sa-chip-${collectorTone(collectorState)}`}>
                {COLLECTOR_STATE_FA[collectorState]}
              </span>
            </div>
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">نشست کاغذی</span>
              <span
                className={`sa-chip sa-chip-sm sa-chip-${
                  session?.status === "RUNNING"
                    ? "good"
                    : session?.status === "PAUSED"
                      ? "warn"
                      : "muted"
                }`}
              >
                {session
                  ? session.status === "RUNNING"
                    ? "در حال اجرا"
                    : session.status === "PAUSED"
                      ? "متوقف موقت"
                      : session.status === "STOPPED"
                        ? "پایان‌یافته"
                        : "شروع‌نشده"
                  : "نشستی وجود ندارد"}
              </span>
            </div>
            {/* Real execution is stated on the landing screen, always. */}
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">اجرای واقعی</span>
              <span className="sa-chip sa-chip-sm sa-chip-danger">غیرمسلح</span>
            </div>
          </div>

          <div className="sa-cc-status-tail">
            <div className="sa-cc-status-item">
              <span className="sa-cc-status-label">آخرین چرخهٔ موفق</span>
              <span className="sa-cc-status-value" title={observation?.lastSuccessAt ?? undefined}>
                {observation?.lastSuccessAt ? (
                  <>
                    {formatTehran(observation.lastSuccessAt)}
                    {lastSuccessAgeMs !== null ? (
                      <span className="sa-cc-status-sub">
                        {" "}
                        ({formatDurationFa(lastSuccessAgeMs)} پیش)
                      </span>
                    ) : null}
                  </>
                ) : (
                  "—"
                )}
              </span>
            </div>
            <button
              type="button"
              className="sa-cc-action glass-control"
              onClick={onRefresh}
              disabled={loading}
              aria-busy={loading}
            >
              {loading ? "در حال به‌روزرسانی…" : "به‌روزرسانی"}
            </button>
          </div>
        </div>

        <div className="sa-cc-progress">
          <div className="sa-cc-progress-head">
            <span>پیشرفت دورهٔ ۱۴ روزه</span>
            <span className="sa-cc-progress-value">
              {progress === null ? "—" : formatPercentFa(progress, 1)}
              {observation ? (
                <span className="sa-cc-status-sub">
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

      {/* ── session controls ─────────────────────────────────────────── */}
      {sessionControls}

      {/* ── the eight standing numbers ───────────────────────────────── */}
      <div className="sa-cc-kpis">
        <Kpi
          label="سرمایهٔ کل مجازی"
          tone="muted"
          value={session ? <TomanAmount value={session.totalCapitalToman} /> : DASH}
          hint={
            session
              ? "کل پرتفوی مجازی این نشست — اندازهٔ یک معامله نیست"
              : "نشستی وجود ندارد؛ ابتدا یک نشست کاغذی بسازید"
          }
        />
        <Kpi
          label="سرمایهٔ تخصیص‌یافته"
          tone="muted"
          value={
            summary?.markedValueToman === null || summary === null ? (
              DASH
            ) : (
              <TomanAmount value={summary.markedValueToman} />
            )
          }
          hint={
            summary?.markedValueToman === null
              ? "بدون قیمت مبنا محاسبه نمی‌شود"
              : `ارزش امروزِ موجودی روی ${toFaDigits((portfolio?.balances ?? []).length)} صرافی`
          }
        />
        <Kpi
          label="سرمایهٔ آزاد"
          tone="muted"
          value={session ? <TomanAmount value={freeTomanCash} /> : DASH}
          hint={
            session
              ? `نقد تومانی قابل استفاده برای خرید · موجودی تتری: ${toFaDigits(usdtInventory.toFixed(2))} تتر`
              : "—"
          }
        />
        <Kpi
          label="سود و زیان امروز"
          tone={summary ? tone(summary.todayPnlToman) : "muted"}
          value={summary ? <TomanAmount value={summary.todayPnlToman} /> : DASH}
          hint={
            summary
              ? `از نیمه‌شب تهران تا این لحظه · ${formatCountFa(
                  portfolio?.fills.filter((f) => {
                    const t = new Date();
                    t.setHours(0, 0, 0, 0);
                    return Date.parse(f.occurredAt) >= t.getTime();
                  }).length ?? 0
                )} معاملهٔ امروز`
              : "بدون نشست فعال محاسبه نمی‌شود"
          }
        />
        <Kpi
          label="سود و زیان کل"
          tone={summary ? tone(summary.economicPnlToman) : "muted"}
          value={summary ? <TomanAmount value={summary.economicPnlToman} /> : DASH}
          hint={
            summary ? (
              <>
                تعدیل‌شده با بافر: <TomanAmount value={summary.riskAdjustedPnlToman} />
                {summary.roiPercent === null ? null : (
                  <> · بازده {formatPercentFa(summary.roiPercent, 2, true)}</>
                )}
              </>
            ) : (
              "بدون نشست فعال محاسبه نمی‌شود"
            )
          }
        />
        <Kpi
          label="بیشترین افت"
          tone={summary && summary.drawdownToman > 0 ? "warn" : "muted"}
          value={summary ? <TomanAmount value={summary.drawdownToman} /> : DASH}
          hint={
            summary
              ? `بیشترین بازپس‌دهی از اوج سود تحقق‌یافته${
                  summary.drawdownPercent === null
                    ? ""
                    : ` · ${formatPercentFa(summary.drawdownPercent, 2)} سرمایه`
                }`
              : "بدون نشست فعال محاسبه نمی‌شود"
          }
        />
        <Kpi
          label="معاملات انجام‌شده و رد‌شده"
          tone="muted"
          value={summary ? <Ratio part={summary.filled} whole={summary.filled + summary.rejected} /> : DASH}
          hint={
            summary
              ? `رد‌شده: ${formatCountFa(summary.rejected)} · آخرین معامله: ${
                  summary.lastTradeAt ? formatTehran(summary.lastTradeAt) : "—"
                }`
              : "بدون نشست فعال محاسبه نمی‌شود"
          }
        />
        <Kpi
          label="فرصت‌های معتبر"
          tone={valid.length ? "good" : "muted"}
          value={formatCountFa(valid.length)}
          hint={
            <>
              از {formatCountFa(classified.length)} فرصت مشاهده‌شده ·{" "}
              <button type="button" className="sa-linkish" onClick={() => onOpenSection("trades")}>
                مشاهدهٔ فهرست
              </button>
            </>
          }
        />
      </div>

      {/* ── best opportunity, fully disclosed ────────────────────────── */}
      <section className="panel sa-panel sa-cc-best" aria-label="بهترین فرصت فعلی">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">بهترین فرصت فعلی</h3>
          <div className="sa-panel-note">
            {best ? "معتبر و خالص مثبت پس از کارمزد و بافر لغزش" : NO_VALID_OPPORTUNITY_FA}
          </div>
        </div>
        <div className="panel-body">
          {best ? (
            <>
              <dl className="sa-cc-best-grid">
                <div>
                  <dt>صرافی خرید</dt>
                  <dd>{best.buySourceName}</dd>
                </div>
                <div>
                  <dt>صرافی فروش</dt>
                  <dd>{best.sellSourceName}</dd>
                </div>
                <div>
                  <dt>حجم پیشنهادی</dt>
                  <dd>
                    <Bidi>{toFaDigits(best.sizeUsdt)}</Bidi> تتر
                  </dd>
                </div>
                <div>
                  <dt>سرمایهٔ درگیر</dt>
                  <dd>
                    <TomanAmount value={best.buyCostToman} />
                  </dd>
                </div>
                <div>
                  <dt>سود خالص تعدیل‌شده</dt>
                  <dd className={best.netProfitToman >= 0 ? "sa-pos" : "sa-neg"}>
                    <TomanAmount value={best.netProfitToman} />
                  </dd>
                </div>
                <div>
                  <dt>حاشیهٔ خالص</dt>
                  <dd>
                    <Bidi>{formatPercentFa(best.netEdgePercent)}</Bidi>
                  </dd>
                </div>
              </dl>
              <p className="sa-sub">
                پس از کارمزد خرید <TomanAmount value={best.buyFeeToman} />، کارمزد فروش{" "}
                <TomanAmount value={best.sellFeeToman} /> و بافر لغزش{" "}
                <TomanAmount value={best.slippageBufferToman} /> محاسبه شده است.
                {bestEvidence?.riskAdjustedPnlToman !== null &&
                bestEvidence?.riskAdjustedPnlToman !== undefined ? (
                  <>
                    {" "}
                    سود ثبت‌شده در اجرای کاغذی برای همین مسیر و همین حجم:{" "}
                    <TomanAmount value={bestEvidence.riskAdjustedPnlToman} />.
                  </>
                ) : null}
              </p>
              <p className="sa-sub">
                حجم پیشنهادی فعلاً از پروب‌های تشخیصی ثابت موتور می‌آید و هنوز با عمق دفتر، موجودی
                مجازی صرافی و حدود ریسک محاسبه نمی‌شود؛ اندازه‌گیری پویا در مرحلهٔ بعد پیاده می‌شود.
              </p>
            </>
          ) : (
            <p className="sa-cc-empty">
              {NO_VALID_OPPORTUNITY_FA}. تا زمانی که مسیری پس از کارمزد و بافر لغزش خالص مثبت نشود،
              اینجا عددی ساخته نمی‌شود.
            </p>
          )}
        </div>
      </section>

      {/* ── health and safety, one line each ─────────────────────────── */}
      <div className="sa-cc-health">
        <section className="panel sa-panel sa-cc-mini">
          <h3 className="sa-cc-mini-title">سلامت منابع</h3>
          <dl className="sa-cc-mini-list">
            <div>
              <dt>منبع سالم</dt>
              <dd>{sources.length ? <Ratio part={healthySources} whole={sources.length} /> : DASH}</dd>
            </div>
            <div>
              <dt>پوشش موفق</dt>
              <dd>{coverage === null ? DASH : formatPercentFa(coverage, 1)}</dd>
            </div>
          </dl>
        </section>

        <section className="panel sa-panel sa-cc-mini">
          <h3 className="sa-cc-mini-title">آمادگی حساب و کارمزد</h3>
          <dl className="sa-cc-mini-list">
            <div>
              <dt>صرافی اجراپذیر</dt>
              <dd>
                {accounts ? <Ratio part={accounts.executable} whole={accounts.total} /> : DASH}
              </dd>
            </div>
            <div>
              <dt>جزئیات</dt>
              <dd>
                <button
                  type="button"
                  className="sa-linkish"
                  onClick={() => onOpenSection("settings")}
                >
                  تنظیمات و ایمنی
                </button>
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel sa-panel sa-cc-mini">
          <h3 className="sa-cc-mini-title">مرز اجرای واقعی</h3>
          <div className="sa-cc-disarmed" role="status">
            <span className="sa-chip sa-chip-sm sa-chip-danger">غیرمسلح</span>
            <span>اجرای واقعی پیاده‌سازی نشده است — هیچ سفارش واقعی ثبت نمی‌شود.</span>
          </div>
          <dl className="sa-cc-mini-list">
            <div>
              <dt>دروازه‌های برقرار</dt>
              <dd>{readiness ? <Ratio part={readiness.passed} whole={readiness.total} /> : DASH}</dd>
            </div>
            {/* A blocking reason is a sentence — it gets the whole row. */}
            <div className="sa-cc-wide">
              <dt>نخستین مانع</dt>
              <dd className="sa-cc-reason">{readiness?.topBlockerFa ?? "—"}</dd>
            </div>
          </dl>
        </section>
      </div>

      {/* ── everything technical, folded away ────────────────────────── */}
      {advanced ? (
        <details className="panel sa-panel sa-advanced-details">
          <summary className="panel-header sa-panel-header">
            <span className="panel-title">تشخیص‌های پیشرفته</span>
            <span className="sa-panel-note">
              دروازه‌های آمادگی، سیاست‌ها، شواهد، اجارهٔ جمع‌آورنده و محاسبات خام
            </span>
          </summary>
          <div className="panel-body sa-stack">{advanced}</div>
        </details>
      ) : null}

      <p className="sa-cc-foot">{serverNow ? <>زمان سرور: {formatTehran(serverNow)}</> : null}</p>
    </div>
  );
}
