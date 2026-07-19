"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import {
  bubbleSignTone,
  dollarBubbleSupportSentence,
  goldBubblePrimaryStatus,
  goldBubbleSupportSentence,
  MSG_DOLLAR_INSUFFICIENT,
  MSG_GOLD_INSUFFICIENT,
  type ConsolidatedDollarBubble,
  type ConsolidatedGoldBubble,
  type MarketBubbleResponse
} from "@/lib/bubble/compute";
import { DIRHAM_TO_USD_MULTIPLIER } from "@/lib/bubble/formulas";
import { formatDate, formatNumber, formatPercent, formatToman, formatUsd } from "@/components/format";
import { BubbleSkeleton } from "@/components/skeletons";
import { ThemeToggleButton } from "@/components/ThemeToggleButton";

function PageHeader({
  onRefresh,
  lastUpdated,
  loading
}: {
  onRefresh: () => void;
  lastUpdated: number | null;
  loading: boolean;
}) {
  return (
    <div className="page-header">
      <h2 className="page-title">محاسبه حباب بازار</h2>
      <div className="header-meta">
        <div className="last-update">
          آخرین بروزرسانی:{" "}
          <span className="number">
            {lastUpdated ? new Date(lastUpdated).toLocaleTimeString("fa-IR") : "—"}
          </span>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={loading}
          title="بروزرسانی"
          aria-label="بروزرسانی"
        >
          <RefreshCw aria-hidden="true" className={loading ? "spinning" : undefined} />
        </button>
        <ThemeToggleButton />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  tone
}: {
  label: string;
  value: string;
  tone?: "danger" | "good" | "warn" | "muted";
}) {
  return (
    <div className={`metric bubble-metric${tone ? ` tone-${tone}` : ""}`}>
      <div className="metric-label">{label}</div>
      <div className="metric-value number">{value}</div>
    </div>
  );
}

function signToneClass(sign: string | null | undefined): "danger" | "good" | "warn" | "muted" {
  return bubbleSignTone(sign as "positive" | "negative" | "near_zero" | null);
}

function sourceNamesLine(members: Array<{ sourceName: string }>, count: number): string {
  if (count === 0) return "—";
  const names = members.map((m) => m.sourceName).join("، ");
  if (count === 1) return `بر اساس ۱ منبع: ${names}`;
  return `بر اساس ${new Intl.NumberFormat("fa-IR").format(count)} منبع: ${names}`;
}

