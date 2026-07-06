"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import type { AlertItem, AssetSymbol, CategorizedAlerts, CategorizedNews, DecisionCard, DomesticQuote, ExchangeOperationalStatus, GlobalPrice, ImpactNewsItem, IntelligenceReport, IntelligenceState, ManualObservation, MarketState, Severity, SourceStatus } from "@/lib/data";

const nav = [
  ["/dashboard", "داشبورد"],
  ["/tether-market", "بازار تتر ایران"],
  ["/exchange-monitor", "مانیتور صرافی‌ها"],
  ["/impact-news", "خبرهای اثرگذار"],
  ["/alerts", "هشدارها"],
  ["/intelligence-history", "تاریخچه تحلیل‌ها"],
  ["/settings", "تنظیمات"]
];

type TetherMarketResponse = {
  summary: {
    median: number | null;
    highest: number | null;
    highestExchange: string | null;
    highestPoint: { exchangeId: string; exchangeName: string; price: number } | null;
    lowest: number | null;
    lowestExchange: string | null;
    lowestPoint: { exchangeId: string; exchangeName: string; price: number } | null;
    marketSpreadPercent: number | null;
    bestBuy: number | null;
    bestSell: number | null;
    activeSources: number;
    connectedSources: number;
    degradedSources: number;
    unavailableSources: number;
    lastUpdated: string | null;
  };
  exchanges: DomesticQuote[];
};
type DashboardResponse = { globalMarket: GlobalPrice[]; tetherMarket: TetherMarketResponse; marketState: MarketState; intelligence: IntelligenceState; alerts: AlertItem[]; alertGroups?: CategorizedAlerts; decisionCards: DecisionCard[] };
type ExchangeMonitorResponse = { domestic: DomesticQuote[]; global: ExchangeOperationalStatus[]; tetherSummary: TetherMarketResponse["summary"] };
type NewsResponse = CategorizedNews;
type AlertsResponse = CategorizedAlerts;
type HistoryResponse = IntelligenceState & { history: IntelligenceReport[] };
type ManualObservationResponse = { items: ManualObservation[] };
type PublicSettings = {
  providerApiKeysConfigured: Record<string, boolean>;
  openAiApiKeyConfigured: boolean;
  priceRefreshMinutes: number;
  globalMarketRefreshMinutes: number;
  globalExchangeRefreshMinutes: number;
  newsRefreshMinutes: number;
  intelligenceRefreshMinutes: number;
  outlierThresholdPercent: number;
  marketSpreadAlertThresholdPercent: number;
  depegAlertThresholdPercent: number;
  enabledSources: Record<string, boolean>;
};

type SmartContentType = "all" | "macro" | "assetSpecific" | "priceVariance" | "iranianLp" | "available" | "unavailable";
type SmartFilterState = {
  asset: "all" | AssetSymbol;
  content: SmartContentType;
};

const assetOptions: Array<{ value: SmartFilterState["asset"]; label: string }> = [
  { value: "all", label: "همه دارایی‌ها" },
  { value: "BTC", label: "BTC" },
  { value: "ETH", label: "ETH" },
  { value: "USDT", label: "USDT" },
  { value: "IRT", label: "IRT" },
  { value: "GLOBAL", label: "Global" }
];

function assetMatches(assets: AssetSymbol[] | undefined, asset: SmartFilterState["asset"]) {
  if (asset === "all") return true;
  return Boolean(assets?.includes(asset));
}

