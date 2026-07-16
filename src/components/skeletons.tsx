"use client";

/**
 * Page-specific loading skeletons that mirror real desk layouts.
 * Placeholders only — no fake prices, names, or statuses.
 */

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/* ---------- primitives ---------- */

export function SkeletonLine({
  className,
  width,
  height
}: {
  className?: string;
  width?: string | number;
  height?: string | number;
}) {
  return (
    <span
      className={cx("sk-line", className)}
      style={{
        width: width ?? undefined,
        height: height ?? undefined
      }}
      aria-hidden="true"
    />
  );
}

export function SkeletonBlock({
  className,
  width,
  height
}: {
  className?: string;
  width?: string | number;
  height?: string | number;
}) {
  return (
    <div
      className={cx("sk-block", className)}
      style={{ width: width ?? undefined, height: height ?? undefined }}
      aria-hidden="true"
    />
  );
}

export function SkeletonDot({ className }: { className?: string }) {
  return <span className={cx("sk-dot", className)} aria-hidden="true" />;
}

function SkeletonPanelShell({
  titleWidth = "36%",
  children,
  className
}: {
  titleWidth?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("panel", "sk-panel", className)} aria-hidden="true">
      <div className="panel-header">
        <SkeletonLine className="sk-panel-title" width={titleWidth} height={14} />
        <SkeletonLine width="22%" height={12} />
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

export function SkeletonMetric() {
  return (
    <div className="metric sk-metric" aria-hidden="true">
      <SkeletonLine className="sk-metric-label" width="55%" height={11} />
      <SkeletonLine className="sk-metric-value" width="70%" height={20} />
      <SkeletonLine className="sk-metric-note" width="40%" height={10} />
    </div>
  );
}

export function SkeletonExchangeCard() {
  return (
    <article className="exch-card sk-exch-card" aria-hidden="true">
      <header className="exch-card-head">
        <SkeletonLine width="48%" height={14} />
        <SkeletonDot />
      </header>
      <div className="exch-prices">
        <div className="exch-row">
          <SkeletonLine width={36} height={11} />
          <SkeletonLine width="42%" height={16} />
        </div>
        <div className="exch-row">
          <SkeletonLine width={36} height={11} />
          <SkeletonLine width="42%" height={16} />
        </div>
        <div className="exch-row mid">
          <SkeletonLine width={48} height={11} />
          <SkeletonLine width="48%" height={17} />
        </div>
      </div>
    </article>
  );
}

export function SkeletonExchangeGrid({ count = 12 }: { count?: number }) {
  return (
    <div className="exch-grid" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <SkeletonExchangeCard key={i} />
      ))}
    </div>
  );
}

