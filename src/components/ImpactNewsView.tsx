"use client";

import { memo, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { ThemeToggleButton } from "@/components/ThemeToggleButton";
import {
  NEWS_LABEL_GROUPS,
  newsCategoryLabel,
  primaryNewsGroup,
  type NewsLabelGroupKey
} from "@/lib/assets";
import type { AssetTag, ImpactNewsItem, ImpactNewsResponse } from "@/lib/types";
import {
  formatNewsTehranTime,
  severityLabel,
  severityTone
} from "@/components/format";
import { SmartFilter, matchQuery, type AssetFilter } from "@/components/SmartFilter";
import { ImpactNewsSkeleton } from "@/components/skeletons";

type Tone = "good" | "warn" | "danger" | "neutral";

/** Client poll interval for Impact News (60–120s). */
const NEWS_REFRESH_MS = 90_000;

const EMPTY_FRESH_MESSAGE = "در حال حاضر خبر تازه و اثرگذار مرتبط با بازار ایران یافت نشد.";

/** Filter chips: همه + four categories (RTL chip row order). */
const NEWS_FILTER_OPTIONS: AssetFilter[] = ["all", "MACRO", "BTC", "ETH", "USDT"];

const clockTimeFmt = new Intl.DateTimeFormat("fa-IR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Tehran"
});

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
      <h2 className="page-title">خبرهای اثرگذار</h2>
      <div className="header-meta">
        <div className="last-update">
          آخرین بروزرسانی: <span className="number">{lastUpdated ? clockTimeFmt.format(lastUpdated) : "—"}</span>
        </div>
        <button
          className="icon-button"
          onClick={onRefresh}
          title="بروزرسانی"
          aria-label="بروزرسانی"
          disabled={loading}
        >
          <RefreshCw aria-hidden="true" className={loading ? "spinning" : undefined} />
        </button>
        <ThemeToggleButton />
      </div>
    </div>
  );
}

const Badge = memo(function Badge({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`badge ${tone}`}>{children}</span>;
});

function NewsPanel({
  title,
  count,
  children
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="panel impact-news-group-panel">
      <div className="panel-header">
        <h3 className="panel-title">{title}</h3>
        <Badge tone="neutral">{count}</Badge>
      </div>
      <div className="panel-body">{children}</div>
    </section>
  );
}

const SEVERITY_RANK: Record<string, number> = { high: 3, medium: 2, low: 1 };

function sortNewsItems(items: ImpactNewsItem[]): ImpactNewsItem[] {
  return [...items].sort((a, b) => {
    const sr = (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (sr !== 0) return sr;
    const is = (b.impactScore ?? 0) - (a.impactScore ?? 0);
    if (is !== 0) return is;
    return new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime();
  });
}

const NewsItemCard = memo(function NewsItemCard({ item }: { item: ImpactNewsItem }) {
  return (
    <article className="news-item impact-news-card">
      <div className="row-meta">
        <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
        {item.categoryLabel ? <span className="nowrap">{item.categoryLabel}</span> : null}
        <span>{item.source}</span>
        <span className="nowrap news-time">{formatNewsTehranTime(item.publishedAt)}</span>
      </div>
      <h4 className="news-item-title">
        {item.url ? (
          <a href={item.url} target="_blank" rel="noreferrer">
            {item.translatedTitle}
          </a>
        ) : (
          item.translatedTitle
        )}
      </h4>
      <div className="asset-tags">
        {item.assets.map((asset) => (
          <span className="asset-tag" key={asset}>
            {newsCategoryLabel(asset)}
          </span>
        ))}
      </div>
      <div className="muted news-item-impact">{item.translatedSummary || item.impactOnUsdtIrt}</div>
      {item.impactReason ? <div className="muted news-item-impact">{item.impactReason}</div> : null}
    </article>
  );
});

function NewsColumnStack({ items }: { items: ImpactNewsItem[] }) {
  const sorted = useMemo(() => sortNewsItems(items), [items]);

  if (!sorted.length) {
    return <div className="empty impact-news-column-empty">خبری در این دسته نیست</div>;
  }

  return (
    <div className="impact-news-group-grid">
      {sorted.map((item) => (
        <NewsItemCard key={item.id} item={item} />
      ))}
    </div>
  );
}

export function ImpactNewsView() {
  const { data, loading, error, reload, lastUpdated } = useApi<ImpactNewsResponse>("/api/impact-news", NEWS_REFRESH_MS);
  const [asset, setAsset] = useState<AssetFilter>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!data) return [];
    return data.items.filter((item) => {
      const primary = primaryNewsGroup(item.assets);
      if (asset !== "all" && primary !== asset) return false;
      return matchQuery(
        `${item.translatedTitle} ${item.title} ${item.source} ${item.translatedSummary}`,
        query
      );
    });
  }, [data, asset, query]);

  /** Always four columns when «همه»; single full-width column when a category is selected. */
  const labelGroups = useMemo(() => {
    const buckets = new Map<NewsLabelGroupKey, ImpactNewsItem[]>();
    for (const item of filtered) {
      const key = primaryNewsGroup(item.assets);
      const list = buckets.get(key) ?? [];
      list.push(item);
      buckets.set(key, list);
    }

    const groups = NEWS_LABEL_GROUPS.map((group) => ({
      key: group.key,
      title: group.title,
      items: buckets.get(group.key) ?? []
    }));

    if (asset === "all") return groups;
    return groups.filter((group) => group.key === asset);
  }, [filtered, asset]);

  const hasAnyItems = filtered.length > 0;

  if (loading && !data) {
    return (
      <>
        <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
        <ImpactNewsSkeleton />
      </>
    );
  }

  if (error && !data) {
    return (
      <>
        <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
        <div className="empty">داده‌ای دریافت نشد: {error}</div>
      </>
    );
  }

  if (!data) return null;

  return (
    <div className="impact-news-page" data-layout-version="impact-news-cols-v3">
      <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <div className="grid">
        <SmartFilter
          asset={asset}
          query={query}
          onAsset={setAsset}
          onQuery={setQuery}
          placeholder="جستجو در خبرها..."
          resultLabel={`${filtered.length} از ${data.items.length} خبر`}
          assetOptions={NEWS_FILTER_OPTIONS}
          formatAssetLabel={(tag: AssetTag) => newsCategoryLabel(tag)}
        />
        {hasAnyItems || asset === "all" ? (
          <div
            className={`impact-news-groups${asset === "all" ? "" : " is-single"}`}
            data-columns={asset === "all" ? 4 : 1}
          >
            {labelGroups.map((group) => (
              <NewsPanel key={group.key} title={group.title} count={group.items.length}>
                <NewsColumnStack items={group.items} />
              </NewsPanel>
            ))}
          </div>
        ) : (
          <div className="empty">{data.message || EMPTY_FRESH_MESSAGE}</div>
        )}
      </div>
    </div>
  );
}
