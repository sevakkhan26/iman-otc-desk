"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { TomanAmount } from "@/components/TomanAmount";
import { Bidi } from "@/components/shadowArbitrage/Bidi";
import {
  ELIGIBILITY_FA,
  OPP_CLASS_FA,
  TOOLTIP_FA,
  blockedDetail,
  blockedShort,
  eligibilityTone,
  formatCountFa,
  formatDurationFa,
  formatPercentFa,
  freshnessLabel,
  toFaDigits,
  type OppClass,
} from "@/components/shadowArbitrage/labels";
import {
  DEFAULT_OPPORTUNITY_FILTERS,
  OPPORTUNITY_PAGE_SIZES,
  OPPORTUNITY_SORTS,
  activeFilterCount,
  evidenceFor,
  filterOpportunities,
  groupOpportunities,
  indexPaperEvidence,
  paginate,
  primaryBlockingReason,
  sortOpportunities,
  summarizeOpportunities,
  type OpportunityFilters,
  type OpportunitySortKey,
  type PaperLedgerRow,
} from "@/components/shadowArbitrage/opportunityModel";
import { Kpi, Pager } from "@/components/shadowArbitrage/panelKit";
import type { VenueReadiness } from "@/components/shadowArbitrage/sourcesModel";
import { readInt, useShadowViewState } from "@/components/shadowArbitrage/urlState";
import type {
  NormalizedSourceSnapshot,
  ShadowOpportunity,
} from "@/components/shadowArbitrage/types";

type Props = {
  opportunities: ShadowOpportunity[];
  sources: NormalizedSourceSnapshot[];
  sizes: number[];
  venues: VenueReadiness[];
  paperLedger: PaperLedgerRow[];
  paperSessionPresent: boolean;
  pollIntervalMs: number;
  loading: boolean;
  stale: boolean;
  error: string | null;
  onSelect: (o: ShadowOpportunity) => void;
};

/** What each category means, in one line, so the hierarchy explains itself. */
const CATEGORY_MEANING_FA: Record<OppClass, string> = {
  valid: "کارمزد هر دو طرف معلوم، عمق کافی، حساب موجود و سود خالص مثبت",
  raw: "اختلاف قیمت وجود دارد اما با شرایط فعلی قابل اجرا نیست",
  blocked: "دست‌کم یک مانع قطعی دارد یا فقط برای مقایسه است",
};

const CATEGORY_ORDER: OppClass[] = ["valid", "raw", "blocked"];

const UNKNOWN_PNL_FA = "این رقم را موتور اجرای کاغذی ثبت می‌کند؛ برای این چرخه ثبتی وجود ندارد.";

function parseCategory(value: string): OppClass {
  return CATEGORY_ORDER.includes(value as OppClass) ? (value as OppClass) : "valid";
}

/**
 * Phase 8B — the «فرصت‌ها» tab.
 *
 * Read-only presentation. Every figure is server-computed: this component
 * filters, orders, groups and pages, and never calculates money. A metric the
 * server did not produce renders as «—» with a Persian explanation, never zero.
 *
 * Only one category is on screen at a time, and the category, page and page size
 * live in the URL, so a reload returns to exactly the same view.
 */
