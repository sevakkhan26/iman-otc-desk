"use client";

import { Search, X } from "lucide-react";
import { assetLabel } from "@/lib/assets";
import type { AssetTag } from "@/lib/types";

export type AssetFilter = "all" | AssetTag;

const ASSET_OPTIONS: AssetFilter[] = ["all", "USDT", "BTC", "ETH", "MACRO"];

export function matchAsset(assets: AssetTag[], filter: AssetFilter): boolean {
  return filter === "all" || assets.includes(filter);
}

export function matchQuery(haystack: string, query: string): boolean {
  const normalized = query.trim().toLowerCase();
  return normalized.length === 0 || haystack.toLowerCase().includes(normalized);
}

export function SmartFilter({
  asset,
  query,
  onAsset,
  onQuery,
  placeholder = "جستجو: نام صرافی، دارایی یا کلمه کلیدی...",
  resultLabel
}: {
  asset: AssetFilter;
  query: string;
  onAsset: (value: AssetFilter) => void;
  onQuery: (value: string) => void;
  placeholder?: string;
  resultLabel?: string;
}) {
  return (
    <div className="smart-filter" role="search" aria-label="فیلتر هوشمند">
      <div className="filter-chips">
        {ASSET_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            className={`chip ${asset === option ? "active" : ""}`}
            onClick={() => onAsset(option)}
            aria-pressed={asset === option}
          >
            {option === "all" ? "همه" : assetLabel(option)}
          </button>
        ))}
      </div>
      <div className="filter-search">
        <Search aria-hidden="true" size={16} />
        <input
          value={query}
          onChange={(event) => onQuery(event.target.value)}
          placeholder={placeholder}
          aria-label="جستجوی متنی"
        />
        {query ? (
          <button type="button" className="filter-clear" onClick={() => onQuery("")} aria-label="پاک کردن جستجو">
            <X aria-hidden="true" size={15} />
          </button>
        ) : null}
      </div>
      {resultLabel ? <span className="filter-result muted">{resultLabel}</span> : null}
    </div>
  );
}
