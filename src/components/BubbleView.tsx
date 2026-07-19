"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import {
  bubbleSignTone,
  dollarBubbleSupportSentence,
  goldBubblePrimaryStatus,
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

/** Header line: «آخرین به‌روزرسانی: {date}، {time}» from live ISO (never hardcoded). */
function formatBubbleHeaderUpdated(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const datePart = new Intl.DateTimeFormat("fa-IR", { dateStyle: "short" }).format(date);
  const timePart = new Intl.DateTimeFormat("fa-IR", { timeStyle: "short" }).format(date);
  return `آخرین به‌روزرسانی: ${datePart}، ${timePart}`;
}

function ConsolidatedDollarCard({
  consolidated,
  reason
}: {
  consolidated: ConsolidatedDollarBubble | null;
  reason: string | null;
}) {
  const headerUpdated = formatBubbleHeaderUpdated(consolidated?.lastUpdated);
  return (
    <section className="panel bubble-panel">
      <div className="panel-header bubble-section-header">
        <h3 className="panel-title">حباب دلار</h3>
        {headerUpdated ? (
          <span className="bubble-section-updated muted small number">{headerUpdated}</span>
        ) : null}
      </div>
      <div className="panel-body">
        {!consolidated ? (
          <div className="empty muted">{reason ?? MSG_DOLLAR_INSUFFICIENT}</div>
        ) : (
          <>
            <div
              className={`bubble-result-card tone-${signToneClass(consolidated.sign)}`}
              role="status"
            >
              <p className="bubble-result-card-text">
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
      </div>
      <div className="panel-body">
        {!consolidated ? (
          <div className="empty muted">{reason ?? MSG_GOLD_INSUFFICIENT}</div>
        ) : (
          <>
            <div
              className={`bubble-result-card tone-${signToneClass(consolidated.sign)}`}
              role="status"
            >
              <p className="bubble-result-card-text">
                {goldBubblePrimaryStatus(consolidated.sign)}
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

function healthStatusTone(status: string): "good" | "warn" | "danger" {
  if (status === "available") return "good";
  if (status === "degraded") return "warn";
  return "danger";
}

function healthStatusLabel(status: string): string {
  if (status === "available") return "فعال";
  if (status === "degraded") return "ناقص";
  return "قطع";
}

function HealthPanel({ data }: { data: MarketBubbleResponse }) {
  return (
    <section className="bubble-health-section" aria-label="وضعیت منابع">
      <div className="bubble-health-cards">
        {data.health.map((h) => (
          <article
            key={`health-${h.scope}-${h.sourceId}`}
            className="panel bubble-panel bubble-health-card"
          >
            <div className="bubble-health-card-head">
              <h3 className="panel-title bubble-health-card-title">{h.sourceName}</h3>
              <span className={`status-chip ${healthStatusTone(h.status)}`}>
                {healthStatusLabel(h.status)}
              </span>
            </div>
            <div className="bubble-health-card-time muted small number">
              {h.lastUpdated ? formatDate(h.lastUpdated) : "—"}
            </div>
          </article>
        ))}
      </div>
      {data.notes.length ? (
        <ul className="bubble-notes muted small">
          {data.notes.map((n, noteIndex) => (
            <li key={`bubble-note-${noteIndex}-${n.slice(0, 48)}`}>{n}</li>
          ))}
        </ul>
      ) : null}
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

      <HealthPanel data={content} />
      <FormulaSection />
    </div>
  );
}
