"use client";

import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import {
  bubbleSignLabel,
  bubbleSignTone,
  type DollarSideBubble,
  type DollarSourceBubbleCard,
  type GoldSourceBubbleCard,
  type MarketBubbleResponse
} from "@/lib/bubble/compute";
import { DIRHAM_TO_USD_MULTIPLIER, type GoldBubbleDetail } from "@/lib/bubble/formulas";
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

function DollarSummaryCard({
  summary,
  reason
}: {
  summary: DollarSideBubble | null;
  reason: string | null;
}) {
  return (
    <section className="panel bubble-panel">
      <div className="panel-header">
        <h3 className="panel-title">حباب دلار (خلاصه بازار)</h3>
        {summary ? (
          <span className={`status-chip ${signToneClass(summary.sign)}`}>
            {bubbleSignLabel(summary.sign)}
          </span>
        ) : null}
      </div>
      <div className="panel-body">
        {!summary ? (
          <div className="empty muted">{reason ?? "داده کافی برای محاسبه حباب در دسترس نیست"}</div>
        ) : (
          <div className="grid metrics-grid bubble-metrics">
            <Metric label="قیمت درهم (میانه)" value={formatToman(summary.dirhamToman)} />
            <Metric label="ضریب تبدیل" value={formatNumber(DIRHAM_TO_USD_MULTIPLIER, 4)} />
            <Metric label="دلار محاسباتی" value={formatToman(summary.realDollarToman)} />
            <Metric label="دلار بازار (میانه)" value={formatToman(summary.marketDollarToman)} />
            <Metric
              label="حباب تومانی"
              value={formatToman(summary.bubbleToman)}
              tone={signToneClass(summary.sign)}
            />
            <Metric
              label="حباب درصدی"
              value={formatPercent(summary.bubblePercent)}
              tone={signToneClass(summary.sign)}
            />
          </div>
        )}
      </div>
    </section>
  );
}

function DollarSourceCard({ card }: { card: DollarSourceBubbleCard }) {
  return (
    <article className="panel bubble-source-card">
      <div className="panel-header">
        <h3 className="panel-title">حباب دلار · {card.sourceName}</h3>
        <span className={`status-chip ${card.available ? signToneClass(card.mid?.sign) : "warn"}`}>
          {card.available ? bubbleSignLabel(card.mid?.sign ?? null) : "قطع / ناقص"}
        </span>
      </div>
      <div className="panel-body">
        {!card.available || !card.mid ? (
          <div className="empty muted">
            {card.unavailableReason ?? "داده کافی برای محاسبه حباب در دسترس نیست"}
          </div>
        ) : (
          <>
            <div className="grid metrics-grid bubble-metrics">
              <Metric label="قیمت درهم" value={formatToman(card.mid.dirhamToman)} />
              <Metric label="ضریب تبدیل" value={formatNumber(DIRHAM_TO_USD_MULTIPLIER, 4)} />
              <Metric label="دلار محاسباتی" value={formatToman(card.mid.realDollarToman)} />
              <Metric
                label={`دلار بازار (${card.marketDollar.assetLabel})`}
                value={formatToman(card.mid.marketDollarToman)}
              />
              <Metric
                label="حباب تومانی"
                value={formatToman(card.mid.bubbleToman)}
                tone={signToneClass(card.mid.sign)}
              />
              <Metric
                label="حباب درصدی"
                value={formatPercent(card.mid.bubblePercent)}
                tone={signToneClass(card.mid.sign)}
              />
            </div>
            {card.buy && card.sell ? (
              <div className="bubble-side-grid">
                <div className="bubble-side-block">
                  <div className="bubble-side-title">خرید</div>
                  <div className="muted small">حباب: {formatToman(card.buy.bubbleToman)}</div>
                  <div className="muted small">٪ {formatNumber(card.buy.bubblePercent, 2)}</div>
                </div>
                <div className="bubble-side-block">
                  <div className="bubble-side-title">فروش</div>
                  <div className="muted small">حباب: {formatToman(card.sell.bubbleToman)}</div>
                  <div className="muted small">٪ {formatNumber(card.sell.bubblePercent, 2)}</div>
                </div>
              </div>
            ) : card.dirham.referenceOnly || card.marketDollar.referenceOnly ? (
              <p className="muted small bubble-note">
                این منبع فقط قیمت مرجع دارد — خرید/فروش جداگانه محاسبه نشده است.
              </p>
            ) : null}
            <div className="bubble-source-meta muted small">
              به‌روزرسانی: {formatDate(card.health.lastUpdated)}
              {card.health.stale ? " · تأخیری" : ""}
            </div>
          </>
        )}
      </div>
    </article>
  );
}

function GoldDetailMetrics({ detail }: { detail: GoldBubbleDetail }) {
  return (
    <div className="grid metrics-grid bubble-metrics">
      <Metric label="اونس جهانی" value={formatUsd(detail.ounceUsd)} />
      <Metric label="قیمت درهم" value={formatToman(detail.dirhamToman)} />
      <Metric label="دلار محاسباتی" value={formatToman(detail.realDollarToman)} />
      <Metric label="مظنه" value={formatToman(detail.mazaneToman)} />
      <Metric label="یک گرم طلای ۱۸ عیار" value={formatToman(detail.gram18Toman)} />
      <Metric label="ارزش جهانی هر کیلو (دلار)" value={formatUsd(detail.globalGoldKgUsd)} />
      <Metric label="ارزش جهانی هر کیلو (تومان)" value={formatToman(detail.globalGoldKgToman)} />
      <Metric label="ارزش داخلی هر کیلو طلا" value={formatToman(detail.localPureGoldKgToman)} />
      <Metric label="ارزش داخلی هر کیلو (دلار)" value={formatUsd(detail.impliedLocalGoldKgUsd)} />
      <Metric
        label="حباب تومانی هر کیلو"
        value={formatToman(detail.goldBubbleTomanPerKg)}
        tone={signToneClass(detail.sign)}
      />
      <Metric
        label="حباب دلاری هر کیلو"
        value={formatUsd(detail.goldBubbleUsdPerKg)}
        tone={signToneClass(detail.sign)}
      />
      <Metric
        label="حباب درصدی"
        value={formatPercent(detail.goldBubblePercent)}
        tone={signToneClass(detail.sign)}
      />
      <Metric
        label="معادل حباب به گرم ۱۸ عیار"
        value={formatNumber(detail.equivalentGram18Bubble, 3)}
        tone={signToneClass(detail.sign)}
      />
    </div>
  );
}