export function SkeletonTable({
  columns,
  rows = 8,
  colWidths
}: {
  columns: number;
  rows?: number;
  colWidths?: string[];
}) {
  return (
    <div className="table-wrap sk-table-wrap" aria-hidden="true">
      <table className="sk-table">
        <thead>
          <tr>
            {Array.from({ length: columns }).map((_, i) => (
              <th key={i} style={{ width: colWidths?.[i] }}>
                <SkeletonLine width="70%" height={11} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Array.from({ length: rows }).map((_, r) => (
            <tr key={r}>
              {Array.from({ length: columns }).map((_, c) => (
                <td key={c}>
                  <SkeletonLine
                    width={c === 0 ? "65%" : c === columns - 1 ? "55%" : "50%"}
                    height={12}
                  />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SkeletonChart({ height = 280 }: { height?: number }) {
  return (
    <div className="sk-chart" style={{ minHeight: height }} aria-hidden="true">
      <div className="sk-chart-head">
        <SkeletonLine width="28%" height={20} />
        <div className="sk-chart-tabs">
          <SkeletonLine width={48} height={28} />
          <SkeletonLine width={48} height={28} />
          <SkeletonLine width={48} height={28} />
        </div>
      </div>
      <div className="sk-chart-stats">
        {Array.from({ length: 5 }).map((_, i) => (
          <SkeletonLine key={i} width="14%" height={12} />
        ))}
      </div>
      <SkeletonBlock className="sk-chart-area" height={height - 90} />
    </div>
  );
}

export function SkeletonFilterBar() {
  return (
    <div className="filter-bar sk-filter-bar" aria-hidden="true">
      <div className="sk-filter-main">
        <SkeletonLine width={72} height={32} />
        <SkeletonLine width={72} height={32} />
        <SkeletonLine width={72} height={32} />
        <SkeletonLine className="sk-filter-input" width="100%" height={36} />
      </div>
      <div className="sk-filter-seg">
        <SkeletonLine width={56} height={32} />
        <SkeletonLine width={72} height={32} />
        <SkeletonLine width={64} height={32} />
      </div>
    </div>
  );
}

/* ---------- page skeletons ---------- */

export function DashboardSkeleton() {
  return (
    <div className="grid page-skeleton-root" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری داشبورد</span>
      {/* Cockpit */}
      <section className="cockpit sk-cockpit" aria-hidden="true">
        <div className="cockpit-hero-row">
          <div className="cockpit-hero">
            <SkeletonLine width="42%" height={12} />
            <SkeletonLine width="40%" height={28} />
            <SkeletonLine width="48%" height={11} />
          </div>
          <div className="cockpit-hero-pills">
            <SkeletonLine width={110} height={28} />
            <SkeletonLine width={130} height={24} />
          </div>
        </div>
        <div className="grid answer-grid">
          {Array.from({ length: 2 }).map((_, i) => (
            <div key={i} className="answer-stat answer-stat-spread sk-answer-stat">
              <SkeletonLine width="42%" height={16} />
              <SkeletonLine width="78%" height={24} />
              <SkeletonLine width="68%" height={18} />
              <SkeletonLine width="48%" height={20} />
            </div>
          ))}
        </div>
        <div className="grid decision-grid compact market-price-grid">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="decision-card compact market-price-card sk-decision-card">
              <div className="market-price-card-inner" aria-hidden="true">
                <SkeletonLine width="55%" height={12} />
                <SkeletonLine width="70%" height={18} />
                <SkeletonLine width="40%" height={11} />
              </div>
            </div>
          ))}
        </div>
      </section>

      <SkeletonPanelShell titleWidth="40%">
        <SkeletonExchangeGrid count={12} />
      </SkeletonPanelShell>

      <SkeletonPanelShell titleWidth="28%">
        <SkeletonExchangeGrid count={5} />
      </SkeletonPanelShell>

      <div className="grid two-col">
        <SkeletonPanelShell titleWidth="50%">
          <SkeletonChart height={300} />
        </SkeletonPanelShell>
        <SkeletonPanelShell titleWidth="35%">
          <div className="grid global-metrics">
            {Array.from({ length: 4 }).map((_, i) => (
              <SkeletonMetric key={i} />
            ))}
          </div>
        </SkeletonPanelShell>
      </div>

      <div className="grid metrics">
        {Array.from({ length: 4 }).map((_, i) => (
          <SkeletonMetric key={i} />
        ))}
      </div>

      <SkeletonPanelShell titleWidth="45%">
        <div className="sk-alert-list">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="sk-alert-row">
              <SkeletonLine width={64} height={22} />
              <SkeletonLine width="55%" height={13} />
              <SkeletonLine width="80%" height={11} />
            </div>
          ))}
        </div>
      </SkeletonPanelShell>
    </div>
  );
}

export function TetherMarketSkeleton() {
  return (
    <div className="grid page-skeleton-root" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری بازار تتر</span>
      <div className="grid metrics" aria-hidden="true">
        {Array.from({ length: 8 }).map((_, i) => (
          <SkeletonMetric key={i} />
        ))}
      </div>
      <SkeletonPanelShell titleWidth="38%">
        <SkeletonFilterBar />
        <SkeletonTable
          columns={8}
          rows={12}
          colWidths={["14%", "11%", "11%", "11%", "10%", "12%", "12%", "14%"]}
        />
      </SkeletonPanelShell>
      <SkeletonPanelShell titleWidth="48%">
        <SkeletonChart height={320} />
      </SkeletonPanelShell>
    </div>
  );
}

export function GoldSkeleton() {
  return (
    <div className="grid gold-page page-skeleton-root" data-layout-version="gold-cols-v2" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری بازار طلا</span>
      <SkeletonPanelShell titleWidth="36%" className="sk-gold-panel">
        <div className="gold-summary-and-cards" aria-hidden="true">
          <div className="gold-summary-col">
            <div className="gold-summary-panel sk-gold-summary">
              <div className="gold-summary-body">
                <SkeletonLine width="70%" height={13} />
                <div className="gold-summary-stats">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <div key={i} className="gold-summary-row">
                      <SkeletonLine width="50%" height={10} />
                      <SkeletonLine width="75%" height={14} />
                    </div>
                  ))}
                </div>
                <SkeletonLine width="40%" height={11} />
              </div>
            </div>
          </div>
          <div className="gold-prices-col">
            <div className="gold-groups">
              {Array.from({ length: 2 }).map((_, g) => (
                <section className="gold-group" key={g}>
                  <SkeletonLine className="gold-group-title sk-gold-group-title" width="36%" height={14} />
                  <div className="gold-group-grid">
                    {Array.from({ length: 3 }).map((_, i) => (
                      <SkeletonExchangeCard key={i} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </div>
        </div>
        <div className="sk-gold-chart-wrap">
          <SkeletonChart height={340} />
        </div>
      </SkeletonPanelShell>
    </div>
  );
}

export function ForexSkeleton() {
  return (
    <div className="grid page-skeleton-root" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری فارکس</span>
      <SkeletonPanelShell titleWidth="42%">
        <div className="sk-forex-list" aria-hidden="true">
          {Array.from({ length: 8 }).map((_, i) => (
            <article key={i} className="sk-forex-row">
              <div className="sk-forex-row-top">
                <SkeletonLine width="38%" height={13} />
                <SkeletonLine width={56} height={22} />
              </div>
              <div className="sk-forex-cols">
                <div>
                  <SkeletonLine width="40%" height={10} />
                  <SkeletonLine width="70%" height={13} />
                </div>
                <div>
                  <SkeletonLine width="45%" height={10} />
                  <SkeletonLine width="65%" height={13} />
                </div>
                <div>
                  <SkeletonLine width="50%" height={10} />
                  <SkeletonLine width="60%" height={13} />
                </div>
              </div>
              <SkeletonLine width="55%" height={11} />
            </article>
          ))}
        </div>
      </SkeletonPanelShell>
      <SkeletonLine className="sk-forex-note" width="70%" height={12} />
    </div>
  );
}

export function ExchangeMonitorSkeleton() {
  return (
    <div className="grid page-skeleton-root" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری مانیتور صرافی‌ها</span>
      <SkeletonPanelShell titleWidth="32%">
        <SkeletonTable columns={8} rows={10} />
      </SkeletonPanelShell>
      <SkeletonPanelShell titleWidth="30%">
        <SkeletonTable columns={7} rows={6} />
      </SkeletonPanelShell>
      <SkeletonPanelShell titleWidth="22%">
        <SkeletonExchangeGrid count={6} />
        <div className="sk-gold-chart-wrap">
          <SkeletonChart height={280} />
        </div>
      </SkeletonPanelShell>
    </div>
  );
}

export function AlertsSkeleton() {
  return (
    <div className="grid page-skeleton-root" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری هشدارها</span>
      <div aria-hidden="true">
        <SkeletonFilterBar />
      </div>
      <div className="grid alerts-columns" aria-hidden="true">
        {Array.from({ length: 3 }).map((_, col) => (
          <SkeletonPanelShell key={col} titleWidth="55%">
            <div className="sk-alert-list">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="sk-alert-row">
                  <SkeletonLine width={52} height={20} />
                  <SkeletonLine width="70%" height={13} />
                  <SkeletonLine width="90%" height={11} />
                  <SkeletonLine width="50%" height={11} />
                </div>
              ))}
            </div>
          </SkeletonPanelShell>
        ))}
      </div>
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="grid page-skeleton-root" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری تنظیمات</span>
      <SkeletonPanelShell titleWidth="36%">
        <div className="grid settings-grid" aria-hidden="true">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="sk-field">
              <SkeletonLine width="55%" height={11} />
              <SkeletonLine width="100%" height={36} />
            </div>
          ))}
        </div>
      </SkeletonPanelShell>
      <SkeletonPanelShell titleWidth="30%">
        <div className="grid settings-grid" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="sk-field">
              <SkeletonLine width="45%" height={11} />
              <SkeletonLine width="100%" height={36} />
            </div>
          ))}
        </div>
      </SkeletonPanelShell>
      <SkeletonPanelShell titleWidth="34%">
        <div className="sk-source-toggles" aria-hidden="true">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="sk-source-toggle">
              <SkeletonLine width="55%" height={12} />
              <SkeletonLine width={40} height={22} />
            </div>
          ))}
        </div>
      </SkeletonPanelShell>
    </div>
  );
}