function SmartFilter({
  value,
  onChange,
  contentOptions
}: {
  value: SmartFilterState;
  onChange: (value: SmartFilterState) => void;
  contentOptions: Array<{ value: SmartContentType; label: string }>;
}) {
  return (
    <div className="smart-filter">
      <div>
        <small>Asset</small>
        <div className="filters">
          {assetOptions.map((option) => (
            <button key={option.value} className={value.asset === option.value ? "active" : ""} onClick={() => onChange({ ...value, asset: option.value })}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <small>نوع</small>
        <div className="filters">
          {contentOptions.map((option) => (
            <button key={option.value} className={value.content === option.value ? "active" : ""} onClick={() => onChange({ ...value, content: option.value })}>
              {option.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function useApi<T>(url: string) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as T;
      })
      .then(setData)
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "داده‌ای دریافت نشد");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [url, tick]);
  return { data, error, loading, reload: () => setTick((v) => v + 1) };
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname();
  return (
    <div className="shell">
      <aside>
        <h1>OTC Desk</h1>
        <p>Dealing Desk / OTC</p>
        <nav>
          {nav.map(([href, label]) => (
            <Link key={href} className={path === href ? "active" : ""} href={href}>
              <span>●</span>
              {label}
            </Link>
          ))}
        </nav>
        <small>منابع واقعی؛ منبع قطع باشد، عددی نمایش داده نمی‌شود.</small>
      </aside>
      <main>{children}</main>
    </div>
  );
}

function fa(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "داده‌ای دریافت نشد";
  return new Intl.NumberFormat("fa-IR", { maximumFractionDigits: digits }).format(value);
}

function toman(value: number | null | undefined) {
  return value === null || value === undefined ? "داده‌ای دریافت نشد" : `${fa(value)} تومان`;
}

function pct(value: number | null | undefined) {
  return value === null || value === undefined ? "داده‌ای دریافت نشد" : `${fa(value, 2)}٪`;
}

function date(value: string | null | undefined) {
  if (!value) return "داده‌ای دریافت نشد";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "داده‌ای دریافت نشد";
  return new Intl.DateTimeFormat("fa-IR", { dateStyle: "short", timeStyle: "short" }).format(parsed);
}

function statusText(status: SourceStatus | "unknown") {
  if (status === "available") return "فعال";
  if (status === "degraded") return "داده ناقص";
  if (status === "unavailable") return "منبع در دسترس نیست";
  return "نامشخص";
}

function tone(value: SourceStatus | Severity | MarketState | "unknown") {
  if (value === "available" || value === "low" || value === "calm") return "good";
  if (value === "degraded" || value === "medium" || value === "caution" || value === "unknown") return "warn";
  return "danger";
}

function risk(value: Severity) {
  if (value === "high") return "زیاد";
  if (value === "medium") return "متوسط";
  return "کم";
}

function state(value: MarketState) {
  if (value === "risky") return "پرریسک";
  if (value === "caution") return "احتیاط";
  return "آرام";
}

function Header({ title, sub, reload }: { title: string; sub: string; reload?: () => void }) {
  return (
    <header className="page-head">
      <div>
        <h2>{title}</h2>
        <p>{sub}</p>
      </div>
      {reload ? <button onClick={reload}>↻</button> : null}
    </header>
  );
}

function Loading({ loading, error }: { loading: boolean; error: string }) {
  if (loading) return <div className="empty">در حال دریافت داده...</div>;
  if (error) return <div className="empty">داده‌ای دریافت نشد: {error}</div>;
  return null;
}

function Badge({ value, children }: { value: SourceStatus | Severity | MarketState | "unknown"; children: ReactNode }) {
  return <span className={`badge ${tone(value)}`}>{children}</span>;
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PriceSignal({
  label,
  price,
  exchange,
  direction
}: {
  label: string;
  price: number | null | undefined;
  exchange: string | null | undefined;
  direction: "high" | "low";
}) {
  return (
    <div className={`metric price-signal ${direction}`}>
      <span>{direction === "high" ? "▲" : "▼"} {label}</span>
      <strong>{toman(price)}</strong>
      <small>{exchange || "داده‌ای دریافت نشد"}</small>
    </div>
  );
}

function DomesticTable({ rows }: { rows: DomesticQuote[] }) {
  return (
    <div className="table">
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
                <b>{row.exchangeName}</b>
                {row.isOutlier ? <Badge value="high">قیمت پرت</Badge> : null}
              </td>
              <td>{row.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : toman(row.buyPrice)}</td>
              <td>{row.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : toman(row.sellPrice)}</td>
              <td>{row.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : toman(row.midPrice)}</td>
              <td>{toman(row.spread)}</td>
              <td>{pct(row.deviationFromMedianPercent)}</td>
              <td>
                <Badge value={row.sourceStatus}>{statusText(row.sourceStatus)}</Badge>
                {row.errorMessage ? <small>{row.errorMessage}</small> : null}
              </td>
              <td>{date(row.lastUpdated)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertList({ items }: { items: AlertItem[] }) {
  if (!items.length) return <div className="empty">داده‌ای دریافت نشد</div>;
  return (
    <div className="list">
      {items.map((item) => (
        <article key={item.id}>
          <div className="meta">
            <Badge value={item.severity}>{risk(item.severity)}</Badge>
            <span>{item.source}</span>
            <span>{date(item.time)}</span>
          </div>
          <h4>{item.title}</h4>
          <p>{item.description}</p>
          <b>{item.recommendedAction}</b>
        </article>
      ))}
    </div>
  );
}

function NewsList({ items }: { items: ImpactNewsItem[] }) {
  if (!items.length) return <div className="empty">داده‌ای دریافت نشد</div>;
  return (
    <div className="list">
      {items.map((item) => (
        <article key={item.id}>
          <div className="meta">
            <Badge value={item.severity}>{risk(item.severity)}</Badge>
            <span>{item.source}</span>
            <span>{date(item.publishedAt)}</span>
            <span>{item.assets.join(" / ")}</span>
          </div>
          <h4>{item.url ? <a href={item.url}>{item.title}</a> : item.title}</h4>
          <p>{item.impactOnUsdtIrt}</p>
          <b>{item.recommendedAction}</b>
        </article>
      ))}
    </div>
  );
}

function AlertSection({ title, sub, items, priority }: { title: string; sub: string; items: AlertItem[]; priority?: boolean }) {
  return (
    <Panel title={title}>
      <div className={priority ? "section-note priority" : "section-note"}>{sub}</div>
      <AlertList items={items} />
    </Panel>
  );
}

function DecisionCards({ cards }: { cards: DecisionCard[] }) {
  return (
    <div className="decision-grid">
      {cards.map((card) => (
        <article className="decision-card" key={card.title}>
          <div className="meta">
            <Badge value={card.status}>{state(card.status)}</Badge>
            <span>{card.title}</span>
          </div>
          <p>{card.description}</p>
          <b>{card.action}</b>
        </article>
      ))}
    </div>
  );
}

function ManualObservationPanel() {
  const api = useApi<ManualObservationResponse>("/api/manual-observations");
  const recentItems = api.data?.items.slice(0, 3) ?? [];
  const [exchangeName, setExchangeName] = useState("");
  const [observedPrice, setObservedPrice] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function submit() {
    setSaving(true);
    setMessage("");
    const response = await fetch("/api/manual-observations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        exchangeName,
        observedPrice: observedPrice ? Number(observedPrice) : null,
        note
      })
    });
    if (response.ok) {
      setExchangeName("");
      setObservedPrice("");
      setNote("");
      setMessage("مشاهده ثبت شد");
      api.reload();
    } else {
      const body = (await response.json()) as { error?: string };
      setMessage(body.error || "ثبت مشاهده انجام نشد");
    }
    setSaving(false);
  }

  return (
    <Panel title="ثبت مشاهده دستی قیمت / نوت">
      <div className="manual-form">
        <input value={exchangeName} onChange={(e) => setExchangeName(e.target.value)} placeholder="نام صرافی یا LP" />
        <input value={observedPrice} onChange={(e) => setObservedPrice(e.target.value)} type="number" placeholder="قیمت مشاهده‌شده تومان" />
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="نوت کوتاه" />
        <button onClick={submit} disabled={saving}>{saving ? "در حال ثبت" : "ثبت"}</button>
      </div>
      {message ? <div className="section-note">{message}</div> : null}
      <div className="list">
        {recentItems.length ? (
          recentItems.map((item) => (
            <article key={item.id}>
              <div className="meta">
                <span>{item.exchangeName}</span>
                <span>{date(item.createdAt)}</span>
                {item.observedPrice !== null ? <span>{toman(item.observedPrice)}</span> : null}
              </div>
              <p>{item.note || "بدون نوت"}</p>
            </article>
          ))
        ) : (
          <div className="empty">مشاهده‌ای ثبت نشده است</div>
        )}
      </div>
    </Panel>
  );
}

export function DashboardPage() {
  const api = useApi<DashboardResponse>("/api/dashboard");
  const d = api.data;
  return (
    <>
      <Header title="داشبورد" sub="خلاصه قیمت، ریسک و هشدارهای عملیاتی" reload={api.reload} />
      <Loading loading={api.loading} error={api.error} />
      {d ? (
        <div className="grid">
          <div className="metrics">
            {d.globalMarket.map((g) => <Metric key={g.symbol} label={g.symbol} value={g.sourceStatus === "unavailable" ? "منبع در دسترس نیست" : g.symbol === "USDT/USD" ? fa(g.price, 4) : `$${fa(g.price, 2)}`} />)}
            <Metric label="Median قیمت USDT/IRT" value={toman(d.tetherMarket.summary.median)} />
            <PriceSignal label="بالاترین قیمت" price={d.tetherMarket.summary.highest} exchange={d.tetherMarket.summary.highestExchange} direction="high" />
            <PriceSignal label="پایین‌ترین قیمت" price={d.tetherMarket.summary.lowest} exchange={d.tetherMarket.summary.lowestExchange} direction="low" />
            <Metric label="اختلاف درصدی بازار" value={pct(d.tetherMarket.summary.marketSpreadPercent)} />
            <Metric label="اتصال منابع" value={`${fa(d.tetherMarket.summary.connectedSources)} متصل / ${fa(d.tetherMarket.summary.unavailableSources)} قطع`} />
            <Metric label="وضعیت کلی بازار" value={<Badge value={d.marketState}>{state(d.marketState)}</Badge>} />
            <Metric label="آخرین بروزرسانی" value={date(d.tetherMarket.summary.lastUpdated)} />
          </div>
          <div className="cols">
            <Panel title="آخرین تحلیل هوشمند">
              {!d.intelligence.enabled || !d.intelligence.latest ? <div className="empty">{d.intelligence.message}</div> : <p>{d.intelligence.latest.summary}</p>}
            </Panel>
            <Panel title="آخرین هشدارها">
              <AlertList items={d.alerts} />
            </Panel>
          </div>
          <Panel title="Decision Cockpit">
            <DecisionCards cards={d.decisionCards} />
          </Panel>
          <ManualObservationPanel />
        </div>
      ) : null}
    </>
  );
}

export function TetherMarketPage() {
  const api = useApi<TetherMarketResponse>("/api/tether-market");
  const d = api.data;
  const [filter, setFilter] = useState<SmartFilterState>({ asset: "all", content: "all" });
  const filteredRows = d
    ? d.exchanges.filter((row) => {
        const assetOk = filter.asset === "all" || filter.asset === "USDT" || filter.asset === "IRT";
        const statusOk = filter.content === "all" || row.sourceStatus === filter.content;
        return assetOk && statusOk;
      })
    : [];
  return (
    <>
      <Header title="بازار تتر ایران" sub="Median، outlier و اختلاف قیمت بین صرافی‌ها" reload={api.reload} />
      <Loading loading={api.loading} error={api.error} />
      {d ? (
        <div className="grid">
          <div className="metrics">
            <Metric label="Median بازار" value={toman(d.summary.median)} />
            <PriceSignal label="بالاترین قیمت فعلی" price={d.summary.highest} exchange={d.summary.highestExchange} direction="high" />
            <PriceSignal label="پایین‌ترین قیمت فعلی" price={d.summary.lowest} exchange={d.summary.lowestExchange} direction="low" />
            <Metric label="اختلاف درصدی بازار" value={pct(d.summary.marketSpreadPercent)} />
            <Metric label="بهترین قیمت خرید" value={toman(d.summary.bestBuy)} />
            <Metric label="بهترین قیمت فروش" value={toman(d.summary.bestSell)} />
            <Metric label="منابع متصل" value={fa(d.summary.connectedSources)} />
            <Metric label="منابع قطع" value={fa(d.summary.unavailableSources)} />
          </div>
          <Panel title="صرافی‌های داخلی">
            <SmartFilter
              value={filter}
              onChange={setFilter}
              contentOptions={[
                { value: "all", label: "همه صرافی‌ها" },
                { value: "available", label: `متصل (${fa(d.summary.connectedSources)})` },
                { value: "unavailable", label: `قطع (${fa(d.summary.unavailableSources)})` }
              ]}
            />
            <DomesticTable rows={filteredRows} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

export function ExchangeMonitorPage() {
  const api = useApi<ExchangeMonitorResponse>("/api/exchange-monitor");
  const d = api.data;
  return (
    <>
      <Header title="مانیتور صرافی‌ها" sub="وضعیت منابع داخلی و صرافی‌های جهانی" reload={api.reload} />
      <Loading loading={api.loading} error={api.error} />
      {d ? (
        <div className="grid">
          <Panel title="صرافی‌های داخلی"><DomesticTable rows={d.domestic} /></Panel>
          <Panel title="صرافی‌های جهانی">
            <div className="table">
              <table>
                <thead><tr><th>صرافی</th><th>API</th><th>واریز</th><th>برداشت</th><th>Maintenance</th><th>آخرین Incident</th><th>اثر احتمالی</th></tr></thead>
                <tbody>{d.global.map((row) => <tr key={row.exchangeName}><td><b>{row.exchangeName}</b></td><td><Badge value={row.apiStatus}>{statusText(row.apiStatus)}</Badge></td><td>{statusText(row.depositStatus)}</td><td>{statusText(row.withdrawalStatus)}</td><td>{row.maintenance === null ? "داده‌ای دریافت نشد" : row.maintenance ? "فعال" : "خیر"}</td><td>{row.lastIncident || row.errorMessage || "داده‌ای دریافت نشد"}</td><td>{row.impactOnDesk}</td></tr>)}</tbody>
              </table>
            </div>
          </Panel>
        </div>
      ) : null}
    </>
  );
}

export function NewsPage() {
  const api = useApi<NewsResponse>("/api/impact-news");
  const d = api.data;
  const [filter, setFilter] = useState<SmartFilterState>({ asset: "all", content: "all" });
  const filterNews = (items: ImpactNewsItem[], category: "macro" | "assetSpecific") =>
    items.filter((item) => {
      const categoryOk = filter.content === "all" || filter.content === category;
      return categoryOk && assetMatches(item.assets, filter.asset);
    });
  const macroNews = d ? filterNews(d.macro, "macro") : [];
  const assetNews = d ? filterNews(d.assetSpecific, "assetSpecific") : [];
  return (
    <>
      <Header title="خبرهای اثرگذار" sub="اخبار ماکرو بازار کریپتو و خبرهای خاص دارایی" reload={api.reload} />
      <Loading loading={api.loading} error={api.error} />
      {d ? (
        <div className="grid">
          <SmartFilter
            value={filter}
            onChange={setFilter}
            contentOptions={[
              { value: "all", label: "همه خبرها" },
              { value: "macro", label: "مالی جهانی / ماکرو" },
              { value: "assetSpecific", label: "Asset-Specific" }
            ]}
          />
          {d.message ? <div className="section-note">{d.message}</div> : null}
          <Panel title={`اخبار مالی جهانی و ماکرو (${fa(macroNews.length)})`}>
            <NewsList items={macroNews} />
          </Panel>
          <Panel title={`اخبار خاص کوین/دارایی (${fa(assetNews.length)})`}>
            <NewsList items={assetNews} />
          </Panel>
        </div>
      ) : null}
    </>
  );
}

export function AlertsPage() {
  const api = useApi<AlertsResponse>("/api/alerts");
  const [filter, setFilter] = useState<SmartFilterState>({ asset: "all", content: "all" });
  const filterAlerts = (items: AlertItem[], category: "priceVariance" | "iranianLp") =>
    items.filter((item) => {
      const categoryOk = filter.content === "all" || filter.content === category;
      return categoryOk && assetMatches(item.assets, filter.asset);
    });
  const priceVariance = api.data ? filterAlerts(api.data.priceVariance, "priceVariance") : [];
  const iranianLp = api.data ? filterAlerts(api.data.iranianLp, "iranianLp") : [];
  return (
    <>
      <Header title="هشدارها" sub="اختلاف قیمت بین LPها و هشدارهای خاص LPهای ایرانی" reload={api.reload} />
      <Loading loading={api.loading} error={api.error} />
      {api.data ? (
        <div className="grid">
          <SmartFilter
            value={filter}
            onChange={setFilter}
            contentOptions={[
              { value: "all", label: "همه هشدارها" },
              { value: "priceVariance", label: "اختلاف قیمت LPها" },
              { value: "iranianLp", label: "LPهای ایرانی" }
            ]}
          />
          <AlertSection title="هشدار اختلاف قیمت بین LPها" sub="اختلاف Median با بالاترین/پایین‌ترین قیمت و قیمت‌های پرت بین صرافی‌های ایرانی" items={priceVariance} priority />
          <AlertSection title="هشدارهای خاص LPهای ایرانی" sub="اخبار/رویدادهای مرتبط با LPهای ایرانی و وضعیت وصل/قطع شدن منابع" items={iranianLp} />
        </div>
      ) : null}
    </>
  );
}

export function HistoryPage() {
  const api = useApi<HistoryResponse>("/api/intelligence-history");
  const d = api.data;
  return (
    <>
      <Header title="تاریخچه تحلیل‌ها" sub="گزارش‌های هوشمند ساعتی" reload={api.reload} />
      <Loading loading={api.loading} error={api.error} />
      {d ? <Panel title={d.message}>{d.history?.length ? d.history.map((r) => <article className="report" key={r.id}><Badge value={r.riskLevel}>{risk(r.riskLevel)}</Badge><h4>{date(r.generatedAt)}</h4><p>{r.summary}</p><p>{r.pricingAction}</p></article>) : <div className="empty">{d.enabled ? "هیچ تحلیلی ثبت نشده است" : "تحلیل هوشمند فعال نیست"}</div>}</Panel> : null}
    </>
  );
}

export function SettingsPage() {
  const api = useApi<PublicSettings>("/api/settings");
  const [form, setForm] = useState<PublicSettings | null>(null);
  useEffect(() => {
    if (api.data) setForm(api.data);
  }, [api.data]);
  async function save() {
    if (!form) return;
    await fetch("/api/settings", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(form) });
    api.reload();
  }
  return (
    <>
      <Header title="تنظیمات" sub="منابع، بازه‌های بروزرسانی و آستانه‌های ریسک" reload={api.reload} />
      <Loading loading={api.loading} error={api.error} />
      {form ? (
        <div className="grid">
          <Panel title="بازه‌ها و آستانه‌ها">
            <div className="settings">
              {(["priceRefreshMinutes", "globalMarketRefreshMinutes", "globalExchangeRefreshMinutes", "newsRefreshMinutes", "intelligenceRefreshMinutes", "outlierThresholdPercent", "marketSpreadAlertThresholdPercent", "depegAlertThresholdPercent"] as const).map((key) => (
                <label key={key}>{key}<input type="number" value={form[key]} onChange={(e) => setForm({ ...form, [key]: Number(e.target.value) })} /></label>
              ))}
            </div>
          </Panel>
          <Panel title="فعال‌سازی منابع">
            <div className="settings">
              {Object.keys(form.enabledSources).map((key) => <label key={key}>{key}<input type="checkbox" checked={form.enabledSources[key]} onChange={(e) => setForm({ ...form, enabledSources: { ...form.enabledSources, [key]: e.target.checked } })} /></label>)}
            </div>
          </Panel>
          <button className="save" onClick={save}>ذخیره</button>
        </div>
      ) : null}
    </>
  );
}
