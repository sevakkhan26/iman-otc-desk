"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarClock, Clock, RefreshCw, Save, X } from "lucide-react";
import type {
  AlertItem,
  AssetTag,
  DashboardResponse,
  DecisionCard,
  DomesticQuote,
  ExchangeMonitorResponse,
  ExchangeOperationalStatus,
  ForexEvent,
  ForexEventsResponse,
  GlobalPrice,
  ImpactNewsItem,
  ImpactNewsResponse,
  PublicSettings,
  QuickDecision,
  Severity,
  TetherMarketResponse
} from "@/lib/types";
import {
  decisionLabel,
  decisionTone,
  forexImpactLabel,
  forexImpactTone,
  formatCountdown,
  formatDate,
  formatNumber,
  formatPercent,
  formatTehran,
  formatToman,
  formatUsd,
  marketStateLabel,
  marketStateTone,
  premiumImpactLabel,
  premiumImpactTone,
  severityLabel,
  severityTone,
  statusLabel,
  statusTone
} from "@/components/format";
import { SmartFilter, matchAsset, matchQuery, type AssetFilter } from "@/components/SmartFilter";
import { MedianChart } from "@/components/MedianChart";
import { assetLabel } from "@/lib/assets";

type AlertsResponse = { items: AlertItem[] };

// ---- Timing & display limits (single source of truth) ----
const DASHBOARD_REFRESH_MS = 60_000;
const NEWS_REFRESH_MS = 120_000;
const CLOCK_TICK_MS = 1_000;
const WIDGET_TICK_MS = 30_000;
const TOAST_TTL_MS = 9_000;
const MAX_TOASTS = 5;
const TICKER_MAX_ITEMS = 12;
const FOREX_LOOKBACK_MS = 2 * 60 * 60 * 1_000;

/* ============================================================
 * Data hook
 * ========================================================== */
function useApi<T>(url: string, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const hasDataRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })
      .then((value) => {
        setData(value);
        hasDataRef.current = true;
        setLastUpdated(Date.now());
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        // keep showing last good data on background-refresh errors
        if (!hasDataRef.current) setError(err instanceof Error ? err.message : "داده‌ای دریافت نشد");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [url, revision]);

  // background auto-refresh (no loading flash — the fetch effect no longer flips loading)
  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => setRevision((value) => value + 1), refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { data, loading, error, reload, lastUpdated };
}

const clockDateFmt = new Intl.DateTimeFormat("fa-IR", { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
const clockTimeFmt = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/* ============================================================
 * Reusable primitives
 * ========================================================== */
function PageHeader({
  title,
  onRefresh,
  lastUpdated,
  loading = false
}: {
  title: string;
  onRefresh?: () => void;
  lastUpdated?: number | null;
  loading?: boolean;
}) {
  // mount-guarded so the server render (null) matches the first client render, then ticks every second
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return (
    <div className="page-header">
      <h2 className="page-title">{title}</h2>
      <div className="header-meta">
        <div className="clock" title="تاریخ و ساعت جاری">
          <Clock aria-hidden="true" size={15} />
          <span className="clock-date">{now ? clockDateFmt.format(now) : "—"}</span>
          <span className="clock-time number">{now ? clockTimeFmt.format(now) : "—"}</span>
        </div>
        <div className="last-update">
          آخرین بروزرسانی: <span className="number">{lastUpdated ? clockTimeFmt.format(lastUpdated) : "—"}</span>
        </div>
        {onRefresh ? (
          <button
            className="icon-button"
            onClick={onRefresh}
            title="بروزرسانی"
            aria-label="بروزرسانی"
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" className={loading ? "spinning" : undefined} />
          </button>
        ) : null}
      </div>
    </div>
  );
}

type Tone = "good" | "warn" | "danger" | "neutral";

const Badge = memo(function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
});

function Panel({
  title,
  meta,
  children
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-header">
        <h3 className="panel-title">{title}</h3>
        {meta}
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

const Metric = memo(function Metric({
  label,
  value,
  note
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {note ? <div className="metric-note">{note}</div> : null}
    </div>
  );
});

const AssetTags = memo(function AssetTags({ assets }: { assets: AssetTag[] }) {
  if (!assets.length) return null;
  return (
    <div className="asset-tags">
      {assets.map((asset) => (
        <span className="asset-tag" key={asset}>
          {assetLabel(asset)}
        </span>
      ))}
    </div>
  );
});

function AnswerStat({
  question,
  value,
  note,
  tone = "neutral"
}: {
  question: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: "good" | "warn" | "danger" | "neutral";
}) {
  return (
    <div className="answer-stat">
      <div className="answer-question">{question}</div>
      <div className="answer-value number">{value}</div>
      {note ? (
        <div className="answer-note">
          {tone !== "neutral" ? <span className={`mini-dot ${tone}`} aria-hidden="true" /> : null}
          {note}
        </div>
      ) : null}
    </div>
  );
}

function DecisionCardView({
  question,
  card,
  compact = false
}: {
  question: string;
  card: DecisionCard;
  compact?: boolean;
}) {
  const tone = decisionTone(card.level);
  if (compact) {
    return (
      <div className="decision-card compact" title={card.detail}>
        <span className={`mini-dot ${tone}`} aria-hidden="true" />
        <span className="decision-question">{question}</span>
        <span className="decision-headline">{card.headline}</span>
      </div>
    );
  }
  return (
    <div className={`decision-card ${tone}`}>
      <div className="decision-top">
        <span className="decision-question">{question}</span>
        <Badge tone={tone}>{decisionLabel(card.level)}</Badge>
      </div>
      <div className="decision-headline">{card.headline}</div>
      <p className="decision-detail">{card.detail}</p>
    </div>
  );
}

/* ===== Toast pop-up notifications (LP connect/disconnect + critical alerts) ===== */
type Toast = { id: number; tone: "danger" | "good" | "warn"; title: string; detail?: string };

function notify(title: string, body?: string) {
  try {
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification(title, { body });
    }
  } catch {
    /* ignore */
  }
}

function useConnectivityToasts(exchanges: DomesticQuote[] | undefined) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const prevDownRef = useRef<Set<string> | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    if (!exchanges) return;
    const down = new Set(
      exchanges.filter((exchange) => exchange.sourceStatus === "unavailable").map((exchange) => exchange.exchangeName)
    );
    const prev = prevDownRef.current;
    if (prev) {
      const events: Toast[] = [];
      for (const name of down) {
        if (!prev.has(name)) events.push({ id: ++idRef.current, tone: "danger", title: `قطع شد: ${name}`, detail: "اتصال LP قطع شد" });
      }
      for (const name of prev) {
        if (!down.has(name)) events.push({ id: ++idRef.current, tone: "good", title: `وصل شد: ${name}`, detail: "اتصال LP دوباره برقرار شد" });
      }
      if (events.length) {
        setToasts((current) => [...events, ...current].slice(0, MAX_TOASTS));
        events.forEach((event) => notify(event.title, event.detail));
      }
    }
    prevDownRef.current = down;
  }, [exchanges]);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);
  return { toasts, dismiss };
}