export function ImpactNewsSkeleton() {
  return (
    <div className="impact-news-page page-skeleton-root" data-layout-version="impact-news-label-grid-v2" aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری اخبار</span>
      <div className="grid">
        <div aria-hidden="true">
          <SkeletonFilterBar />
        </div>
        <div className="impact-news-groups" aria-hidden="true">
          {Array.from({ length: 3 }).map((_, g) => (
            <section key={g} className="panel sk-panel">
              <div className="panel-header">
                <SkeletonLine width="40%" height={14} />
                <SkeletonLine width={36} height={22} />
              </div>
              <div className="panel-body">
                <div className="sk-news-grid">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <article key={i} className="sk-news-card">
                      <SkeletonLine width="30%" height={11} />
                      <SkeletonLine width="90%" height={14} />
                      <SkeletonLine width="100%" height={11} />
                      <SkeletonLine width="75%" height={11} />
                      <div className="sk-news-meta">
                        <SkeletonLine width="35%" height={10} />
                        <SkeletonLine width="25%" height={10} />
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Section skeleton for nested panels that fetch independently (e.g. SitePrices). */
export function SectionExchangeCardsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری</span>
      <SkeletonExchangeGrid count={count} />
    </div>
  );
}

export function SectionGoldPanelSkeleton() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">در حال بارگذاری بازار طلا</span>
      <SkeletonExchangeGrid count={4} />
      <div className="sk-gold-chart-wrap">
        <SkeletonChart height={260} />
      </div>
    </div>
  );
}