export function OpportunitiesPanel({
  opportunities,
  sources,
  sizes,
  venues,
  paperLedger,
  paperSessionPresent,
  pollIntervalMs,
  loading,
  stale,
  error,
  onSelect,
}: Props) {
  const { read, write } = useShadowViewState();
  const category = parseCategory(read("cat", "valid"));
  const perPage = OPPORTUNITY_PAGE_SIZES.includes(
    readInt(read("per", "20"), 20, 10, 50) as (typeof OPPORTUNITY_PAGE_SIZES)[number],
  )
    ? readInt(read("per", "20"), 20, 10, 50)
    : 20;
  const requestedPage = readInt(read("page", "1"), 1, 1, 9_999);

  const [filters, setFilters] = useState<OpportunityFilters>(DEFAULT_OPPORTUNITY_FILTERS);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  /** Any filter change starts again at page 1 — never on a page that vanished. */
  const set = <K extends keyof OpportunityFilters>(key: K, value: OpportunityFilters[K]) => {
    setFilters((f) => ({ ...f, [key]: value }));
    write({ page: "1" });
  };

  const evidence = useMemo(() => indexPaperEvidence(paperLedger), [paperLedger]);

  const feeMetaById = useMemo(() => {
    const map = new Map<string, { bps: number | null; stale: boolean }>();
    for (const v of venues) map.set(v.sourceId, { bps: v.takerFeeBps, stale: v.feeStale });
    return map;
  }, [venues]);

  const groups = useMemo(() => {
    const filtered = filterOpportunities(opportunities, filters);
    const grouped = groupOpportunities(filtered);
    return {
      valid: sortOpportunities(grouped.valid, filters.sort, evidence),
      raw: sortOpportunities(grouped.raw, filters.sort, evidence),
      blocked: sortOpportunities(grouped.blocked, filters.sort, evidence),
    };
  }, [opportunities, filters, evidence]);

  const summary = useMemo(() => summarizeOpportunities(groups), [groups]);
  const page = useMemo(
    () => paginate(groups[category], requestedPage, perPage),
    [groups, category, requestedPage, perPage],
  );

  // If the URL asks for a page that no longer exists, correct the URL itself.
  const lastCorrected = useRef<string>("");
  useEffect(() => {
    const key = `${category}:${perPage}:${page.page}`;
    if (page.page !== requestedPage && lastCorrected.current !== key) {
      lastCorrected.current = key;
      write({ page: String(page.page) });
    }
  }, [category, perPage, page.page, requestedPage, write]);

  const filterCount = activeFilterCount(filters);
  const clearAll = () => {
    setFilters(DEFAULT_OPPORTUNITY_FILTERS);
    write({ page: "1" });
  };

  if (error) {
    return (
      <section className="panel sa-panel sa-empty" role="alert">
        <strong>دریافت فرصت‌ها ممکن نشد</strong>
        <span>{error}</span>
      </section>
    );
  }

  if (loading && !opportunities.length) {
    return (
      <section className="panel sa-panel" aria-busy="true" aria-live="polite">
        <div className="panel-body sa-skel">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="sa-skeleton-line" />
          ))}
        </div>
      </section>
    );
  }

  return (
    <div className="sa-stack">
      {stale ? (
        <div className="sa-callout sa-callout-warn" role="status">
          آخرین چرخهٔ موفق از بودجهٔ تازگی گذشته است؛ ارقام زیر مربوط به همان چرخه‌اند و ممکن است
          وضعیت فعلی بازار را نشان ندهند.
        </div>
      ) : null}

      {/* ── summary: four separate KPI cards ─────────────────────────────── */}
      <div className="sa-kpi-grid">
        <Kpi
          label={OPP_CLASS_FA.valid}
          value={formatCountFa(summary.valid)}
          hint="آمادهٔ استفاده با حساب‌های فعلی"
          tone={summary.valid ? "good" : "muted"}
        />
        <Kpi
          label={OPP_CLASS_FA.raw}
          value={formatCountFa(summary.raw)}
          hint="اختلاف قیمت دارد اما اجراپذیر نیست"
          tone={summary.raw ? "warn" : "muted"}
        />
        <Kpi
          label={OPP_CLASS_FA.blocked}
          value={formatCountFa(summary.blocked)}
          hint="دارای مانع قطعی یا فقط مرجع"
          tone="muted"
        />
        <Kpi
          label="بهترین فرصت معتبر"
          value={summary.bestValid ? <TomanAmount value={summary.bestValid.netProfitToman} /> : "—"}
          hint={
            summary.bestValid
              ? `${summary.bestValid.buySourceName} ← ${summary.bestValid.sellSourceName}`
              : "فرصت معتبر خالص مثبتی وجود ندارد"
          }
          tone={summary.bestValid ? "good" : "muted"}
        />
      </div>

      {/* ── filters ──────────────────────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label="فیلتر و جست‌وجو">
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">فیلتر و جست‌وجو</h3>
          <div className="sa-panel-note">
            {formatCountFa(summary.shown)} نتیجه از {formatCountFa(opportunities.length)} مسیر
            {filterCount ? ` · ${toFaDigits(filterCount)} فیلتر فعال` : ""}
          </div>
        </div>

        <div className="panel-body sa-filter-body">
          {/* Always visible, on every width. */}
          <label className="sa-field sa-field-search">
            <span className="sa-field-label">جست‌وجوی صرافی</span>
            <input
              className="sa-control glass-control"
              type="search"
              value={filters.query}
              placeholder="نام یا شناسهٔ صرافی…"
              onChange={(e) => set("query", e.target.value)}
            />
          </label>

          {/* On mobile everything below hides behind one control. */}
          <button
            type="button"
            className="sa-more-btn glass-control"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((v) => !v)}
          >
            فیلترهای بیشتر
            {filterCount ? <span className="sa-more-count">{toFaDigits(filterCount)}</span> : null}
          </button>

          <div className={`sa-advanced${advancedOpen ? " is-open" : ""}`}>
            <div className="sa-field" role="group" aria-label="حجم معامله">
              <span className="sa-field-label">حجم (تتر)</span>
              <div className="sa-segmented glass-tabbar">
                <button
                  type="button"
                  className={`sa-seg${filters.size === "all" ? " is-active glass-control" : ""}`}
                  aria-pressed={filters.size === "all"}
                  onClick={() => set("size", "all")}
                >
                  همه
                </button>
                {sizes.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`sa-seg${filters.size === String(s) ? " is-active glass-control" : ""}`}
                    aria-pressed={filters.size === String(s)}
                    onClick={() => set("size", String(s))}
                  >
                    {toFaDigits(s)}
                  </button>
                ))}
              </div>
            </div>

            <label className="sa-field">
              <span className="sa-field-label">صرافی</span>
              <select
                className="sa-control glass-control"
                value={filters.sourceId}
                onChange={(e) => set("sourceId", e.target.value)}
              >
                <option value="all">همهٔ صرافی‌ها</option>
                {sources.map((s) => (
                  <option key={s.sourceId} value={s.sourceId}>
                    {s.sourceName}
                  </option>
                ))}
              </select>
            </label>

            <label className="sa-field">
              <span className="sa-field-label">مرتب‌سازی بر اساس</span>
              <select
                className="sa-control glass-control"
                value={filters.sort}
                onChange={(e) => set("sort", e.target.value as OpportunitySortKey)}
              >
                {OPPORTUNITY_SORTS.map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.labelFa}
                  </option>
                ))}
              </select>
            </label>

            <div className="sa-chips" role="group" aria-label="محدودکردن نتایج">
              <Chip
                checked={filters.currentAccountsOnly}
                onChange={(v) => set("currentAccountsOnly", v)}
                label="فقط حساب‌های فعلی"
                title="فقط مسیرهایی که با حساب‌های احرازشدهٔ موجود قابل استفاده‌اند"
              />
              <Chip
                checked={filters.netPositiveOnly}
                onChange={(v) => set("netPositiveOnly", v)}
                label="فقط سود خالص مثبت"
                title="کارمزد هر دو طرف معلوم و سود خالص بزرگ‌تر از صفر"
              />
              <Chip
                checked={filters.includeCompleted}
                onChange={(v) => set("includeCompleted", v)}
                label="شامل چرخه‌های پایان‌یافته"
                title="فرصت‌هایی که دیگر فعال نیستند نیز نمایش داده شوند"
              />
              <button
                type="button"
                className="sa-btn-clear glass-control"
                onClick={clearAll}
                disabled={filterCount === 0}
              >
                پاک‌کردن فیلترها
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── category ─────────────────────────────────────────────────────── */}
      <div
        className="sa-segmented sa-segmented-lg glass-tabbar"
        role="tablist"
        aria-label="دستهٔ فرصت‌ها"
      >
        {CATEGORY_ORDER.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={category === c}
            className={`sa-seg sa-seg-lg${category === c ? " is-active glass-control" : ""}`}
            onClick={() => write({ cat: c, page: "1" })}
          >
            {OPP_CLASS_FA[c]}
            <span className="sa-seg-count">{formatCountFa(groups[c].length)}</span>
          </button>
        ))}
      </div>

      {/* ── results ──────────────────────────────────────────────────────── */}
      <section className="panel sa-panel" aria-label={OPP_CLASS_FA[category]}>
        <div className="panel-header sa-panel-header">
          <h3 className="panel-title">{OPP_CLASS_FA[category]}</h3>
          <div className="sa-panel-note">
            {formatCountFa(page.total)} مسیر · {CATEGORY_MEANING_FA[category]}
          </div>
        </div>

        {page.total === 0 ? (
          <div className="panel-body">
            <div className="sa-empty">
              <strong>در این دسته موردی وجود ندارد</strong>
              <span>
                {filterCount
                  ? "فیلترها را پاک کنید یا دستهٔ دیگری را انتخاب کنید."
                  : "دستهٔ دیگری را انتخاب کنید یا منتظر چرخهٔ بعدی جمع‌آوری بمانید."}
              </span>
            </div>
          </div>
        ) : (
          <>
            {/* Desktop: the essential columns only; the rest lives in the drawer. */}
            <div className="panel-body sa-table-wrap sa-op-table-wrap">
              <table className="sa-table sa-op-table">
                <thead>
                  <tr>
                    <th scope="col">مسیر</th>
                    <th scope="col" className="num">
                      حجم
                    </th>
                    <th scope="col" className="num">
                      قیمت خرید / فروش
                    </th>
                    <th scope="col" className="num" title={TOOLTIP_FA.rawSpread}>
                      اسپرد خام
                    </th>
                    <th scope="col" className="num" title={TOOLTIP_FA.fee}>
                      کارمزد شناخته‌شده
                    </th>
                    <th scope="col" className="num">
                      سود خالص اقتصادی
                    </th>
                    <th scope="col" className="num">
                      سود تعدیل‌شده با بافر
                    </th>
                    <th scope="col">وضعیت و تازگی</th>
                    <th scope="col" />
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((o) => {
                    const ev = evidenceFor(o, evidence);
                    const fresh = freshnessLabel(Math.max(o.buyAgeMs, o.sellAgeMs), pollIntervalMs);
                    const fees = o.feeUnknown ? null : o.buyFeeToman + o.sellFeeToman;
                    return (
                      <tr key={o.id}>
                        <td>
                          <Route o={o} />
                        </td>
                        <td className="num">{toFaDigits(o.sizeUsdt)}</td>
                        <td className="num">
                          <div className="sa-stack-2">
                            <TomanAmount value={o.buyVwapToman} />
                            <span className="sa-sub">
                              <TomanAmount value={o.sellVwapToman} />
                            </span>
                          </div>
                        </td>
                        <td className="num">
                          <Bidi>{formatPercentFa(o.rawSpreadPercent, 3, true)}</Bidi>
                        </td>
                        <td className="num">
                          {fees === null ? (
                            <span
                              className="sa-unknown"
                              title="کارمزد رسمی یکی از دو صرافی تأیید نشده است"
                            >
                              —
                            </span>
                          ) : (
                            <div className="sa-stack-2">
                              <TomanAmount value={fees} />
                              {isLegStale(o, feeMetaById) ? (
                                <span className="sa-sub sa-neg">اعتبار کارمزد منقضی</span>
                              ) : null}
                            </div>
                          )}
                        </td>
                        <td className="num">
                          <Money value={ev?.economicNetPnlToman ?? null} signed />
                        </td>
                        <td className="num">
                          <Money value={ev?.riskAdjustedPnlToman ?? null} signed strong />
                        </td>
                        <td>
                          <Status o={o} freshLabel={fresh.label} freshTone={fresh.tone} />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="sa-btn-details glass-control"
                            onClick={() => onSelect(o)}
                            aria-label={`جزئیات محاسبهٔ خرید از ${o.buySourceName} و فروش در ${o.sellSourceName}`}
                          >
                            جزئیات
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile: real cards, never a squeezed table. */}
            <div className="panel-body sa-op-cards">
              {page.rows.map((o) => {
                const ev = evidenceFor(o, evidence);
                const fresh = freshnessLabel(Math.max(o.buyAgeMs, o.sellAgeMs), pollIntervalMs);
                return (
                  <article key={o.id} className="sa-op-card glass-control">
                    <header className="sa-op-card-head">
                      <Route o={o} />
                      <span className="sa-op-card-size">{toFaDigits(o.sizeUsdt)} تتر</span>
                    </header>
                    <dl className="sa-op-card-grid">
                      <CardLine label="قیمت خرید" value={<TomanAmount value={o.buyVwapToman} />} />
                      <CardLine label="قیمت فروش" value={<TomanAmount value={o.sellVwapToman} />} />
                      <CardLine
                        label="سود تعدیل‌شده با بافر"
                        value={<Money value={ev?.riskAdjustedPnlToman ?? null} signed strong />}
                      />
                      <CardLine
                        label="تازگی"
                        value={
                          <span className={`sa-fresh sa-fresh-${fresh.tone}`}>{fresh.label}</span>
                        }
                      />
                    </dl>
                    <footer className="sa-op-card-foot">
                      <Status o={o} freshLabel={fresh.label} freshTone={fresh.tone} compact />
                      <button
                        type="button"
                        className="sa-btn-details glass-control"
                        onClick={() => onSelect(o)}
                        aria-label={`جزئیات محاسبهٔ خرید از ${o.buySourceName} و فروش در ${o.sellSourceName}`}
                      >
                        جزئیات
                      </button>
                    </footer>
                  </article>
                );
              })}
            </div>

            <Pager
              page={page.page}
              pageCount={page.pageCount}
              total={page.total}
              from={page.from}
              to={page.to}
              perPage={perPage}
              pageSizes={OPPORTUNITY_PAGE_SIZES}
              onPage={(p) => write({ page: String(p) })}
              onPerPage={(n) => write({ per: String(n), page: "1" })}
            />
          </>
        )}

        {!paperSessionPresent ? (
          <div className="panel-body sa-footnote">
            سود اقتصادی و تعدیل‌شده را موتور اجرای کاغذی ثبت می‌کند؛ تا شروع نشدن آن، این ستون‌ها
            «—» می‌مانند و هیچ مقداری جایگزینشان نمی‌شود.
          </div>
        ) : null}
      </section>
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────────── */

function Chip({
  checked,
  onChange,
  label,
  title,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title: string;
}) {
  return (
    <label className={`sa-chip-toggle${checked ? " is-on glass-control" : ""}`} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function Route({ o }: { o: ShadowOpportunity }) {
  return (
    <div className="sa-route">
      <div className="sa-route-line">
        <span className="sa-route-key">خرید از:</span>
        <strong>{o.buySourceName}</strong>
      </div>
      <div className="sa-route-line">
        <span className="sa-route-key">فروش در:</span>
        <strong>{o.sellSourceName}</strong>
      </div>
    </div>
  );
}

function Status({
  o,
  freshLabel,
  freshTone,
  compact,
}: {
  o: ShadowOpportunity;
  freshLabel: string;
  freshTone: string;
  compact?: boolean;
}) {
  const primary = primaryBlockingReason(o);
  return (
    <div className="sa-status">
      <span className={`sa-chip sa-chip-${eligibilityTone(o.eligibility)} sa-chip-sm`}>
        {ELIGIBILITY_FA[o.eligibility]}
      </span>
      {primary ? (
        <span className="sa-status-reason" title={blockedDetail(primary)}>
          {blockedShort(primary)}
        </span>
      ) : null}
      {compact ? null : (
        <span className="sa-sub">
          <span className={`sa-fresh sa-fresh-${freshTone}`}>{freshLabel}</span>
          {" · "}
          {o.durationMs > 0 ? formatDurationFa(o.durationMs) : "نخستین چرخه"}
        </span>
      )}
    </div>
  );
}

function CardLine({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="sa-op-card-line">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** A toman figure, or an em dash with the reason it is missing. */
function Money({
  value,
  signed,
  strong,
}: {
  value: number | null;
  signed?: boolean;
  strong?: boolean;
}) {
  if (value === null) {
    return (
      <span className="sa-unknown" title={UNKNOWN_PNL_FA}>
        —
      </span>
    );
  }
  const tone = signed ? (value > 0 ? " sa-pos" : value < 0 ? " sa-neg" : "") : "";
  return (
    <span className={`${strong ? "sa-strong" : ""}${tone}`}>
      <TomanAmount value={value} />
    </span>
  );
}

/** True when either leg's confirmed fee has expired. */
function isLegStale(
  o: ShadowOpportunity,
  feeMetaById: Map<string, { bps: number | null; stale: boolean }>,
): boolean {
  return Boolean(feeMetaById.get(o.buySourceId)?.stale || feeMetaById.get(o.sellSourceId)?.stale);
}