function ConsolidatedDollarCard({
  consolidated,
  reason
}: {
  consolidated: ConsolidatedDollarBubble | null;
  reason: string | null;
}) {
  return (
    <section className="panel bubble-panel">
      <div className="panel-header">
        <h3 className="panel-title">حباب دلار</h3>
      </div>
      <div className="panel-body">
        {!consolidated ? (
          <div className="empty muted">{reason ?? MSG_DOLLAR_INSUFFICIENT}</div>
        ) : (
          <>
            <div
              className={`bubble-dollar-result tone-${signToneClass(consolidated.sign)}`}
              role="status"
            >
              <p className="bubble-dollar-result-text">
                {dollarBubbleSupportSentence(consolidated.sign, consolidated.bubblePercent)}
              </p>
            </div>
            <div className="grid metrics-grid bubble-metrics">
              <Metric label="میانگین قیمت درهم" value={formatToman(consolidated.averageDirhamToman)} />
              <Metric label="ضریب تبدیل" value={formatNumber(DIRHAM_TO_USD_MULTIPLIER, 4)} />
              <Metric label="دلار محاسباتی" value={formatToman(consolidated.calculatedDollarToman)} />
              <Metric label="میانگین دلار بازار" value={formatToman(consolidated.averageMarketDollarToman)} />
              <Metric
                label="اختلاف تومانی (بازار − محاسباتی)"
                value={formatToman(consolidated.bubbleToman)}
                tone={signToneClass(consolidated.sign)}
              />
              <Metric
                label="اختلاف درصدی"
                value={formatPercent(consolidated.bubblePercent)}
                tone={signToneClass(consolidated.sign)}
              />
            </div>
            <div className="bubble-source-meta muted small">
              درهم: {sourceNamesLine(consolidated.dirhamSources, consolidated.dirhamSourceCount)}
            </div>
            <div className="bubble-source-meta muted small">
              دلار بازار:{" "}
              {sourceNamesLine(consolidated.marketDollarSources, consolidated.marketDollarSourceCount)}
            </div>
            <div className="bubble-source-meta muted small">
              به‌روزرسانی: {formatDate(consolidated.lastUpdated)}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function ConsolidatedGoldCard({
  consolidated,
  reason
}: {
  consolidated: ConsolidatedGoldBubble | null;
  reason: string | null;
}) {
  return (
    <section className="panel bubble-panel">
      <div className="panel-header">
        <h3 className="panel-title">حباب طلا</h3>
        {consolidated ? (
          <span className={`status-chip ${signToneClass(consolidated.sign)}`}>
            {goldBubblePrimaryStatus(consolidated.sign)}
          </span>
        ) : null}
      </div>
      <div className="panel-body">
        {!consolidated ? (
          <div className="empty muted">{reason ?? MSG_GOLD_INSUFFICIENT}</div>
        ) : (
          <>
            <div className="bubble-gold-direction" role="status">
              <div className={`bubble-gold-primary tone-${signToneClass(consolidated.sign)}`}>
                {goldBubblePrimaryStatus(consolidated.sign)}
              </div>
              <p className="bubble-gold-support muted small">
                {goldBubbleSupportSentence(consolidated.sign, consolidated.goldBubblePercent)}
              </p>
            </div>
            <div className="grid metrics-grid bubble-metrics">
              <Metric label="میانگین اونس" value={formatUsd(consolidated.averageOunceUsd)} />
              <Metric label="میانگین درهم" value={formatToman(consolidated.averageDirhamToman)} />
              <Metric label="میانگین مظنه" value={formatToman(consolidated.averageMazaneToman)} />
              <Metric label="دلار محاسباتی" value={formatToman(consolidated.realDollarToman)} />
              <Metric
                label="اختلاف هر کیلو طلای ایران با ارزش جهانی (تومان)"
                value={formatToman(consolidated.goldBubbleTomanPerKg)}
                tone={signToneClass(consolidated.sign)}
              />
              <Metric
                label="اختلاف هر کیلو طلای ایران با ارزش جهانی (دلار)"
                value={formatUsd(consolidated.goldBubbleUsdPerKg)}
                tone={signToneClass(consolidated.sign)}
              />
              <Metric
                label="اختلاف درصدی ایران با ارزش جهانی"
                value={formatPercent(consolidated.goldBubblePercent)}
                tone={signToneClass(consolidated.sign)}
              />
            </div>
            <div className="bubble-source-meta muted small">
              به‌روزرسانی: {formatDate(consolidated.lastUpdated)}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function FormulaSection() {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel bubble-panel">
      <button
        type="button"
        className="bubble-formula-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="panel-title">فرمول محاسبه</span>
        {open ? <ChevronUp size={18} aria-hidden /> : <ChevronDown size={18} aria-hidden />}
      </button>
      {open ? (
        <div className="panel-body bubble-formula-body">
          <h4 className="bubble-formula-h">دلار</h4>
          <ul className="bubble-formula-list">
            <li>دلار محاسباتی = قیمت درهم × ۳٫۶۷۲۵</li>
            <li>دلار بازار از قیمت کاغذی/مرجع همان منبع (بدون ساختن خرید/فروش جعلی)</li>
          </ul>
          <h4 className="bubble-formula-h">طلا</h4>
          <ul className="bubble-formula-list">
            <li>دلار محاسباتی = درهم × ۳٫۶۷۲۵</li>
            <li>هر کیلو طلا (دلار) = (اونس × ۱۰۰۰) ÷ ۳۱٫۱۰۴</li>
            <li>هر کیلو طلا (تومان) = هر کیلو طلا (دلار) × دلار محاسباتی</li>
            <li>یک گرم ۱۸ عیار = مظنه ÷ ۴٫۳۳۱۸</li>
            <li>ارزش داخلی هر کیلو طلا = یک گرم ۱۸ عیار × ۱۳۳۳٫۲</li>
            <li>حباب هر کیلو طلا (تومان) = ارزش داخلی هر کیلو طلا − هر کیلو طلا (تومان)</li>
            <li>حباب هر کیلو طلا (دلار) = حباب هر کیلو طلا (تومان) ÷ دلار محاسباتی</li>
            <li>حباب درصدی = (حباب هر کیلو طلا (تومان) ÷ هر کیلو طلا (تومان)) × ۱۰۰</li>
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function HealthPanel({ data }: { data: MarketBubbleResponse }) {
  return (
    <section className="panel bubble-panel">
      <div className="panel-header">
        <h3 className="panel-title">وضعیت منابع</h3>
      </div>
      <div className="panel-body">
        <div className="bubble-health-list">
          {data.health.map((h) => (
            <div
              key={`health-${h.scope}-${h.sourceId}`}
              className="bubble-health-row"
            >
              <span>{h.sourceName}</span>
              <span className={`status-chip ${h.status === "available" ? "good" : h.status === "degraded" ? "warn" : "danger"}`}>
                {h.status === "available" ? "فعال" : h.status === "degraded" ? "ناقص" : "قطع"}
              </span>
              <span className="muted small number">{h.lastUpdated ? formatDate(h.lastUpdated) : "—"}</span>
            </div>
          ))}
        </div>
        {data.notes.length ? (
          <ul className="bubble-notes muted small">
            {data.notes.map((n, noteIndex) => (
              <li key={`bubble-note-${noteIndex}-${n.slice(0, 48)}`}>{n}</li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

export function BubbleView() {
  const { data, loading, error, reload, lastUpdated } = useApi<MarketBubbleResponse>("/api/bubble", 30_000);

  const content = useMemo(() => {
    if (!data) return null;
    return data;
  }, [data]);

  if (loading && !content) {
    return (
      <>
        <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
        <BubbleSkeleton />
      </>
    );
  }

  if (error && !content) {
    return (
      <>
        <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
        <div className="empty">داده‌ای دریافت نشد: {error}</div>
      </>
    );
  }

  if (!content) return null;

  return (
    <div className="bubble-page" data-layout-version="bubble-v1">
      <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      {error ? <div className="empty warn-inline muted">خطای تازه: {error} — آخرین داده معتبر نمایش داده می‌شود.</div> : null}

      <ConsolidatedDollarCard
        consolidated={content.dollar.consolidated}
        reason={content.dollar.unavailableReason}
      />

      <ConsolidatedGoldCard
        consolidated={content.gold.consolidated}
        reason={content.gold.unavailableReason}
      />

      <FormulaSection />
      <HealthPanel data={content} />
    </div>
  );
}
