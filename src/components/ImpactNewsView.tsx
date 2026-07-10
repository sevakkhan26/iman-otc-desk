"use client";

import { memo, useMemo, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useApi } from "@/hooks/useApi";
import { NEWS_LABEL_GROUPS, assetLabel, primaryNewsGroup } from "@/lib/assets";
import type { ImpactNewsItem, ImpactNewsResponse } from "@/lib/types";
import {
  formatNewsTehranTime,
  severityLabel,
  severityTone
} from "@/components/format";
import { SmartFilter, matchAsset, matchQuery, type AssetFilter } from "@/components/SmartFilter";

type Tone = "good" | "warn" | "danger" | "neutral";

const NEWS_REFRESH_MS = 120_000;

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

const NewsItemCard = memo(function NewsItemCard({ item }: { item: ImpactNewsItem }) {
  return (
    <article className="news-item impact-news-card">
      <div className="row-meta">
        <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>
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
            {assetLabel(asset)}
          </span>
        ))}
      </div>
      <div className="muted news-item-impact">{item.translatedSummary}</div>
    </article>
  );
});

function NewsGroupGrid({ items }: { items: ImpactNewsItem[] }) {
  const sorted = useMemo(
    () =>
      [...items].sort(
        (a, b) => new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime()
      ),
    [items]
  );

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
    return data.items.filter(
      (item) =>
        matchAsset(item.assets, asset) &&
        matchQuery(`${item.translatedTitle} ${item.title} ${item.source} ${item.translatedSummary}`, query)
    );
  }, [data, asset, query]);

  const labelGroups = useMemo(() => {
    const buckets = new Map<string, ImpactNewsItem[]>();
    for (const item of filtered) {
      const key = primaryNewsGroup(item.assets);
      const list = buckets.get(key) ?? [];
      list.push(item);
      buckets.set(key, list);
    }
    return NEWS_LABEL_GROUPS.map((group) => ({
      key: group.key,
      title: group.title,
      items: buckets.get(group.key) ?? []
    })).filter((group) => group.items.length > 0);
  }, [filtered]);

  if (loading && !data) {
    return (
      <>
        <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
        <div className="loading">در حال دریافت داده...</div>
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
    <div className="impact-news-page" data-layout-version="impact-news-label-grid-v2">
      <PageHeader onRefresh={reload} lastUpdated={lastUpdated} loading={loading} />
      <div className="grid">
        <SmartFilter
          asset={asset}
          query={query}
          onAsset={setAsset}
          onQuery={setQuery}
          placeholder="جستجو در خبرها..."
          resultLabel={`${filtered.length} از ${data.items.length} خبر`}
        />
        {labelGroups.length ? (
          <div className="impact-news-groups">
            {labelGroups.map((group) => (
              <NewsPanel key={group.key} title={group.title} count={group.items.length}>
                <NewsGroupGrid items={group.items} />
              </NewsPanel>
            ))}
          </div>
        ) : (
          <div className="empty">{data.message || "داده‌ای دریافت نشد"}</div>
        )}
      </div>
    </div>
  );
}