function GoldSummaryCard({
  summary,
  reason
}: {
  summary: GoldBubbleDetail | null;
  reason: string | null;
}) {
  return (
    <section className="panel bubble-panel">
      <div className="panel-header">
        <h3 className="panel-title">حباب طلا (خلاصه بازار)</h3>
        {summary ? (
          <span className={`status-chip ${signToneClass(summary.sign)}`}>
            {bubbleSignLabel(summary.sign)}
          </span>
        ) : null}
      </div>
      <div className="panel-body">
        {!summary ? (
          <div className="empty muted">{reason ?? "داده کافی برای محاسبه حباب در دسترس نیست"}</div>
        ) : (
          <div className="grid metrics-grid bubble-metrics">
            <Metric
              label="حباب تومانی هر کیلو"
              value={formatToman(summary.goldBubbleTomanPerKg)}
              tone={signToneClass(summary.sign)}
            />
            <Metric
              label="حباب دلاری هر کیلو"
              value={formatUsd(summary.goldBubbleUsdPerKg)}
              tone={signToneClass(summary.sign)}
            />
            <Metric
              label="حباب درصدی"
              value={formatPercent(summary.goldBubblePercent)}
              tone={signToneClass(summary.sign)}
            />
            <Metric label="وضعیت" value={bubbleSignLabel(summary.sign)} tone={signToneClass(summary.sign)} />
          </div>
        )}
      </div>
    </section>
  );
}

function GoldSourceCard({ card }: { card: GoldSourceBubbleCard }) {
  return (
    <article className="panel bubble-source-card">
      <div className="panel-header">
        <h3 className="panel-title">حباب طلا · {card.sourceName}</h3>
        <span className={`status-chip ${card.available ? signToneClass(card.detail?.sign) : "warn"}`}>
          {card.available ? bubbleSignLabel(card.detail?.sign ?? null) : "قطع / ناقص"}
        </span>
      </div>
      <div className="panel-body">
        {!card.available || !card.detail ? (
          <div className="empty muted">
            {card.unavailableReason ?? "داده کافی برای محاسبه حباب در دسترس نیست"}
            {card.health.note ? <div className="small">{card.health.note}</div> : null}
          </div>
        ) : (
          <>
            <GoldDetailMetrics detail={card.detail} />
            <div className="bubble-source-meta muted small">
              به‌روزرسانی: {formatDate(card.health.lastUpdated)}
              {card.health.stale ? " · تأخیری" : ""}
            </div>
          </>
        )}
      </div>
    </article>
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
            <li>حباب تومانی = دلار بازار − دلار محاسباتی</li>
            <li>حباب درصدی = (حباب تومانی ÷ دلار محاسباتی) × ۱۰۰</li>
            <li>خرید و فروش فقط وقتی هر دو طرف از همان منبع موجود باشند محاسبه می‌شوند</li>
          </ul>
          <h4 className="bubble-formula-h">طلا</h4>
          <ul className="bubble-formula-list">
            <li>دلار محاسباتی = درهم × ۳٫۶۷۲۵</li>
            <li>ارزش جهانی هر کیلو (دلار) = (اونس × ۱۰۰۰) ÷ ۳۱٫۱۰۴</li>
            <li>ارزش جهانی هر کیلو (تومان) = ارزش دلاری کیلو × دلار محاسباتی</li>
            <li>یک گرم ۱۸ عیار = مظنه ÷ ۴٫۳۳۱۸</li>
            <li>ارزش داخلی هر کیلو طلا = یک گرم ۱۸ عیار × ۱۳۳۳٫۲</li>
            <li>حباب تومانی هر کیلو = ارزش داخلی − ارزش جهانی</li>
            <li>حباب دلاری هر کیلو = حباب تومانی ÷ دلار محاسباتی</li>
            <li>حباب درصدی = (حباب تومانی ÷ ارزش جهانی تومانی) × ۱۰۰</li>
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

      <DollarSummaryCard summary={content.dollar.summary} reason={content.dollar.summaryUnavailableReason} />

      <div className="grid bubble-source-grid">
        {content.dollar.sources.map((card) => (
          <DollarSourceCard key={`dollar-source-${card.sourceId}`} card={card} />
        ))}
      </div>

      <GoldSummaryCard summary={content.gold.summary} reason={content.gold.summaryUnavailableReason} />

      {content.gold.summary ? (
        <section className="panel bubble-panel">
          <div className="panel-header">
            <h3 className="panel-title">جزئیات محاسبه طلا (خلاصه)</h3>
          </div>
          <div className="panel-body">
            <GoldDetailMetrics detail={content.gold.summary} />
          </div>
        </section>
      ) : null}

      <div className="grid bubble-source-grid">
        {content.gold.sources.map((card) => (
          <GoldSourceCard key={`gold-source-${card.sourceId}`} card={card} />
        ))}
      </div>

      <FormulaSection />
      <HealthPanel data={content} />
    </div>
  );
}
