"use client";

import { useMemo, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import {
  ELIGIBILITY_FA,
  NO_VALID_OPPORTUNITY_FA,
  OPP_CLASS_FA,
  OPP_CLASS_ORDER,
  classifyOpportunity,
  TOOLTIP_FA,
  blockedShort,
  blockedDetail,
  eligibilityTone,
  formatCountFa,
  formatDurationFa,
  formatPercentFa,
  freshnessLabel,
  toFaDigits
} from "@/components/shadowArbitrage/labels";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "@/components/shadowArbitrage/types";

export type SortKey = "profit" | "edge" | "raw" | "duration" | "freshness";

type Props = {
  opportunities: ShadowOpportunity[];
  sources: NormalizedSourceSnapshot[];
  sizes: number[];
  pollIntervalMs: number;
  loading: boolean;
  onSelect: (o: ShadowOpportunity) => void;
};

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "profit", label: "سود خالص" },
  { key: "edge", label: "حاشیهٔ خالص" },
  { key: "raw", label: "اسپرد خام" },
  { key: "duration", label: "مدت دوام" },
  { key: "freshness", label: "تازگی داده" }
];

/** Section C — the live opportunity table. */
export function OpportunityTable({
  opportunities,
  sources,
  sizes,
  pollIntervalMs,
  loading,
  onSelect
}: Props) {
  const [size, setSize] = useState<"all" | string>("all");
  const [source, setSource] = useState<"all" | string>("all");
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [netPositiveOnly, setNetPositiveOnly] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const [sort, setSort] = useState<SortKey>("profit");
  const [query, setQuery] = useState("");

  const rows = useMemo(() => {
    const q = query.trim();
    const filtered = opportunities.filter((o) => {
      if (!showEnded && !o.isActive) return false;
      if (size !== "all" && String(o.sizeUsdt) !== size) return false;
      if (source !== "all" && o.buySourceId !== source && o.sellSourceId !== source) return false;
      if (verifiedOnly && o.eligibility !== "EXECUTABLE_NOW") return false;
      if (netPositiveOnly) {
        if (o.feeUnknown || o.netProfitToman <= 0 || o.eligibility === "BLOCKED") return false;
      }
      if (q) {
        const haystack = `${o.buySourceName} ${o.sellSourceName} ${o.buySourceId} ${o.sellSourceId}`;
        if (!haystack.includes(q)) return false;
      }
      return true;
    });

    const by: Record<SortKey, (a: ShadowOpportunity, b: ShadowOpportunity) => number> = {
      profit: (a, b) => netOf(b) - netOf(a),
      edge: (a, b) => (b.feeUnknown ? -Infinity : b.netEdgePercent) - (a.feeUnknown ? -Infinity : a.netEdgePercent),
      raw: (a, b) => b.rawSpreadPercent - a.rawSpreadPercent,
      duration: (a, b) => b.durationMs - a.durationMs,
      freshness: (a, b) => Math.max(a.buyAgeMs, a.sellAgeMs) - Math.max(b.buyAgeMs, b.sellAgeMs)
    };
    return [...filtered].sort((a, b) => {
      const ca = OPP_CLASS_ORDER[classifyOpportunity(a)];
      const cb = OPP_CLASS_ORDER[classifyOpportunity(b)];
      if (ca !== cb) return ca - cb;
      return by[sort](a, b);
    });
  }, [opportunities, size, source, verifiedOnly, netPositiveOnly, showEnded, sort, query]);

  const activeFilters =
    (size !== "all" ? 1 : 0) +
    (source !== "all" ? 1 : 0) +
    (verifiedOnly ? 1 : 0) +
    (netPositiveOnly ? 1 : 0) +
    (showEnded ? 1 : 0) +
    (query.trim() ? 1 : 0);

  const clearAll = () => {
    setSize("all");
    setSource("all");
    setVerifiedOnly(false);
    setNetPositiveOnly(false);
    setShowEnded(false);
    setQuery("");
  };

  return (
    <section className="panel sa-panel">
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title sa-panel-title">فرصت‌های زنده</h3>
        <div className="sa-panel-note">
          {formatCountFa(rows.length)} فرصت
          {activeFilters ? ` · ${toFaDigits(activeFilters)} فیلتر فعال` : ""}
        </div>
      </div>

      <div className="panel-body sa-filters">
        <div className="sa-filter-group" role="group" aria-label="حجم معامله">
          <span className="sa-filter-label">حجم</span>
          <div className="sa-segmented">
            <button
              type="button"
              className={`sa-seg${size === "all" ? " is-active" : ""}`}
              onClick={() => setSize("all")}
            >
              همه
            </button>
            {sizes.map((s) => (
              <button
                key={s}
                type="button"
                className={`sa-seg${size === String(s) ? " is-active" : ""}`}
                onClick={() => setSize(String(s))}
              >
                {toFaDigits(s)}
              </button>
            ))}
          </div>
        </div>

        <label className="sa-filter-group">
          <span className="sa-filter-label">صرافی</span>
          <select className="sa-select" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="all">همه</option>
            {sources.map((s) => (
              <option key={s.sourceId} value={s.sourceId}>
                {s.sourceName}
              </option>
            ))}
          </select>
        </label>

        <label className="sa-filter-group">
          <span className="sa-filter-label">مرتب‌سازی</span>
          <select
            className="sa-select"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="sa-filter-group sa-search">
          <span className="sa-filter-label">جست‌وجو</span>
          <input
            className="sa-input"
            type="search"
            value={query}
            placeholder="نام صرافی…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>

        <div className="sa-toggles">
          <label className="sa-toggle">
            <input
              type="checkbox"
              checked={verifiedOnly}
              onChange={(e) => setVerifiedOnly(e.target.checked)}
            />
            <span>فقط حساب‌های فعلی</span>
          </label>
          <label className="sa-toggle">
            <input
              type="checkbox"
              checked={netPositiveOnly}
              onChange={(e) => setNetPositiveOnly(e.target.checked)}
            />
            <span>فقط سود خالص مثبت</span>
          </label>
          <label className="sa-toggle">
            <input
              type="checkbox"
              checked={showEnded}
              onChange={(e) => setShowEnded(e.target.checked)}
            />
            <span>شامل پایان‌یافته‌ها</span>
          </label>
          {activeFilters ? (
            <button type="button" className="sa-btn sa-btn-ghost" onClick={clearAll}>
              پاک‌کردن فیلترها
            </button>
          ) : null}
        </div>
      </div>

      {!rows.some((o) => classifyOpportunity(o) === "valid") && rows.length ? (
        <div className="panel-body">
          <div className="sa-callout sa-callout-muted">{NO_VALID_OPPORTUNITY_FA}</div>
        </div>
      ) : null}

      <div className="panel-body sa-table-wrap">
        <table className="sa-table">
          <thead>
            <tr>
              <th>مسیر</th>
              <th className="num">حجم</th>
              <th className="num">خرید</th>
              <th className="num">فروش</th>
              <th className="num" title={TOOLTIP_FA.rawSpread}>اسپرد خام</th>
              <th className="num" title={TOOLTIP_FA.fee}>کارمزد</th>
              <th className="num" title={TOOLTIP_FA.buffer}>بافر ریسک</th>
              <th className="num" title={TOOLTIP_FA.netEdge}>حاشیهٔ خالص</th>
              <th className="num">سود خالص</th>
              <th>وضعیت</th>
              <th>دوام / تازگی</th>
            </tr>
          </thead>
          <tbody>
            {loading && !rows.length
              ? Array.from({ length: 5 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="sa-row-skeleton">
                    <td colSpan={11}>
                      <div className="sa-skeleton-line" />
                    </td>
                  </tr>
                ))
              : null}

            {rows.map((o) => {
              const fresh = freshnessLabel(Math.max(o.buyAgeMs, o.sellAgeMs), pollIntervalMs);
              const blocked = o.blockedReasons.filter(
                (r) => r !== "account_required" && r !== "reference_only"
              );
              return (
                <tr
                  key={o.id}
                  className="sa-row"
                  tabIndex={0}
                  role="button"
                  onClick={() => onSelect(o)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(o);
                    }
                  }}
                >
                  <td>
                    <div className="sa-route-line">
                      <span className="sa-route-key">خرید از:</span>
                      <strong>{o.buySourceName}</strong>
                    </div>
                    <div className="sa-route-line">
                      <span className="sa-route-key">فروش در:</span>
                      <strong>{o.sellSourceName}</strong>
                    </div>
                    <span className={`sa-chip sa-chip-sm sa-chip-${
                      classifyOpportunity(o) === "valid" ? "good" : classifyOpportunity(o) === "raw" ? "warn" : "muted"
                    }`}>
                      {OPP_CLASS_FA[classifyOpportunity(o)]}
                    </span>
                  </td>
                  <td className="num">{toFaDigits(o.sizeUsdt)}</td>
                  <td className="num">
                    <TomanAmount value={o.buyVwapToman} />
                  </td>
                  <td className="num">
                    <TomanAmount value={o.sellVwapToman} />
                  </td>
                  <td className="num sa-raw">{formatPercentFa(o.rawSpreadPercent, 3, true)}</td>
                  <td className="num">
                    {o.feeUnknown ? (
                      <span className="sa-chip sa-chip-warn sa-chip-sm">نامشخص</span>
                    ) : (
                      formatPercentFa(o.totalFeePercent, 3)
                    )}
                  </td>
                  <td className="num sa-muted-cell">
                    <TomanAmount value={o.slippageBufferToman} />
                  </td>
                  <td className={`num ${!o.feeUnknown && o.netEdgePercent > 0 ? "sa-pos" : "sa-neg"}`}>
                    {o.feeUnknown ? "—" : formatPercentFa(o.netEdgePercent, 3, true)}
                  </td>
                  <td className={`num ${!o.feeUnknown && o.netProfitToman > 0 ? "sa-pos" : "sa-neg"}`}>
                    {o.feeUnknown ? (
                      <span className="sa-muted-cell">پتانسیل خام</span>
                    ) : (
                      <TomanAmount value={o.netProfitToman} />
                    )}
                  </td>
                  <td>
                    <span className={`sa-chip sa-chip-${eligibilityTone(o.eligibility)} sa-chip-sm`}>
                      {ELIGIBILITY_FA[o.eligibility]}
                    </span>
                    {blocked.length ? (
                      <div className="sa-reasons">
                        {blocked.slice(0, 2).map((r) => (
                          <span key={r} className="sa-reason" title={`${blockedDetail(r)} (${r})`}>
                            {blockedShort(r)}
                          </span>
                        ))}
                        {blocked.length > 2 ? (
                          <span className="sa-reason sa-reason-more">
                            +{toFaDigits(blocked.length - 2)}
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                  <td>
                    <div className="sa-dual">
                      <span>{o.durationMs > 0 ? formatDurationFa(o.durationMs) : "تازه"}</span>
                      <span className={`sa-fresh sa-fresh-${fresh.tone}`}>{fresh.label}</span>
                    </div>
                    {!o.isActive ? <div className="sa-route-hint">پایان‌یافته</div> : null}
                  </td>
                </tr>
              );
            })}

            {!loading && !rows.length ? (
              <tr>
                <td colSpan={11}>
                  <div className="sa-empty">
                    <strong>فرصتی با این فیلترها پیدا نشد</strong>
                    <span>
                      {opportunities.length
                        ? "فیلترها را پاک کنید تا همهٔ مسیرها را ببینید."
                        : "پس از اولین چرخه‌های جمع‌آوری، مسیرها اینجا ظاهر می‌شوند."}
                    </span>
                    {activeFilters ? (
                      <button type="button" className="sa-btn sa-btn-ghost" onClick={clearAll}>
                        پاک‌کردن فیلترها
                      </button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="panel-body sa-footnote">
        اسپرد خام با سود خالص یکسان نیست. سود خالص فقط زمانی محاسبه می‌شود که کارمزد هر دو طرف معلوم
        باشد؛ در غیر این صورت نتیجه «پتانسیل خام» است. برای دیدن جزئیات محاسبه روی هر ردیف کلیک کنید.
      </div>
    </section>
  );
}

function netOf(o: ShadowOpportunity): number {
  return o.feeUnknown ? Number.NEGATIVE_INFINITY : o.netProfitToman;
}