const ToastItem = memo(function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  useEffect(() => {
    const id = setTimeout(() => onDismiss(toast.id), TOAST_TTL_MS);
    return () => clearTimeout(id);
  }, [toast.id, onDismiss]);
  return (
    <div className={`toast ${toast.tone}`} role="alert">
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.detail ? <div className="toast-detail">{toast.detail}</div> : null}
      </div>
      <button type="button" className="toast-close" onClick={() => onDismiss(toast.id)} aria-label="بستن">
        <X aria-hidden="true" size={15} />
      </button>
    </div>
  );
});

function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toast-stack" aria-live="assertive">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

/* ===== Scrolling news ticker ===== */
function NewsTicker() {
  const { data } = useApi<ImpactNewsResponse>("/api/impact-news", NEWS_REFRESH_MS);
  const items = useMemo(() => {
    const all = data?.items ?? [];
    const important = all.filter((item) => item.severity !== "low");
    return (important.length ? important : all).slice(0, TICKER_MAX_ITEMS);
  }, [data]);

  if (!items.length) return null;
  const sequence = [...items, ...items];
  return (
    <div className="ticker" aria-label="اخبار مهم">
      <span className="ticker-label">اخبار مهم</span>
      <div className="ticker-viewport">
        <div className="ticker-track">
          {sequence.map((item, index) => {
            const content = (
              <>
                <span className={`ticker-dot ${severityTone(item.severity)}`} aria-hidden="true" />
                <span className="ticker-text">{item.title}</span>
                <span className="ticker-src">— {item.source}</span>
              </>
            );
            return item.url ? (
              <a key={`${item.id}-${index}`} className="ticker-item" href={item.url} target="_blank" rel="noreferrer">
                {content}
              </a>
            ) : (
              <span key={`${item.id}-${index}`} className="ticker-item">
                {content}
              </span>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function QuickDecisionCockpit({
  quickDecision,
  marketState
}: {
  quickDecision: QuickDecision;
  marketState: DashboardResponse["marketState"];
}) {
  return (
    <section className="cockpit">
      <div className="cockpit-hero-row">
        <div className="cockpit-hero">
          <div className="cockpit-hero-label">قیمت میانه تتر (USDT/IRT)</div>
          <div className="cockpit-hero-value number">{formatToman(quickDecision.median)}</div>
          <div className="cockpit-hero-sub">اختلاف بازار بین صرافی‌ها: {formatPercent(quickDecision.spreadPercent)}</div>
        </div>
        <span className={`state-pill lg ${marketStateTone(marketState)}`}>
          وضعیت کلی بازار: {marketStateLabel(marketState)}
        </span>
      </div>

      <div className="grid answer-grid">
        <AnswerStat
          question="بالاترین قیمت"
          value={formatToman(quickDecision.highest.price)}
          note={quickDecision.highest.exchange ?? "—"}
          tone="danger"
        />
        <AnswerStat
          question="پایین‌ترین قیمت"
          value={formatToman(quickDecision.lowest.price)}
          note={quickDecision.lowest.exchange ?? "—"}
          tone="good"
        />
        <AnswerStat
          question="بهترین قیمت خرید"
          value={formatToman(quickDecision.bestBuy.price)}
          note={quickDecision.bestBuy.exchange ?? "—"}
        />
        <AnswerStat
          question="بهترین قیمت فروش"
          value={formatToman(quickDecision.bestSell.price)}
          note={quickDecision.bestSell.exchange ?? "—"}
        />
      </div>

      <div className="grid decision-grid compact">
        <DecisionCardView question="Spread؟" card={quickDecision.spreadAction} compact />
        <DecisionCardView question="Max Order؟" card={quickDecision.maxOrderAction} compact />
        <DecisionCardView question="احتیاط LP؟" card={quickDecision.lpCaution} compact />
        <DecisionCardView question="قیمت پرت؟" card={quickDecision.outlierWatch} compact />
      </div>
    </section>
  );
}

function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <div className="loading">در حال دریافت داده...</div>;
  if (error) return <div className="empty">داده‌ای دریافت نشد: {error}</div>;
  return null;
}

const SourceStatusBadge = memo(function SourceStatusBadge({
  status,
  title
}: {
  status: DomesticQuote["sourceStatus"] | ExchangeOperationalStatus["apiStatus"];
  title?: string;
}) {
  return (
    <span className={`status-chip ${statusTone(status)}`} title={title || statusLabel(status)}>
      <span className="status-chip-dot" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  );
});

function DomesticTable({ rows }: { rows: DomesticQuote[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>صرافی</th>
            <th>خرید</th>
            <th>فروش</th>
            <th>قیمت وسط</th>
            <th>اسپرد</th>
            <th>اختلاف با Median</th>
            <th>وضعیت منبع</th>
            <th>آخرین بروزرسانی</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.exchangeId}>
              <td>
                <div className="stack">
                  <strong>{row.exchangeName}</strong>
                  {row.isOutlier ? <Badge tone="danger">قیمت پرت</Badge> : null}
                </div>
              </td>
              <td className="number">{row.sourceStatus === "unavailable" ? "—" : formatToman(row.buyPrice)}</td>
              <td className="number">{row.sourceStatus === "unavailable" ? "—" : formatToman(row.sellPrice)}</td>
              <td className="number">{row.sourceStatus === "unavailable" ? "—" : formatToman(row.midPrice)}</td>
              <td className="number">{row.spread === null ? "—" : formatToman(row.spread)}</td>
              <td className="number">{row.deviationFromMedianPercent === null ? "—" : formatPercent(row.deviationFromMedianPercent)}</td>
              <td>
                <SourceStatusBadge status={row.sourceStatus} title={row.errorMessage} />
              </td>
              <td className="nowrap">{row.lastUpdated ? formatDate(row.lastUpdated) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const ExchangeCard = memo(function ExchangeCard({
  row,
  isBestBuy,
  isBestSell
}: {
  row: DomesticQuote;
  isBestBuy: boolean;
  isBestSell: boolean;
}) {
  const down = row.sourceStatus === "unavailable";
  const noData = !down && row.midPrice === null;
  const className = [
    "exch-card",
    down || noData ? "is-empty" : "",
    isBestBuy || isBestSell ? "is-best" : ""
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <article className={className}>
      <header className="exch-card-head">
        <span className="exch-name">{row.exchangeName}</span>
        <span className={`status-dot ${statusTone(row.sourceStatus)}`} title={statusLabel(row.sourceStatus)} />
      </header>
      {down || noData ? (
        <div className="exch-empty-label">{down ? "متصل نیست" : "داده ندارد"}</div>
      ) : (
        <div className="exch-prices">
          <div className="exch-row">
            <span className="exch-k">خرید</span>
            <span className="exch-v number">{row.buyPrice === null ? "—" : formatToman(row.buyPrice)}</span>
          </div>
          <div className="exch-row">
            <span className="exch-k">فروش</span>
            <span className="exch-v number">{row.sellPrice === null ? "—" : formatToman(row.sellPrice)}</span>
          </div>
          <div className="exch-row mid">
            <span className="exch-k">قیمت وسط</span>
            <span className="exch-v number">{formatToman(row.midPrice)}</span>
          </div>
        </div>
      )}
      {isBestBuy || isBestSell || row.isOutlier ? (
        <footer className="exch-tags">
          {isBestBuy ? <span className="exch-tag best">★ بهترین خرید</span> : null}
          {isBestSell ? <span className="exch-tag best">★ بهترین فروش</span> : null}
          {row.isOutlier ? <span className="exch-tag outlier">قیمت پرت</span> : null}
        </footer>
      ) : null}
    </article>
  );
});

function DashboardExchangeCards({
  rows,
  summary
}: {
  rows: DomesticQuote[];
  summary: TetherMarketResponse["summary"];
}) {
  // connected sources with data first, disconnected/no-data last — keeps live prices front and center
  const ordered = useMemo(() => {
    const weight = (row: DomesticQuote) =>
      row.sourceStatus === "unavailable" ? 2 : row.midPrice === null ? 1 : 0;
    return [...rows].sort((a, b) => weight(a) - weight(b));
  }, [rows]);

  return (
    <div className="exch-grid">
      {ordered.map((row) => (
        <ExchangeCard
          key={row.exchangeId}
          row={row}
          isBestBuy={row.sourceStatus !== "unavailable" && summary.bestBuyExchange === row.exchangeName}
          isBestSell={row.sourceStatus !== "unavailable" && summary.bestSellExchange === row.exchangeName}
        />
      ))}
    </div>
  );
}

const AlertRow = memo(function AlertRow({ item, compact }: { item: AlertItem; compact: boolean }) {
  return (
    <article className="alert-row">
      <div className="row-meta">
        <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
        <span>{item.source}</span>
        <span>{formatDate(item.time)}</span>
        {!compact ? <AssetTags assets={item.assets} /> : null}
      </div>
      <h4 className="row-title">{item.title}</h4>
      {!compact ? (
        <>
          <div className="muted">{item.description}</div>
          <div>{item.impactOnDesk}</div>
          <strong>{item.recommendedAction}</strong>
        </>
      ) : (
        <div className="muted">{item.recommendedAction}</div>
      )}
    </article>
  );
});

function AlertsList({
  items,
  compact = false,
  emptyMessage = "داده‌ای دریافت نشد"
}: {
  items: AlertItem[];
  compact?: boolean;
  emptyMessage?: string;
}) {
  if (!items.length) return <div className="empty">{emptyMessage}</div>;
  return (
    <div className="stack">
      {items.map((item) => (
        <AlertRow key={item.id} item={item} compact={compact} />
      ))}
    </div>
  );
}

const NewsItemCard = memo(function NewsItemCard({ item }: { item: ImpactNewsItem }) {
  return (
    <article className="news-item">
      <div className="row-meta">
        <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
        <span>{item.source}</span>
        <span className="nowrap">{formatDate(item.publishedAt)}</span>
      </div>
      <h4 className="news-item-title">
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.title}
          </a>
        ) : (
          item.title
        )}
      </h4>
      <AssetTags assets={item.assets} />
      <div className="muted news-item-impact">{item.impactOnUsdtIrt}</div>
    </article>
  );
});

function NewsColumn({ items }: { items: ImpactNewsItem[] }) {
  return (
    <div className="stack">
      {items.map((item) => (
        <NewsItemCard key={item.id} item={item} />
      ))}
    </div>
  );
}

function GlobalMetricGrid({ rows }: { rows: GlobalPrice[] }) {
  return (
    <div className="grid global-metrics">
      {rows.map((row) => (
        <Metric
          key={row.symbol}
          label={row.symbol}
          value={row.sourceStatus === "unavailable" ? "قطع" : row.symbol === "USDT/USD" ? formatNumber(row.price, 4) : formatUsd(row.price)}
          note={
            <span>
              {row.source} / {formatDate(row.lastUpdated)}
            </span>
          }
        />
      ))}
    </div>
  );
}

function useNow(intervalMs = WIDGET_TICK_MS) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function ForexEventsWidget({ forex, limit = 6 }: { forex: ForexEventsResponse; limit?: number }) {
  const now = useNow(WIDGET_TICK_MS);

  const events = useMemo(() => {
    return forex.events
      .filter((event) => {
        if (!event.date) return true;
        const time = new Date(event.date).getTime();
        // keep upcoming events and ones released within the last lookback window
        return !Number.isFinite(time) || now - time < FOREX_LOOKBACK_MS;
      })
      .slice(0, limit);
  }, [forex.events, now, limit]);

  if (!forex.events.length) {
    return <div className="empty">{forex.message || "داده‌ای دریافت نشد"}</div>;
  }
  if (!events.length) {
    return <div className="empty">رویداد پیش‌روی مهمی در تقویم این هفته باقی نمانده است</div>;
  }

  return (
    <div className="forex-grid">
      {events.map((event: ForexEvent) => {
        const tone = forexImpactTone(event.impact);
        const countdown = formatCountdown(event.date, now);
        return (
          <article className={`forex-card ${tone} ${countdown.state}`} key={event.id}>
            <div className="forex-top">
              <span className="forex-cat">{event.category}</span>
              <Badge tone={tone}>{forexImpactLabel(event.impact)}</Badge>
            </div>
            <div className="forex-title">
              {event.title} <span className="forex-country">{event.country}</span>
            </div>
            <div className={`forex-countdown ${countdown.state}`}>{countdown.text}</div>
            <div className="forex-time muted">{formatTehran(event.date)} — به وقت ایران</div>
            <div className="forex-values">
              <div>
                <span className="muted">قبلی</span>
                <strong>{event.previous ?? "—"}</strong>
              </div>
              <div>
                <span className="muted">پیش‌بینی</span>
                <strong>{event.forecast ?? "—"}</strong>
              </div>
              <div>
                <span className="muted">واقعی</span>
                <strong className={event.actual ? "forex-actual" : ""}>{event.actual ?? "—"}</strong>
              </div>
            </div>
            <div className={`forex-premium ${premiumImpactTone(event.premiumImpact)}`}>
              <span className="forex-premium-label">تأثیر احتمالی روی پرمیوم تتر:</span>
              <strong>{premiumImpactLabel(event.premiumImpact)}</strong>
              {event.premiumImpactReason ? <span className="forex-premium-reason muted">({event.premiumImpactReason})</span> : null}
            </div>
          </article>
        );
      })}
    </div>
  );
}

export function ForexView() {
  const { data, loading, error, reload, lastUpdated } = useApi<ForexEventsResponse>("/api/forex");
  return (
    <>
      <PageHeader title="فارکس" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <Panel
            title="رویدادهای مهم فارکس (USD)"
            meta={
              <span className="panel-meta-icon muted">
                <CalendarClock aria-hidden="true" size={15} />
                {data.message || `به‌روزرسانی: ${formatDate(data.lastUpdated)}`}
              </span>
            }
          >
            <ForexEventsWidget forex={data} limit={24} />
          </Panel>
          <div className="forex-note muted">
            تأثیر هر رویداد روی «پرمیوم تتر ایران» بر اساس نوع داده و مقایسه واقعی با پیش‌بینی برآورد می‌شود؛ صرفاً جنبه راهنما دارد.
          </div>
        </div>
      ) : null}
    </>
  );
}

/* ============================================================
 * Page views
 * ========================================================== */
export function DashboardView() {
  const { data, loading, error, reload, lastUpdated } = useApi<DashboardResponse>("/api/dashboard", DASHBOARD_REFRESH_MS);
  const { toasts, dismiss } = useConnectivityToasts(data?.tetherMarket.exchanges);

  // ask once for OS-level notification permission (in-app toasts work regardless)
  useEffect(() => {
    try {
      if (typeof Notification !== "undefined" && Notification.permission === "default") {
        Notification.requestPermission().catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <>
      <Toasts toasts={toasts} onDismiss={dismiss} />
      <PageHeader title="داشبورد" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <NewsTicker />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <QuickDecisionCockpit quickDecision={data.quickDecision} marketState={data.marketState} />
          <Panel
            title="صرافی‌های ایران (USDT/IRT)"
            meta={<span className="muted">به‌روزرسانی: {formatDate(data.tetherMarket.summary.lastUpdated)}</span>}
          >
            <DashboardExchangeCards rows={data.tetherMarket.exchanges} summary={data.tetherMarket.summary} />
          </Panel>
          <div className="grid two-col">
            <Panel title="روند قیمت میانه تتر (USDT/IRT)">
              <MedianChart />
            </Panel>
            <Panel title="بازار جهانی">
              <GlobalMetricGrid rows={data.globalMarket} />
            </Panel>
          </div>
          <div className="grid metrics">
            <Metric label="منابع فعال" value={formatNumber(data.tetherMarket.summary.activeSources, 0)} />
            <Metric label="منابع قطع" value={formatNumber(data.tetherMarket.summary.unavailableSources, 0)} />
            <Metric label="تعداد قیمت پرت" value={formatNumber(data.tetherMarket.summary.outlierCount, 0)} />
            <Metric label="آخرین بروزرسانی" value={formatDate(data.tetherMarket.summary.lastUpdated)} />
          </div>
          <Panel title="هشدارهای اتصال/قطع LP ایرانی">
            <AlertsList items={data.alerts} emptyMessage="همه LPهای ایرانی متصل‌اند؛ هشدار قطعی وجود ندارد." />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

type ConnectionFilter = "all" | "connected" | "disconnected";

function ConnectionSegment({ value, onChange }: { value: ConnectionFilter; onChange: (value: ConnectionFilter) => void }) {
  const options: Array<{ key: ConnectionFilter; label: string }> = [
    { key: "all", label: "همه" },
    { key: "connected", label: "فقط متصل" },
    { key: "disconnected", label: "فقط قطع" }
  ];
  return (
    <div className="segment" role="tablist" aria-label="فیلتر اتصال">
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          role="tab"
          aria-selected={value === option.key}
          className={`segment-item ${value === option.key ? "active" : ""}`}
          onClick={() => onChange(option.key)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function TetherMarketView() {
  const { data, loading, error, reload, lastUpdated } = useApi<TetherMarketResponse>("/api/tether-market");
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");
  const [connection, setConnection] = useState<ConnectionFilter>("all");

  const rows = useMemo(() => {
    if (!data) return [];
    return data.exchanges.filter((row) => {
      const connected = row.sourceStatus !== "unavailable";
      if (connection === "connected" && !connected) return false;
      if (connection === "disconnected" && connected) return false;
      if (!matchAsset(["USDT"], asset)) return false;
      return matchQuery(`${row.exchangeName} ${row.exchangeId}`, query);
    });
  }, [data, asset, query, connection]);

  return (
    <>
      <PageHeader title="بازار تتر ایران" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <div className="grid metrics">
            <Metric label="Median بازار" value={formatToman(data.summary.median)} />
            <Metric label="بیشترین قیمت" value={formatToman(data.summary.highest)} note={data.summary.highestExchange ?? undefined} />
            <Metric label="کمترین قیمت" value={formatToman(data.summary.lowest)} note={data.summary.lowestExchange ?? undefined} />
            <Metric label="اختلاف درصدی بازار" value={formatPercent(data.summary.marketSpreadPercent)} />
            <Metric label="بهترین قیمت خرید" value={formatToman(data.summary.bestBuy)} note={data.summary.bestBuyExchange ?? undefined} />
            <Metric label="بهترین قیمت فروش" value={formatToman(data.summary.bestSell)} note={data.summary.bestSellExchange ?? undefined} />
            <Metric label="منابع فعال" value={formatNumber(data.summary.activeSources, 0)} />
            <Metric label="منابع قطع" value={formatNumber(data.summary.unavailableSources, 0)} />
          </div>
          <Panel
            title="قیمت صرافی‌های داخلی"
            meta={<span className="muted">آخرین بروزرسانی: {formatDate(data.summary.lastUpdated)}</span>}
          >
            <div className="filter-bar">
              <SmartFilter
                asset={asset}
                query={query}
                onAsset={setAsset}
                onQuery={setQuery}
                placeholder="جستجوی نام صرافی..."
                resultLabel={`${rows.length} از ${data.exchanges.length} منبع`}
              />
              <ConnectionSegment value={connection} onChange={setConnection} />
            </div>
            {rows.length ? <DomesticTable rows={rows} /> : <div className="empty">منبعی با این فیلتر یافت نشد</div>}
          </Panel>
          <Panel title="روند قیمت میانه تتر (USDT/IRT)">
            <MedianChart />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

function GlobalExchangeTable({ rows }: { rows: ExchangeOperationalStatus[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>صرافی</th>
            <th>وضعیت API</th>
            <th>واریز</th>
            <th>برداشت</th>
            <th>Maintenance</th>
            <th>آخرین Incident</th>
            <th>اثر روی Dealing Desk</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.exchangeName}>
              <td>
                <strong>{row.exchangeName}</strong>
              </td>
              <td>
                <SourceStatusBadge status={row.apiStatus} title={row.errorMessage} />
              </td>
              <td>{statusLabel(row.depositStatus)}</td>
              <td>{statusLabel(row.withdrawalStatus)}</td>
              <td>{row.maintenance === null ? "—" : row.maintenance ? "بله" : "خیر"}</td>
              <td>{row.lastIncident || "—"}</td>
              <td>{row.impactOnDesk}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExchangeMonitorView() {
  const { data, loading, error, reload, lastUpdated } = useApi<ExchangeMonitorResponse>("/api/exchange-monitor");
  return (
    <>
      <PageHeader title="مانیتور صرافی‌ها" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <Panel title="صرافی‌های داخلی" meta={<span className="muted">میانه بازار: {formatToman(data.tetherSummary.median)}</span>}>
            <DomesticTable rows={data.domestic} />
          </Panel>
          <Panel title="صرافی‌های جهانی">
            <GlobalExchangeTable rows={data.global} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

export function ImpactNewsView() {
  const { data, loading, error, reload, lastUpdated } = useApi<ImpactNewsResponse>("/api/impact-news");
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.items.filter(
      (item) => matchAsset(item.assets, asset) && matchQuery(`${item.title} ${item.source} ${item.impactOnUsdtIrt}`, query)
    );
  }, [data, asset, query]);

  const groups: Array<{ key: string; title: string; items: ImpactNewsItem[] }> = [
    { key: "global", title: "اخبار جهانی", items: filtered.filter((item) => item.group === "global") },
    { key: "iran", title: "اخبار ایران", items: filtered.filter((item) => item.group === "iran") },
    { key: "lp", title: "اتصال به صرافی‌ها (LP)", items: filtered.filter((item) => item.group === "lp") }
  ];
  const nonEmpty = groups.filter((group) => group.items.length > 0);

  return (
    <>
      <PageHeader title="خبرهای اثرگذار" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <SmartFilter
            asset={asset}
            query={query}
            onAsset={setAsset}
            onQuery={setQuery}
            placeholder="جستجو در خبرها..."
            resultLabel={`${filtered.length} از ${data.items.length} خبر`}
          />
          {nonEmpty.length ? (
            <div className="grid news-columns">
              {nonEmpty.map((group) => (
                <Panel key={group.key} title={group.title} meta={<Badge tone="neutral">{group.items.length}</Badge>}>
                  <NewsColumn items={group.items} />
                </Panel>
              ))}
            </div>
          ) : (
            <div className="empty">{data.message || "داده‌ای دریافت نشد"}</div>
          )}
        </div>
      ) : null}
    </>
  );
}

const severityColumns: Array<{ key: Severity; title: string; tone: "danger" | "warn" | "good" }> = [
  { key: "high", title: "هشدار اضطراری (Emergency)", tone: "danger" },
  { key: "medium", title: "هشدار مهم (Important)", tone: "warn" },
  { key: "low", title: "هشدار معمولی (Normal)", tone: "good" }
];

export function AlertsView() {
  const { data, loading, error, reload, lastUpdated } = useApi<AlertsResponse>("/api/alerts");
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.items.filter(
      (item) =>
        matchAsset(item.assets, asset) &&
        matchQuery(`${item.title} ${item.source} ${item.description} ${item.recommendedAction}`, query)
    );
  }, [data, asset, query]);

  return (
    <>
      <PageHeader title="هشدارها" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <SmartFilter
            asset={asset}
            query={query}
            onAsset={setAsset}
            onQuery={setQuery}
            placeholder="جستجو در هشدارها..."
            resultLabel={`${filtered.length} از ${data.items.length} هشدار`}
          />
          <div className="grid alerts-columns">
            {severityColumns.map((col) => {
              const items = filtered.filter((item) => item.severity === col.key);
              return (
                <Panel key={col.key} title={col.title} meta={<Badge tone={col.tone}>{items.length}</Badge>}>
                  <AlertsList items={items} emptyMessage="در این سطح هشداری نیست" />
                </Panel>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
}


const sourceLabels: Record<string, string> = {
  nobitex: "نوبیتکس",
  wallex: "والکس",
  bitpin: "بیت‌پین",
  tabdeal: "تبدیل",
  ramzinex: "رمزینکس",
  abantether: "آبان‌تتر",
  ompfinex: "OMPFinex",
  binance: "Binance",
  kraken: "Kraken",
  okx: "OKX",
  bybit: "Bybit",
  coinbase: "Coinbase",
  news: "خبرها",
  forex: "تقویم فارکس"
};

type ThemeMode = "dark" | "light";

function useTheme(): { theme: ThemeMode; setTheme: (mode: ThemeMode) => void } {
  const [theme, setThemeState] = useState<ThemeMode>("dark");

  useEffect(() => {
    const current = document.documentElement.getAttribute("data-theme");
    setThemeState(current === "light" ? "light" : "dark");
  }, []);

  const setTheme = (mode: ThemeMode) => {
    document.documentElement.setAttribute("data-theme", mode);
    try {
      window.localStorage.setItem("otc-theme", mode);
    } catch {
      /* ignore storage errors */
    }
    setThemeState(mode);
  };

  return { theme, setTheme };
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const options: Array<{ key: ThemeMode; label: string }> = [
    { key: "dark", label: "تیره (Dark)" },
    { key: "light", label: "روشن (Light)" }
  ];
  return (
    <div className="theme-row">
      <div className="segment" role="tablist" aria-label="انتخاب تم">
        {options.map((option) => (
          <button
            key={option.key}
            type="button"
            role="tab"
            aria-selected={theme === option.key}
            className={`segment-item ${theme === option.key ? "active" : ""}`}
            onClick={() => setTheme(option.key)}
          >
            {option.label}
          </button>
        ))}
      </div>
      <span className="muted">حالت پیش‌فرض: تیره (Blue Bank). انتخاب شما ذخیره می‌شود.</span>
    </div>
  );
}

export function SettingsView() {
  const { data, loading, error, reload, lastUpdated } = useApi<PublicSettings>("/api/settings");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [form, setForm] = useState<PublicSettings | null>(null);
  const [openAiApiKey, setOpenAiApiKey] = useState("");
  const [providerKeys, setProviderKeys] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const sources = useMemo(() => Object.keys(form?.enabledSources ?? sourceLabels), [form]);

  async function saveSettings() {
    if (!form) return;
    setSaving(true);
    setSaved(null);
    const nonEmptyProviderKeys = Object.fromEntries(Object.entries(providerKeys).filter(([, value]) => value.trim()));
    const response = await fetch("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...form,
        openAiApiKey: openAiApiKey.trim() || undefined,
        providerApiKeys: nonEmptyProviderKeys
      })
    });
    const next = (await response.json()) as PublicSettings;
    setForm(next);
    setOpenAiApiKey("");
    setProviderKeys({});
    setSaving(false);
    setSaved("تنظیمات ذخیره شد");
  }

  const setNumber = (key: keyof PublicSettings, value: string) => {
    const parsed = Number(value);
    if (!form || !Number.isFinite(parsed)) return;
    setForm({ ...form, [key]: parsed });
  };

  return (
    <>
      <PageHeader title="تنظیمات" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <LoadState loading={loading} error={error} />
      {form ? (
        <div className="grid">
          <Panel title="تم نمایش (Dark / Light)">
            <ThemeToggle />
          </Panel>
          <Panel title="بازه‌های بروزرسانی">
            <div className="grid settings-grid">
              <Field label="قیمت‌های ایران / دقیقه" value={form.priceRefreshMinutes} onChange={(value) => setNumber("priceRefreshMinutes", value)} />
              <Field
                label="بازار جهانی / دقیقه"
                value={form.globalMarketRefreshMinutes}
                onChange={(value) => setNumber("globalMarketRefreshMinutes", value)}
              />
              <Field
                label="صرافی‌های جهانی / دقیقه"
                value={form.globalExchangeRefreshMinutes}
                onChange={(value) => setNumber("globalExchangeRefreshMinutes", value)}
              />
              <Field label="خبرها / دقیقه" value={form.newsRefreshMinutes} onChange={(value) => setNumber("newsRefreshMinutes", value)} />
              <Field
                label="تحلیل هوشمند / دقیقه"
                value={form.intelligenceRefreshMinutes}
                onChange={(value) => setNumber("intelligenceRefreshMinutes", value)}
              />
            </div>
          </Panel>
          <Panel title="آستانه‌ها">
            <div className="grid settings-grid">
              <Field
                label="حد تشخیص قیمت پرت / درصد"
                value={form.outlierThresholdPercent}
                onChange={(value) => setNumber("outlierThresholdPercent", value)}
              />
              <Field
                label="حد هشدار اختلاف قیمت / درصد"
                value={form.marketSpreadAlertThresholdPercent}
                onChange={(value) => setNumber("marketSpreadAlertThresholdPercent", value)}
              />
              <Field
                label="حد هشدار Depeg / درصد"
                value={form.depegAlertThresholdPercent}
                onChange={(value) => setNumber("depegAlertThresholdPercent", value)}
              />
            </div>
          </Panel>
          <Panel title="API Key منابع">
            <div className="grid settings-grid">
              <div className="field">
                <label>OpenAI API Key {form.openAiApiKeyConfigured ? "(ثبت شده)" : ""}</label>
                <input type="password" value={openAiApiKey} onChange={(event) => setOpenAiApiKey(event.target.value)} placeholder="sk-..." />
              </div>
              {Object.keys(sourceLabels)
                .filter((key) => key !== "news")
                .map((key) => (
                  <div className="field" key={key}>
                    <label>
                      {sourceLabels[key]} {form.providerApiKeysConfigured[key] ? "(ثبت شده)" : ""}
                    </label>
                    <input
                      type="password"
                      value={providerKeys[key] ?? ""}
                      onChange={(event) => setProviderKeys({ ...providerKeys, [key]: event.target.value })}
                      placeholder="در صورت نیاز"
                    />
                  </div>
                ))}
            </div>
          </Panel>
          <Panel title="فعال‌سازی منابع">
            <div className="toggle-grid">
              {sources.map((key) => (
                <label className="toggle" key={key}>
                  <span>{sourceLabels[key] ?? key}</span>
                  <input
                    type="checkbox"
                    checked={form.enabledSources[key] !== false}
                    onChange={(event) =>
                      setForm({
                        ...form,
                        enabledSources: { ...form.enabledSources, [key]: event.target.checked }
                      })
                    }
                  />
                </label>
              ))}
            </div>
          </Panel>
          <div className="row-meta">
            <button className="primary-button" onClick={saveSettings} disabled={saving}>
              <Save aria-hidden="true" />
              {saving ? "در حال ذخیره" : "ذخیره"}
            </button>
            {saved ? <Badge tone="good">{saved}</Badge> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

function Field({ label, value, onChange }: { label: string; value: number; onChange: (value: string) => void }) {
  return (
    <div className="field">
      <label>{label}</label>
      <input type="number" min="0.1" step="0.1" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
