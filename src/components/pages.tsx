"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CalendarClock, RefreshCw, Save } from "lucide-react";
import type {
  AlertCategory,
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
  IntelligenceState,
  PublicSettings,
  QuickDecision,
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

function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "داده‌ای دریافت نشد");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [url, revision]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { data, loading, error, reload };
}

function PageHeader({ title, subtitle, onRefresh }: { title: string; subtitle: string; onRefresh?: () => void }) {
  return (
    <div className="page-header">
      <div>
        <h2 className="page-title">{title}</h2>
        <div className="page-kicker">{subtitle}</div>
      </div>
      {onRefresh ? (
        <button className="icon-button" onClick={onRefresh} title="بروزرسانی" aria-label="بروزرسانی">
          <RefreshCw aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function Badge({ tone, children }: { tone: "good" | "warn" | "danger" | "neutral"; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

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

function Metric({ label, value, note }: { label: string; value: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {note ? <div className="metric-note">{note}</div> : null}
    </div>
  );
}

function AssetTags({ assets }: { assets: AssetTag[] }) {
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
}

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
    <div className={`answer-stat ${tone}`}>
      <div className="answer-question">{question}</div>
      <div className="answer-value number">{value}</div>
      {note ? <div className="answer-note">{note}</div> : null}
    </div>
  );
}

function DecisionCardView({ question, card }: { question: string; card: DecisionCard }) {
  const tone = decisionTone(card.level);
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

function QuickDecisionCockpit({
  quickDecision,
  marketState
}: {
  quickDecision: QuickDecision;
  marketState: DashboardResponse["marketState"];
}) {
  return (
    <section className="cockpit">
      <div className="cockpit-head">
        <div>
          <div className="cockpit-kicker">تصمیم سریع</div>
          <h3 className="cockpit-title">بازار در یک نگاه</h3>
        </div>
        <span className={`state-pill ${marketStateTone(marketState)}`}>
          وضعیت کلی بازار: {marketStateLabel(marketState)}
        </span>
      </div>

      <div className="grid answer-grid">
        <AnswerStat
          question="قیمت میانه تتر (Median)"
          value={formatToman(quickDecision.median)}
          note={`اختلاف بازار: ${formatPercent(quickDecision.spreadPercent)}`}
        />
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

      <div className="grid decision-grid">
        <DecisionCardView question="Spread را تغییر بدهم؟" card={quickDecision.spreadAction} />
        <DecisionCardView question="Max Order کم شود؟" card={quickDecision.maxOrderAction} />
        <DecisionCardView question="روی کدام LP احتیاط کنم؟" card={quickDecision.lpCaution} />
        <DecisionCardView question="قیمت پرت وجود دارد؟" card={quickDecision.outlierWatch} />
      </div>
    </section>
  );
}

function LoadState({ loading, error }: { loading: boolean; error: string | null }) {
  if (loading) return <div className="loading">در حال دریافت داده...</div>;
  if (error) return <div className="empty">داده‌ای دریافت نشد: {error}</div>;
  return null;
}

function SourceStatusBadge({ status }: { status: DomesticQuote["sourceStatus"] | ExchangeOperationalStatus["apiStatus"] }) {
  return <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>;
}

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
              <td className="number">{row.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : formatToman(row.buyPrice)}</td>
              <td className="number">{row.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : formatToman(row.sellPrice)}</td>
              <td className="number">{row.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : formatToman(row.midPrice)}</td>
              <td className="number">{row.spread === null ? "داده‌ای دریافت نشد" : formatToman(row.spread)}</td>
              <td className="number">{formatPercent(row.deviationFromMedianPercent)}</td>
              <td>
                <div className="stack">
                  <SourceStatusBadge status={row.sourceStatus} />
                  {row.errorMessage ? <span className="muted">{row.errorMessage}</span> : null}
                </div>
              </td>
              <td>{formatDate(row.lastUpdated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertsList({ items, compact = false }: { items: AlertItem[]; compact?: boolean }) {
  if (!items.length) return <div className="empty">داده‌ای دریافت نشد</div>;
  return (
    <div className="stack">
      {items.map((item) => (
        <article className="alert-row" key={item.id}>
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
      ))}
    </div>
  );
}

function NewsList({ items }: { items: ImpactNewsItem[] }) {
  if (!items.length) return <div className="empty">داده‌ای دریافت نشد</div>;
  return (
    <div className="stack">
      {items.map((item) => (
        <article className="news-row" key={item.id}>
          <div className="row-meta">
            <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
            <span>{item.source}</span>
            <span>{formatDate(item.publishedAt)}</span>
            <AssetTags assets={item.assets} />
          </div>
          <h4 className="row-title">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer">
                {item.title}
              </a>
            ) : (
              item.title
            )}
          </h4>
          <div>{item.impactOnUsdtIrt}</div>
          <strong>{item.recommendedAction}</strong>
        </article>
      ))}
    </div>
  );
}

function IntelligenceBox({ state }: { state: IntelligenceState }) {
  if (!state.enabled || !state.latest) {
    return <div className="empty">{state.message || "تحلیل هوشمند فعال نیست"}</div>;
  }
  const report = state.latest;
  return (
    <div className="analysis-grid">
      <div className="row-meta">
        <Badge tone={severityTone(report.riskLevel)}>{severityLabel(report.riskLevel)}</Badge>
        <span>{formatDate(report.generatedAt)}</span>
      </div>
      <AnalysisItem label="خلاصه وضعیت" text={report.summary} />
      <AnalysisItem label="اثر روی Pricing" text={report.pricingAction} />
      <AnalysisItem label="اثر روی Spread" text={report.spreadAction} />
      <AnalysisItem label="اثر روی LP" text={report.lpSelectionAction} />
      <AnalysisItem label="اقدام پیشنهادی" text={report.riskLimitsAction} />
    </div>
  );
}

function AnalysisItem({ label, text }: { label: string; text: string }) {
  return (
    <div className="analysis-item">
      <div className="analysis-label">{label}</div>
      <p className="analysis-text">{text}</p>
    </div>
  );
}

function GlobalMetricGrid({ rows }: { rows: GlobalPrice[] }) {
  return (
    <div className="grid metrics">
      {rows.map((row) => (
        <Metric
          key={row.symbol}
          label={row.symbol}
          value={row.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : row.symbol === "USDT/USD" ? formatNumber(row.price, 4) : formatUsd(row.price)}
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

function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function ForexEventsWidget({ forex }: { forex: ForexEventsResponse }) {
  const now = useNow(30_000);

  const events = useMemo(() => {
    return forex.events
      .filter((event) => {
        if (!event.date) return true;
        const time = new Date(event.date).getTime();
        // keep upcoming events and ones released within the last 2 hours
        return !Number.isFinite(time) || time - now > -2 * 60 * 60 * 1000;
      })
      .slice(0, 6);
  }, [forex.events, now]);

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

export function DashboardView() {
  const { data, loading, error, reload } = useApi<DashboardResponse>("/api/dashboard");
  return (
    <>
      <PageHeader title="داشبورد" subtitle="کابین تصمیم — قیمت، ریسک و هشدارها در کمتر از ۳۰ ثانیه" onRefresh={reload} />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <QuickDecisionCockpit quickDecision={data.quickDecision} marketState={data.marketState} />
          <Panel
            title="اخبار مهم فارکس (تقویم اقتصادی)"
            meta={
              <span className="panel-meta-icon muted">
                <CalendarClock aria-hidden="true" size={15} />
                {data.forex.message || `به‌روزرسانی: ${formatDate(data.forex.lastUpdated)}`}
              </span>
            }
          >
            <ForexEventsWidget forex={data.forex} />
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
          <div className="grid two-col">
            <Panel title="آخرین تحلیل هوشمند" meta={<span className="muted">{data.intelligence.message}</span>}>
              <IntelligenceBox state={data.intelligence} />
            </Panel>
            <Panel title="آخرین هشدارها">
              <AlertsList items={data.alerts} compact />
            </Panel>
          </div>
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
  const { data, loading, error, reload } = useApi<TetherMarketResponse>("/api/tether-market");
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
      <PageHeader title="بازار تتر ایران" subtitle="Median، قیمت پرت و اختلاف قیمت بین صرافی‌ها" onRefresh={reload} />
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
                <SourceStatusBadge status={row.apiStatus} />
              </td>
              <td>{statusLabel(row.depositStatus)}</td>
              <td>{statusLabel(row.withdrawalStatus)}</td>
              <td>{row.maintenance === null ? "داده‌ای دریافت نشد" : row.maintenance ? "فعال" : "خیر"}</td>
              <td>{row.lastIncident || row.errorMessage || "داده‌ای دریافت نشد"}</td>
              <td>{row.impactOnDesk}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ExchangeMonitorView() {
  const { data, loading, error, reload } = useApi<ExchangeMonitorResponse>("/api/exchange-monitor");
  return (
    <>
      <PageHeader title="مانیتور صرافی‌ها" subtitle="وضعیت منابع داخلی و صرافی‌های جهانی" onRefresh={reload} />
      <LoadState loading={loading} error={error} />
      {data ? (
        <div className="grid">
          <Panel title="صرافی‌های داخلی" meta={<span className="muted">Median: {formatToman(data.tetherSummary.median)}</span>}>
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
  const { data, loading, error, reload } = useApi<ImpactNewsResponse>("/api/impact-news");
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.items.filter(
      (item) => matchAsset(item.assets, asset) && matchQuery(`${item.title} ${item.source} ${item.impactOnUsdtIrt}`, query)
    );
  }, [data, asset, query]);

  const macro = filtered.filter((item) => item.category === "macro");
  const assetNews = filtered.filter((item) => item.category === "asset");

  return (
    <>
      <PageHeader title="خبرهای اثرگذار" subtitle="فقط خبرهای مرتبط با USDT/IRT و عملیات Dealing Desk" onRefresh={reload} />
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
          <Panel
            title="کلان / مالی (اثر بر کل بازار)"
            meta={<span className="muted">{data.message || `آخرین بروزرسانی: ${formatDate(data.lastUpdated)}`}</span>}
          >
            <NewsList items={macro} />
          </Panel>
          <Panel title="خبرهای دارایی‌محور (BTC، ETH، تتر و…)">
            <NewsList items={assetNews} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

const alertCategoryTitles: Record<AlertCategory, string> = {
  forex: "هشدارهای فارکس (رویداد پراثر نزدیک)",
  "price-diff": "هشدارهای اختلاف قیمت (بین صرافی‌های ایران)",
  "lp-specific": "هشدارهای LP ایرانی (رویداد و اتصال)",
  market: "بازار جهانی و ریسک Depeg"
};

export function AlertsView() {
  const { data, loading, error, reload } = useApi<AlertsResponse>("/api/alerts");
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

  const order: AlertCategory[] = ["forex", "price-diff", "lp-specific", "market"];

  return (
    <>
      <PageHeader title="هشدارها" subtitle="هشدارهای واقعی و قانون‌محور بر اساس داده زنده" onRefresh={reload} />
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
          {!filtered.length ? <div className="empty">هشداری با این فیلتر یافت نشد</div> : null}
          {order.map((category) => {
            const items = filtered.filter((item) => item.category === category);
            if (!items.length) return null;
            return (
              <Panel key={category} title={alertCategoryTitles[category]} meta={<Badge tone="neutral">{items.length}</Badge>}>
                <AlertsList items={items} />
              </Panel>
            );
          })}
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

export function SettingsView() {
  const { data, loading, error, reload } = useApi<PublicSettings>("/api/settings");
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
      <PageHeader title="تنظیمات" subtitle="منابع، بازه‌های بروزرسانی و آستانه‌های ریسک" onRefresh={reload} />
      <LoadState loading={loading} error={error} />
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
