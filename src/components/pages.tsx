"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useApi } from "@/hooks/useApi";
import { CalendarClock, Clock, RefreshCw, Save, X } from "lucide-react";
import { ThemeToggleButton } from "@/components/ThemeToggleButton";
import type {
  AlertItem,
  AssetTag,
  DashboardResponse,
  DomesticQuote,
  ExchangeMonitorResponse,
  ExchangeOperationalStatus,
  ForexEvent,
  ForexEventsResponse,
  GlobalPrice,
  ImpactNewsResponse,
  PublicSettings,
  FxPricesApiItem,
  FxPricesApiResponse,
  GoldInstrumentType,
  GoldPricesApiItem,
  GoldPricesApiResponse,
  MedianHistoryResponse,
  QuickDecision,
  Severity,
  TetherMarketResponse
} from "@/lib/types";
import {
  forexImpactLabel,
  forexImpactTone,
  formatCountdown,
  formatDate,
  formatGoldTehran,
  formatNewsTehranTime,
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
import { GoldMarketSummary } from "@/components/GoldMarketSummary";
import { assetLabel } from "@/lib/assets";
import {
  AlertsSkeleton,
  DashboardSkeleton,
  ExchangeMonitorSkeleton,
  ForexSkeleton,
  GoldSkeleton,
  SectionExchangeCardsSkeleton,
  SectionGoldPanelSkeleton,
  SettingsSkeleton,
  TetherMarketSkeleton
} from "@/components/skeletons";

// Heavy chart bundles — load after first paint (same UI, deferred JS)
const MedianChart = dynamic(
  () => import("@/components/MedianChart").then((m) => ({ default: m.MedianChart })),
  {
    ssr: false,
    loading: () => (
      <div className="sk-chart" aria-busy="true" aria-live="polite">
        <span className="sr-only">بارگذاری نمودار</span>
        <div className="sk-chart-area sk-block" style={{ minHeight: 220 }} aria-hidden="true" />
      </div>
    )
  }
);

const DashboardMedianChart = dynamic(
  () => import("@/components/MedianChart").then((m) => ({ default: m.MedianChart })),
  {
    ssr: false,
    loading: () => (
      <div className="sk-chart" aria-busy="true" aria-live="polite">
        <span className="sr-only">بارگذاری نمودار</span>
        <div className="sk-chart-area sk-block" style={{ minHeight: 460 }} aria-hidden="true" />
      </div>
    )
  }
);
const GoldPriceChart = dynamic(
  () => import("@/components/GoldPriceChart").then((m) => ({ default: m.GoldPriceChart })),
  {
    ssr: false,
    loading: () => (
      <div className="sk-chart" aria-busy="true" aria-live="polite">
        <span className="sr-only">بارگذاری نمودار</span>
        <div className="sk-chart-area sk-block" style={{ minHeight: 260 }} aria-hidden="true" />
      </div>
    )
  }
);

type AlertsResponse = { items: AlertItem[] };

// ---- Timing & display limits (single source of truth) ----
const DASHBOARD_REFRESH_MS = 60_000;
/** Impact News ticker poll (same API as impact-news page). */
const NEWS_REFRESH_MS = 90_000;
const CLOCK_TICK_MS = 1_000;
const WIDGET_TICK_MS = 30_000;
const TOAST_TTL_MS = 9_000;
const MAX_TOASTS = 5;
const TICKER_MAX_ITEMS = 12;
const FOREX_LOOKBACK_MS = 2 * 60 * 60 * 1_000;

const clockDateFmt = new Intl.DateTimeFormat("fa-IR", { weekday: "short", year: "numeric", month: "2-digit", day: "2-digit" });
const clockTimeFmt = new Intl.DateTimeFormat("fa-IR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/* ============================================================
 * Reusable primitives
 * ========================================================== */
function PageHeader({
  title,
  onRefresh,
  lastUpdated,
  lastUpdatedDisplay,
  loading = false
}: {
  title: string;
  onRefresh?: () => void;
  lastUpdated?: number | null;
  lastUpdatedDisplay?: string | null;
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
          آخرین بروزرسانی:{" "}
          <span className="number">
            {lastUpdatedDisplay ?? (lastUpdated ? clockTimeFmt.format(lastUpdated) : "—")}
          </span>
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
        <ThemeToggleButton />
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
  children,
  className
}: {
  title: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className ? `panel ${className}` : "panel"}>
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

/** Trading-terminal price flash: remembers the previous value and reports up/down for a short window. */
const PRICE_FLASH_MS = 1_600;

function usePriceDirection(value: number | null) {
  const prevRef = useRef<number | null>(null);
  const [direction, setDirection] = useState<"up" | "down" | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = value;
    if (prev === null || value === null || value === prev) return;
    setDirection(value > prev ? "up" : "down");
    const id = setTimeout(() => setDirection(null), PRICE_FLASH_MS);
    return () => clearTimeout(id);
  }, [value]);

  return direction;
}

const PriceValue = memo(function PriceValue({ value, className = "" }: { value: number | null; className?: string }) {
  const direction = usePriceDirection(value);
  return (
    <span className={`price-value ${direction ? `flash-${direction}` : ""} ${className}`.trim()}>
      {value === null ? "—" : formatToman(value)}
    </span>
  );
});


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
    // Same filtered Impact News dataset: only fresh medium/high (no low fallback).
    const all = data?.items ?? [];
    const important = all.filter((item) => item.severity === "high" || item.severity === "medium");
    const seen = new Set<string>();
    const unique: typeof important = [];
    for (const item of important) {
      const key = item.id || item.translatedTitle;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(item);
    }
    return unique.slice(0, TICKER_MAX_ITEMS);
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
                <span className="ticker-text">{item.translatedTitle}</span>
                {item.publishedAt ? (
                  <span className="ticker-time">{formatNewsTehranTime(item.publishedAt)}</span>
                ) : null}
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

/** Tolerance when picking nearest median sample to ~24h ago (must not invent points). */
const MEDIAN_24H_TOLERANCE_MS = 2 * 60 * 60_000;
const ONE_DAY_MS = 24 * 60 * 60_000;

type Median24hDelta = {
  current: number;
  past: number;
  changeAmount: number;
  changePercent: number;
  pastAt: string;
};

function pickMedian24hDelta(
  currentMedian: number | null,
  points: Array<{ t: string; v: number }>
): Median24hDelta | null {
  if (currentMedian === null || !Number.isFinite(currentMedian) || currentMedian <= 0) return null;
  if (!points.length) return null;

  const target = Date.now() - ONE_DAY_MS;
  let best: { t: number; v: number; dist: number } | null = null;

  for (const p of points) {
    const t = Date.parse(p.t);
    if (!Number.isFinite(t) || !Number.isFinite(p.v) || p.v <= 0) continue;
    const dist = Math.abs(t - target);
    if (dist > MEDIAN_24H_TOLERANCE_MS) continue;
    if (!best || dist < best.dist) best = { t, v: p.v, dist };
  }

  if (!best || best.v === 0) return null;

  const changeAmount = currentMedian - best.v;
  const changePercent = (changeAmount / best.v) * 100;
  if (!Number.isFinite(changeAmount) || !Number.isFinite(changePercent)) return null;

  return {
    current: currentMedian,
    past: best.v,
    changeAmount,
    changePercent,
    pastAt: new Date(best.t).toISOString()
  };
}

function Median24hIndicator({ currentMedian }: { currentMedian: number | null }) {
  // Same history store as the median chart (`/api/median-history?range=24h`).
  const { data } = useApi<MedianHistoryResponse>("/api/median-history?range=24h", 60_000);

  const delta = useMemo(
    () => pickMedian24hDelta(currentMedian, data?.points ?? []),
    [currentMedian, data?.points]
  );

  if (!data) {
    return <span className="state-pill cockpit-24h-pill muted">در حال دریافت تغییر ۲۴ساعته…</span>;
  }

  if (!delta) {
    return <span className="state-pill cockpit-24h-pill muted">تغییر ۲۴ساعته در دسترس نیست</span>;
  }

  const absPct = Math.abs(delta.changePercent);
  const zero = absPct < 0.005; // treat sub-0.005% as flat
  const up = delta.changePercent > 0;
  const tone = zero ? "neutral" : up ? "good" : "danger";
  const arrow = zero ? "" : up ? "▲ " : "▼ ";
  const label = zero
    ? "بدون تغییر در ۲۴ ساعت گذشته"
    : `${arrow}${formatNumber(absPct, 2)}٪ در ۲۴ ساعت گذشته`;

  const tooltip = [
    `میانه فعلی: ${formatToman(delta.current)}`,
    `میانه ≈۲۴س پیش: ${formatToman(delta.past)}`,
    `اختلاف: ${formatToman(delta.changeAmount)}`,
    `درصد: ${formatPercent(delta.changePercent)}`,
    `نقطه مقایسه: ${formatDate(delta.pastAt)}`
  ].join("\n");

  return (
    <span
      className={`state-pill cockpit-24h-pill ${tone}`}
      title={tooltip}
      aria-label={tooltip.replace(/\n/g, " · ")}
    >
      {label}
    </span>
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
          <div className="cockpit-hero-value number">
            <PriceValue value={quickDecision.median} />
          </div>
          <div className="cockpit-hero-sub">
            اختلاف بازار بین صرافی‌ها: {formatPercent(quickDecision.spreadPercent)}
          </div>
        </div>
        <div className="cockpit-hero-pills">
          <span className={`state-pill sm ${marketStateTone(marketState)}`}>
            وضعیت بازار: {marketStateLabel(marketState)}
          </span>
          <Median24hIndicator currentMedian={quickDecision.median} />
        </div>
      </div>

      <div className="grid answer-grid">
        {/* اختلاف قیمت خرید */}
        {(() => {
          const s = quickDecision.buySpread;
          const hasData = s.best.price != null && s.worst.price != null;
          return (
            <div className="answer-stat answer-stat-spread">
              <div className="answer-spread-title">اختلاف قیمت خرید</div>
              {hasData ? (
                <>
                  <div className="answer-spread-best number">
                    بهترین: {s.best.exchange ?? "—"} — <PriceValue value={s.best.price} />
                  </div>
                  <div className="answer-spread-worst number">
                    بدترین: {s.worst.exchange ?? "—"} — <PriceValue value={s.worst.price} />
                  </div>
                  <div className="answer-spread-diff number">
                    اختلاف: {s.percent != null ? s.percent.toFixed(2) : "—"}٪
                  </div>
                </>
              ) : (
                <div className="answer-spread-empty">داده کافی برای مقایسه وجود ندارد</div>
              )}
            </div>
          );
        })()}

        {/* اختلاف قیمت فروش */}
        {(() => {
          const s = quickDecision.sellSpread;
          const hasData = s.best.price != null && s.worst.price != null;
          return (
            <div className="answer-stat answer-stat-spread">
              <div className="answer-spread-title">اختلاف قیمت فروش</div>
              {hasData ? (
                <>
                  <div className="answer-spread-best number">
                    بهترین: {s.best.exchange ?? "—"} — <PriceValue value={s.best.price} />
                  </div>
                  <div className="answer-spread-worst number">
                    بدترین: {s.worst.exchange ?? "—"} — <PriceValue value={s.worst.price} />
                  </div>
                  <div className="answer-spread-diff number">
                    اختلاف: {s.percent != null ? s.percent.toFixed(2) : "—"}٪
                  </div>
                </>
              ) : (
                <div className="answer-spread-empty">داده کافی برای مقایسه وجود ندارد</div>
              )}
            </div>
          );
        })()}
      </div>

      <DashboardMarketPriceStrip />
    </section>
  );
}

const FRESH_PRICE_MS = 15 * 60_000;
const MAX_STALE_PRICE_MS = 6 * 60 * 60_000;

type MarketPriceTone = "good" | "warn" | "danger";

type MarketLowestCard = {
  key: string;
  title: string;
  price: number | null;
  sourceName: string | null;
  tone: MarketPriceTone;
};

function comparablePositivePrice(buy: number | null, sell: number | null, mid: number | null): number | null {
  if (mid !== null && Number.isFinite(mid) && mid > 0) return mid;
  if (
    buy !== null &&
    sell !== null &&
    Number.isFinite(buy) &&
    Number.isFinite(sell) &&
    buy > 0 &&
    sell > 0
  ) {
    return (buy + sell) / 2;
  }
  const single = buy ?? sell;
  if (single !== null && Number.isFinite(single) && single > 0) return single;
  return null;
}

function priceAgeMs(lastUpdated: string | null | undefined): number | null {
  if (!lastUpdated) return null;
  const t = Date.parse(lastUpdated);
  if (!Number.isFinite(t)) return null;
  return Date.now() - t;
}

function isAcceptableAge(ageMs: number | null): boolean {
  if (ageMs === null) return true; // missing timestamp: still allow if source status ok
  if (ageMs < 0) return true;
  return ageMs <= MAX_STALE_PRICE_MS;
}

function toneFromAge(ageMs: number | null, hasPrice: boolean): MarketPriceTone {
  if (!hasPrice) return "danger";
  if (ageMs === null) return "warn";
  if (ageMs <= FRESH_PRICE_MS) return "good";
  if (ageMs <= MAX_STALE_PRICE_MS) return "warn";
  return "danger";
}

function pickLowestFromCandidates(
  candidates: Array<{ price: number; sourceName: string; lastUpdated: string | null }>
): { price: number; sourceName: string; tone: MarketPriceTone } | null {
  const valid = candidates.filter(
    (c) => Number.isFinite(c.price) && c.price > 0 && isAcceptableAge(priceAgeMs(c.lastUpdated))
  );
  if (!valid.length) return null;
  let best = valid[0]!;
  for (const c of valid) {
    if (c.price < best.price) best = c;
  }
  const age = priceAgeMs(best.lastUpdated);
  return { price: best.price, sourceName: best.sourceName, tone: toneFromAge(age, true) };
}

function DashboardMarketPriceStrip() {
  // Same endpoints + interval as SitePrices / GoldMarketPanel — useApi dedupes concurrent client fetches.
  const { data: gold } = useApi<GoldPricesApiResponse>("/api/gold-prices", 30_000);
  const { data: fx } = useApi<FxPricesApiResponse>("/api/fx-prices", 30_000);

  const cards = useMemo((): MarketLowestCard[] => {
    const goldItems = gold?.items ?? [];
    const fxItems = fx?.items ?? [];

    const goldInstrumentCandidates = (instrument: GoldInstrumentType) =>
      goldItems
        .filter(
          (item) =>
            item.instrument === instrument &&
            item.unit === "toman" &&
            item.status === "ok"
        )
        .map((item) => {
          const price = comparablePositivePrice(item.buy, item.sell, item.mid);
          if (price === null) return null;
          return {
            price,
            sourceName: sourceLabels[item.source] ?? item.source,
            lastUpdated: item.lastUpdated || null
          };
        })
        .filter((entry): entry is { price: number; sourceName: string; lastUpdated: string | null } => Boolean(entry));

    const fxAssetCandidates = (assets: FxPricesApiItem["asset"][]) =>
      fxItems
        .filter((item) => assets.includes(item.asset) && item.status === "ok")
        .map((item) => {
          const price = comparablePositivePrice(item.buy, item.sell, item.mid);
          if (price === null) return null;
          return {
            price,
            sourceName: sourceLabels[item.source] ?? item.source,
            lastUpdated: item.lastUpdated || null
          };
        })
        .filter((entry): entry is { price: number; sourceName: string; lastUpdated: string | null } => Boolean(entry));

    const specs: Array<{ key: string; title: string; pick: ReturnType<typeof pickLowestFromCandidates> }> = [
      {
        key: "gold18",
        title: "قیمت طلای ۱۸ عیار",
        pick: pickLowestFromCandidates(goldInstrumentCandidates("یک گرم طلای 18 عیار"))
      },
      {
        key: "emami",
        title: "قیمت سکه امامی",
        pick: pickLowestFromCandidates(goldInstrumentCandidates("سکه طرح امامی"))
      },
      {
        key: "usd-paper",
        title: "قیمت دلار کاغذی",
        // بن‌بست labels دلار کاغذی as دلار بن‌بست on the wire
        pick: pickLowestFromCandidates(fxAssetCandidates(["دلار کاغذی", "دلار بن‌بست"]))
      },
      {
        key: "aed",
        title: "قیمت درهم امارات",
        pick: pickLowestFromCandidates(fxAssetCandidates(["درهم امارات"]))
      }
    ];

    return specs.map((spec) => ({
      key: spec.key,
      title: spec.title,
      price: spec.pick?.price ?? null,
      sourceName: spec.pick?.sourceName ?? null,
      tone: spec.pick?.tone ?? "danger"
    }));
  }, [gold?.items, fx?.items]);

  return (
    <div className="grid decision-grid compact market-price-grid" aria-label="قیمت‌های مرجع بازار">
      {cards.map((card) => (
        <div className="decision-card compact market-price-card" key={card.key}>
          <div className="market-price-card-inner">
            <div className="market-price-title-row">
              <span className={`mini-dot ${card.tone}`} aria-hidden="true" />
              <span className="market-price-title">{card.title}</span>
            </div>
            <div className="market-price-value number">
              {card.price !== null ? formatToman(card.price) : "داده در دسترس نیست"}
            </div>
            <div className="market-price-source muted">
              {card.sourceName ? `منبع: ${card.sourceName}` : "منبع: —"}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function LoadState({
  loading,
  error,
  hasData = false,
  skeleton
}: {
  loading: boolean;
  error: string | null;
  hasData?: boolean;
  /** Page-specific skeleton matching the loaded layout (no generic spinner page). */
  skeleton?: React.ReactNode;
}) {
  // Keep previous content visible while refreshing; only skeleton on first load
  if (loading && !hasData) {
    return skeleton ? (
      <>{skeleton}</>
    ) : (
      <div className="loading" aria-busy="true">
        در حال دریافت داده...
      </div>
    );
  }
  if (error && !hasData) return <div className="empty">داده‌ای دریافت نشد: {error}</div>;
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
  // Reference-only: valid mid, no separate public bid/ask (e.g. Tetherland / OK-EX OTC)
  const referenceOnly =
    !down && row.midPrice !== null && row.buyPrice === null && row.sellPrice === null;
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
            <PriceValue value={row.buyPrice} className="exch-v number" />
          </div>
          <div className="exch-row">
            <span className="exch-k">فروش</span>
            <PriceValue value={row.sellPrice} className="exch-v number" />
          </div>
          <div className="exch-row mid">
            <span className="exch-k">{referenceOnly ? "قیمت مرجع" : "قیمت وسط"}</span>
            <PriceValue value={row.midPrice} className="exch-v number" />
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

function isExecutableBuySell(row: DomesticQuote): boolean {
  return (
    row.buyPrice !== null &&
    row.sellPrice !== null &&
    Number.isFinite(row.buyPrice) &&
    Number.isFinite(row.sellPrice) &&
    row.buyPrice > 0 &&
    row.sellPrice > 0
  );
}

function isValidReferencePrice(row: DomesticQuote): boolean {
  return row.midPrice !== null && Number.isFinite(row.midPrice) && row.midPrice > 0;
}

/**
 * Display tiers for Iranian exchange cards (Dashboard only):
 * 0 healthy (buy+sell), 1 degraded/reference-only, 2 unavailable.
 * Within a tier, original API/config order is preserved (stable).
 */
function exchangeCardTier(row: DomesticQuote): 0 | 1 | 2 {
  if (row.sourceStatus === "unavailable") return 2;
  if (isExecutableBuySell(row)) return 0;
  if (isValidReferencePrice(row) || row.sourceStatus === "degraded") return 1;
  return 2;
}

function DashboardExchangeCards({
  rows,
  summary
}: {
  rows: DomesticQuote[];
  summary: TetherMarketResponse["summary"];
}) {
  const ordered = useMemo(() => {
    return rows
      .map((row, index) => ({ row, index }))
      .sort((a, b) => {
        const tierDiff = exchangeCardTier(a.row) - exchangeCardTier(b.row);
        if (tierDiff !== 0) return tierDiff;
        return a.index - b.index;
      })
      .map((entry) => entry.row);
  }, [rows]);

  return (
    <div className="exch-grid">
      {ordered.map((row) => {
        const executable = isExecutableBuySell(row) && row.sourceStatus !== "unavailable";
        return (
          <ExchangeCard
            key={row.exchangeId}
            row={row}
            isBestBuy={executable && summary.bestBuyExchange === row.exchangeName}
            isBestSell={executable && summary.bestSellExchange === row.exchangeName}
          />
        );
      })}
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

/** Fixed RTL visual order (right → left): BTC, ETH, USDT/USD */
const GLOBAL_SYMBOL_ORDER: GlobalPrice["symbol"][] = ["BTC/USDT", "ETH/USDT", "USDT/USD"];

function GlobalMetricGrid({ rows }: { rows: GlobalPrice[] }) {
  const ordered = useMemo(() => {
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    return GLOBAL_SYMBOL_ORDER.map((symbol) => bySymbol.get(symbol)).filter(
      (row): row is GlobalPrice => Boolean(row)
    );
  }, [rows]);

  return (
    <div className="grid global-metrics global-metrics-row">
      {ordered.map((row) => (
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
    if (!forex || !Array.isArray(forex.events)) return [];
    return forex.events
      .filter((event) => {
        if (!event || !event.id) return false;
        if (!event.date) return true;
        const time = new Date(event.date).getTime();
        // keep upcoming events and ones released within the last lookback window
        return !Number.isFinite(time) || now - time < FOREX_LOOKBACK_MS;
      })
      .slice(0, limit);
  }, [forex, now, limit]);

  if (!forex || !Array.isArray(forex.events) || !forex.events.length) {
    return <div className="empty">{(forex && forex.message) || "داده‌ای دریافت نشد"}</div>;
  }
  if (!events.length) {
    return <div className="empty">رویداد پیش‌روی مهمی در تقویم این هفته باقی نمانده است</div>;
  }

  return (
    <div className="forex-grid">
      {events.map((event: ForexEvent, idx: number) => {
        if (!event || !event.id) return null;
        const tone = forexImpactTone(event.impact);
        const countdown = formatCountdown(event.date, now, !!event.actual);
        return (
          <article className={`forex-card ${tone} ${countdown.state}`} key={event.id || idx}>
            <div className="forex-top">
              <span className="forex-cat">{event.category}</span>
              <Badge tone={tone}>{forexImpactLabel(event.impact)}</Badge>
            </div>
            <div className="forex-title">
              {event.title} <span className="forex-country">{event.country}</span>
              {event.link && (
                <a href={event.link} target="_blank" rel="noopener noreferrer" className="ml-1 text-[9px] underline text-muted">منبع</a>
              )}
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
                {event.actualComparison && (
                  <span className="ml-1 text-[10px] text-muted">({event.actualComparison})</span>
                )}
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

export function GoldMarketView() {
  const { data, loading, error, reload, lastUpdated } = useApi<GoldPricesApiResponse>("/api/gold-prices", 30_000);
  const [instrument, setInstrument] = useState<GoldInstrumentType>("اونس طلا به دلار");
  const cards = useMemo(
    () =>
      (data?.items ?? [])
        .filter(isValidGoldPrice)
        .sort(
          (a, b) =>
            goldInstrumentOrder[a.instrument] - goldInstrumentOrder[b.instrument] ||
            goldSourceOrder[a.source] - goldSourceOrder[b.source]
        ),
    [data?.items]
  );
  const summaryInstrument = useMemo(() => {
    const hasSelected = cards.some((item) => item.instrument === instrument);
    if (hasSelected) return instrument;
    return cards[0]?.instrument ?? instrument;
  }, [cards, instrument]);
  const metaParts = cards.length
    ? [data?.lastUpdated ? `به‌روزرسانی: ${formatGoldTehran(data.lastUpdated)}` : "", ...(data?.notes ?? [])].filter(Boolean)
    : [];
  const meta = metaParts.join(" · ");

  return (
    <>
      <PageHeader
        title="بازار طلا"
        onRefresh={reload}
        lastUpdated={lastUpdated}
        lastUpdatedDisplay={data?.lastUpdated ? formatGoldTehran(data.lastUpdated) : null}
        loading={loading}
      />
      <LoadState loading={loading} error={error} hasData={Boolean(data)} skeleton={<GoldSkeleton />} />
      {data ? (
        <div className="grid gold-page" data-layout-version="gold-cols-v2">
          {!cards.length ? (
            <Panel title="قیمت‌های بازار طلا" meta={meta ? <span className="muted">{meta}</span> : undefined}>
              <div className="empty">فعلاً داده‌ای از بازار طلا دریافت نشد</div>
            </Panel>
          ) : (
            <Panel title="قیمت‌های بازار طلا" meta={meta ? <span className="muted">{meta}</span> : undefined}>
              <div className="gold-summary-and-cards">
                <div className="gold-summary-col">
                  <GoldMarketSummary items={cards} instrument={summaryInstrument} />
                </div>
                <div className="gold-prices-col">
                  <GoldMarketCards items={cards} />
                </div>
              </div>
              <GoldPriceChart instrument={summaryInstrument} onInstrumentChange={setInstrument} />
            </Panel>
          )}
        </div>
      ) : null}
    </>
  );
}

export function ForexView() {
  const { data, loading, error, reload, lastUpdated } = useApi<ForexEventsResponse>("/api/forex", 60_000);
  if (loading && !data) {
    return (
      <>
        <PageHeader title="فارکس" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
        <ForexSkeleton />
      </>
    );
  }
  if (!data || !Array.isArray(data.events)) {
    return (
      <>
        <PageHeader title="فارکس" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
        <LoadState loading={false} error={error} hasData={false} />
        <div className="empty">داده‌های فارکس در دسترس نیست</div>
      </>
    );
  }
  return (
    <>
      <PageHeader title="فارکس" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
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
    </>
  );
}

/** Fixed Dashboard «قیمت‌های سایت» order — never sort by price/status/time. */
const SITE_PRICE_SLOTS: Array<{
  source: FxPricesApiItem["source"];
  asset: FxPricesApiItem["asset"];
  title: string;
}> = [
  { source: "navasan", asset: "دلار کاغذی", title: "دلار کاغذی · نوسان" },
  { source: "bonbast", asset: "دلار بن‌بست", title: "دلار کاغذی · بن‌بست" },
  { source: "navasan", asset: "دلار آمریکا هرات", title: "دلار آمریکا هرات · نوسان" },
  { source: "navasan", asset: "دلار نقدی", title: "دلار نقدی · نوسان" },
  // Row 2 (RTL right→left): فردایی, سبزه, درهم ن, درهم ب
  { source: "navasan", asset: "دلار فردایی", title: "دلار فردایی · نوسان" },
  { source: "navasan", asset: "دلار سبزه میدان", title: "دلار سبزه میدان · نوسان" },
  { source: "navasan", asset: "درهم امارات", title: "درهم امارات · نوسان" },
  { source: "bonbast", asset: "درهم امارات", title: "درهم امارات · بن‌بست" }
];

function isValidSitePrice(item: FxPricesApiItem): boolean {
  const buyOk = item.buy !== null && Number.isFinite(item.buy) && item.buy > 0;
  const sellOk = item.sell !== null && Number.isFinite(item.sell) && item.sell > 0;
  const midOk = item.mid !== null && Number.isFinite(item.mid) && item.mid > 0;
  return item.status === "ok" && (buyOk || sellOk || midOk);
}

const goldInstrumentOrder: Record<GoldInstrumentType, number> = {
  "اونس طلا به دلار": 0,
  "یک گرم طلای 18 عیار": 1,
  "سکه طرح امامی": 2,
  "مثقال طلای آبشده": 3
};

const goldSourceOrder: Record<GoldPricesApiItem["source"], number> = {
  navasan: 0,
  bonbast: 1,
  talavest: 2
};

function isValidGoldPrice(item: GoldPricesApiItem): boolean {
  return item.status === "ok" && (item.buy !== null || item.sell !== null || item.mid !== null);
}

function GoldPriceValue({ item, value, className }: { item: GoldPricesApiItem; value: number | null; className?: string }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className={className}>—</span>;
  }
  return <span className={className}>{item.unit === "usd_oz" ? formatUsd(value) : formatToman(value)}</span>;
}

function GoldMarketCard({ quote }: { quote: GoldPricesApiItem }) {
  const sourceLabel = sourceLabels[quote.source] ?? quote.source;
  const hasBuySell = quote.buy !== null || quote.sell !== null;
  const singlePrice = quote.mid !== null && !hasBuySell;

  return (
    <article className="exch-card gold-source-card">
      <header className="exch-card-head">
        <span className="exch-name">{sourceLabel}</span>
        <Badge tone="good">فعال</Badge>
      </header>
      <div className="exch-prices">
        {quote.buy !== null ? (
          <div className="exch-row">
            <span className="exch-k">خرید</span>
            <GoldPriceValue item={quote} value={quote.buy} className="exch-v number" />
          </div>
        ) : null}
        {quote.sell !== null ? (
          <div className="exch-row">
            <span className="exch-k">فروش</span>
            <GoldPriceValue item={quote} value={quote.sell} className="exch-v number" />
          </div>
        ) : null}
        {singlePrice ? (
          <div className="exch-row mid">
            <span className="exch-k">قیمت</span>
            <GoldPriceValue item={quote} value={quote.mid} className="exch-v number" />
          </div>
        ) : quote.mid !== null ? (
          <div className="exch-row mid">
            <span className="exch-k">قیمت وسط</span>
            <GoldPriceValue item={quote} value={quote.mid} className="exch-v number" />
          </div>
        ) : null}
        {quote.lastUpdated ? <div className="tg-meta muted">{formatGoldTehran(quote.lastUpdated)}</div> : null}
      </div>
    </article>
  );
}

function GoldMarketCards({ items }: { items: GoldPricesApiItem[] }) {
  const groups = useMemo(() => {
    const byInstrument = new Map<GoldInstrumentType, GoldPricesApiItem[]>();
    for (const item of items) {
      const list = byInstrument.get(item.instrument) ?? [];
      list.push(item);
      byInstrument.set(item.instrument, list);
    }
    return [...byInstrument.entries()]
      .sort(([a], [b]) => goldInstrumentOrder[a] - goldInstrumentOrder[b])
      .map(([instrument, cards]) => ({
        instrument,
        cards: cards.sort((a, b) => goldSourceOrder[a.source] - goldSourceOrder[b.source])
      }));
  }, [items]);

  return (
    <div className="gold-groups">
      {groups.map((group) => (
        <section className="gold-group" key={group.instrument}>
          <h3 className="gold-group-title">{group.instrument}</h3>
          <div className="gold-group-grid">
            {group.cards.map((quote) => (
              <GoldMarketCard key={`${quote.source}-${quote.instrument}`} quote={quote} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function GoldMarketPanel({ title = "بازار طلا" }: { title?: string }) {
  const { data: gold, loading } = useApi<GoldPricesApiResponse>("/api/gold-prices", 30_000);
  const cards = useMemo(
    () =>
      (gold?.items ?? [])
        .filter(isValidGoldPrice)
        .sort(
          (a, b) =>
            goldInstrumentOrder[a.instrument] - goldInstrumentOrder[b.instrument] ||
            goldSourceOrder[a.source] - goldSourceOrder[b.source]
        ),
    [gold?.items]
  );
  const metaParts = cards.length
    ? [gold?.lastUpdated ? `به‌روزرسانی: ${formatGoldTehran(gold.lastUpdated)}` : "", ...(gold?.notes ?? [])].filter(Boolean)
    : [];
  const meta = metaParts.join(" · ");

  return (
    <Panel title={title} meta={meta ? <span className="muted">{meta}</span> : undefined}>
      {loading && !gold ? (
        <SectionGoldPanelSkeleton />
      ) : !cards.length ? (
        <div className="empty">فعلاً داده‌ای از بازار طلا دریافت نشد</div>
      ) : (
        <>
          <GoldMarketCards items={cards} />
          <GoldPriceChart />
        </>
      )}
    </Panel>
  );
}

function SitePrices() {
  const { data: fx, loading } = useApi<FxPricesApiResponse>("/api/fx-prices", 30_000);

  const slotCards = useMemo(() => {
    const byKey = new Map<string, FxPricesApiItem>();
    for (const item of fx?.items ?? []) {
      if (!isValidSitePrice(item)) continue;
      byKey.set(`${item.source}:${item.asset}`, item);
    }
    return SITE_PRICE_SLOTS.map((slot) => ({
      slot,
      quote: byKey.get(`${slot.source}:${slot.asset}`) ?? null
    }));
  }, [fx?.items]);

  const hasAny = slotCards.some((entry) => entry.quote);
  const metaParts = hasAny
    ? [fx?.lastUpdated ? `به‌روزرسانی: ${formatDate(fx.lastUpdated)}` : "", ...(fx?.notes ?? [])].filter(Boolean)
    : [];
  const meta = metaParts.join(" · ");

  return (
    <Panel title="قیمت‌های سایت" meta={meta ? <span className="muted">{meta}</span> : undefined}>
      {loading && !fx ? (
        <SectionExchangeCardsSkeleton count={8} />
      ) : !hasAny ? (
        <div className="empty">فعلاً داده‌ای از منابع سایت دریافت نشد</div>
      ) : (
        <div className="exch-grid">
          {slotCards.map(({ slot, quote }) => {
            const hasBuy = quote?.buy != null && Number.isFinite(quote.buy) && quote.buy > 0;
            const hasSell = quote?.sell != null && Number.isFinite(quote.sell) && quote.sell > 0;
            const hasMid = quote?.mid != null && Number.isFinite(quote.mid) && quote.mid > 0;
            const referenceOnly = Boolean(quote && hasMid && !hasBuy && !hasSell);
            const down = !quote;

            return (
              <article
                className={`exch-card ${down ? "is-empty" : ""}`}
                key={`${slot.source}-${slot.asset}`}
              >
                <header className="exch-card-head">
                  <span className="exch-name">{slot.title}</span>
                  <Badge tone={down ? "danger" : "good"}>{down ? "قطع" : "فعال"}</Badge>
                </header>
                {down ? (
                  <div className="exch-empty-label">داده ندارد</div>
                ) : referenceOnly ? (
                  <div className="exch-prices">
                    <div className="exch-row mid">
                      <span className="exch-k">قیمت مرجع</span>
                      <PriceValue value={quote!.mid} className="exch-v number" />
                    </div>
                    {quote!.lastUpdated ? (
                      <div className="tg-meta muted">{formatDate(quote!.lastUpdated)}</div>
                    ) : null}
                  </div>
                ) : (
                  <div className="exch-prices">
                    <div className="exch-row">
                      <span className="exch-k">خرید</span>
                      <PriceValue value={hasBuy ? quote!.buy : null} className="exch-v number" />
                    </div>
                    <div className="exch-row">
                      <span className="exch-k">فروش</span>
                      <PriceValue value={hasSell ? quote!.sell : null} className="exch-v number" />
                    </div>
                    <div className="exch-row mid">
                      <span className="exch-k">قیمت وسط</span>
                      <PriceValue value={hasMid ? quote!.mid : null} className="exch-v number" />
                    </div>
                    {quote!.lastUpdated ? (
                      <div className="tg-meta muted">{formatDate(quote!.lastUpdated)}</div>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </Panel>
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
      <LoadState loading={loading} error={error} hasData={Boolean(data)} skeleton={<DashboardSkeleton />} />
      {data ? (
        <div className="grid">
          <QuickDecisionCockpit quickDecision={data.quickDecision} marketState={data.marketState} />
          <Panel
            title="صرافی‌های ایران (USDT/IRT)"
            meta={<span className="muted">به‌روزرسانی: {formatDate(data.tetherMarket.summary.lastUpdated)}</span>}
          >
            <DashboardExchangeCards rows={data.tetherMarket.exchanges} summary={data.tetherMarket.summary} />
          </Panel>
          <SitePrices />
          <Panel title="بازار جهانی">
            <GlobalMetricGrid rows={data.globalMarket} />
          </Panel>
          <Panel title="روند قیمت میانه تتر (USDT/IRT)" className="dashboard-median-panel">
            <DashboardMedianChart tall />
          </Panel>
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
  const { data, loading, error, reload, lastUpdated } = useApi<TetherMarketResponse>("/api/tether-market", 60_000);
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

  const marketHighest = data ? data.summary.highest : null;
  const marketLowest = data ? data.summary.lowest : null;
  const marketDiffToman = (marketHighest != null && marketLowest != null) ? marketHighest - marketLowest : null;
  const marketHighEx = data ? data.summary.highestExchange : null;
  const marketLowEx = data ? data.summary.lowestExchange : null;
  const hasEnoughMarketData = marketDiffToman != null && marketDiffToman > 0 && marketHighEx && marketLowEx;

  return (
    <>
      <PageHeader title="بازار تتر ایران" onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <LoadState loading={loading} error={error} hasData={Boolean(data)} skeleton={<TetherMarketSkeleton />} />
      {data ? (
        <div className="grid">
          <div className="grid metrics">
            <Metric label="Median بازار" value={formatToman(data.summary.median)} />
            <Metric label="بیشترین قیمت" value={formatToman(data.summary.highest)} note={data.summary.highestExchange ?? undefined} />
            <Metric label="کمترین قیمت" value={formatToman(data.summary.lowest)} note={data.summary.lowestExchange ?? undefined} />
            {hasEnoughMarketData ? (
              <div className="metric">
                <div className="metric-label">اختلاف تومانی بازار</div>
                <div className="metric-value">{formatToman(marketDiffToman)}</div>
                <div className="metric-note">{marketHighEx} ↔ {marketLowEx}</div>
                <div className="metric-note">بالاترین: {marketHighEx} — {formatToman(marketHighest)}</div>
                <div className="metric-note">پایین‌ترین: {marketLowEx} — {formatToman(marketLowest)}</div>
              </div>
            ) : (
              <div className="metric">
                <div className="metric-label">اختلاف تومانی بازار</div>
                <div className="metric-note">داده کافی برای مقایسه وجود ندارد</div>
              </div>
            )}
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
      <LoadState
        loading={loading}
        error={error}
        hasData={Boolean(data)}
        skeleton={<ExchangeMonitorSkeleton />}
      />
      {data ? (
        <div className="grid">
          <Panel title="صرافی‌های داخلی" meta={<span className="muted">میانه بازار: {formatToman(data.tetherSummary.median)}</span>}>
            <DomesticTable rows={data.domestic} />
          </Panel>
          <Panel title="صرافی‌های جهانی">
            <GlobalExchangeTable rows={data.global} />
          </Panel>
          <GoldMarketPanel title="بازار طلا" />
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
      <LoadState loading={loading} error={error} hasData={Boolean(data)} skeleton={<AlertsSkeleton />} />
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
  exir: "اکسیر",
  tetherland: "تترلند",
  bit24: "بیت۲۴",
  okex_ir: "اوکی اکسچنج",
  arzinja: "ارزینجا",
  navasan: "نوسان",
  bonbast: "بن‌بست",
  talavest: "Talavest",
  binance: "Binance",
  kraken: "Kraken",
  okx: "OKX",
  bybit: "Bybit",
  coinbase: "Coinbase",
  news: "خبرها",
  forex: "تقویم فارکس"
};

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
      <LoadState loading={loading} error={error} hasData={Boolean(form)} skeleton={<SettingsSkeleton />} />
      {form ? (
        <div className="grid">
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
