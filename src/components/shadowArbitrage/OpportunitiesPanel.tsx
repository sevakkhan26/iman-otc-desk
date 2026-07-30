"use client";

import { useMemo, useState } from "react";
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
  type OppClass
} from "@/components/shadowArbitrage/labels";
import {
  DEFAULT_OPPORTUNITY_FILTERS,
  OPPORTUNITY_SORTS,
  activeFilterCount,
  evidenceFor,
  filterOpportunities,
  groupOpportunities,
  indexPaperEvidence,
  primaryBlockingReason,
  sortOpportunities,
  summarizeOpportunities,
  type OpportunityFilters,
  type OpportunitySortKey,
  type PaperEvidence,
  type PaperLedgerRow
} from "@/components/shadowArbitrage/opportunityModel";
import { FEE_PROVENANCE_FA, type VenueReadiness } from "@/components/shadowArbitrage/sourcesModel";
import type { NormalizedSourceSnapshot, ShadowOpportunity } from "@/components/shadowArbitrage/types";

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
const GROUP_MEANING_FA: Record<OppClass, string> = {
  valid: "کارمزد هر دو طرف معلوم، عمق کافی، حساب موجود و سود خالص مثبت",
  raw: "اختلاف قیمت وجود دارد اما با شرایط فعلی قابل اجرا نیست",
  blocked: "دست‌کم یک مانع قطعی دارد یا فقط برای مقایسه است"
};

const GROUP_ORDER: OppClass[] = ["valid", "raw", "blocked"];

/** Fee evidence for one venue, as the accounts endpoint reported it. */
type FeeMeta = {
  provenanceFa: string;
  bps: number | null;
  stale: boolean;
  verifiedAt: string | null;
};

/**
 * Phase 8B — the «فرصت‌ها» tab.
 *
 * Read-only presentation. Every figure is server-computed: this component
 * filters, orders and groups, and never calculates money. Metrics the server did
 * not produce render as «—» with a Persian explanation rather than as zero.
 *
 * The five-figure PnL decomposition belongs to the paper engine, so it is joined
 * in by lifecycle id and shown only where a paper evaluation exists.
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
  onSelect
}: Props) {
  const [filters, setFilters] = useState<OpportunityFilters>(DEFAULT_OPPORTUNITY_FILTERS);
  const set = <K extends keyof OpportunityFilters>(key: K, value: OpportunityFilters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  const evidence = useMemo(() => indexPaperEvidence(paperLedger), [paperLedger]);

  const feeMetaById = useMemo(() => {
    const map = new Map<string, FeeMeta>();
    for (const v of venues) {
      map.set(v.sourceId, {
        provenanceFa: FEE_PROVENANCE_FA[v.feeProvenance] ?? "نامشخص",
        bps: v.takerFeeBps,
        stale: v.feeStale,
        verifiedAt: v.feeVerifiedAt
      });
    }
    return map;
  }, [venues]);

  const groups = useMemo(() => {
    const filtered = filterOpportunities(opportunities, filters);
    const grouped = groupOpportunities(filtered);
    return {
      valid: sortOpportunities(grouped.valid, filters.sort, evidence),
      raw: sortOpportunities(grouped.raw, filters.sort, evidence),
      blocked: sortOpportunities(grouped.blocked, filters.sort, evidence)
    };
  }, [opportunities, filters, evidence]);

  const summary = useMemo(() => summarizeOpportunities(groups), [groups]);
  const filterCount = activeFilterCount(filters);
  const clearAll = () => setFilters(DEFAULT_OPPORTUNITY_FILTERS);

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
      <div className="sa-op-loading" aria-busy="true" aria-live="polite">
        <section className="panel sa-panel">
          <div className="panel-body sa-op-skeleton">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="sa-skeleton-line" />
            ))}
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="sa-op">
      {stale ? (
        <div className="sa-callout sa-callout-warn" role="status">
          آخرین چرخهٔ موفق از بودجهٔ تازگی گذشته است؛ ارقام زیر مربوط به همان چرخه‌اند و ممکن است
          وضعیت فعلی بازار را نشان ندهند.
        </div>
      ) : null}

      {/* Category summary — the hierarchy in four numbers. */}
      <section className="panel sa-panel sa-op-summary" aria-label="خلاصهٔ دسته‌بندی فرصت‌ها">
        <div className="panel-body sa-op-summary-grid">
          <SummaryStat
            label={OPP_CLASS_FA.valid}
            value={formatCountFa(summary.valid)}
            hint={GROUP_MEANING_FA.valid}
            tone={summary.valid ? "good" : "muted"}
          />
          <SummaryStat
            label={OPP_CLASS_FA.raw}
            value={formatCountFa(summary.raw)}
            hint={GROUP_MEANING_FA.raw}
            tone={summary.raw ? "warn" : "muted"}
          />
          <SummaryStat
            label={OPP_CLASS_FA.blocked}
            value={formatCountFa(summary.blocked)}
            hint={GROUP_MEANING_FA.blocked}
            tone="muted"
          />
          <SummaryStat
            label="بهترین فرصت معتبر"
            value={
              summary.bestValid ? <TomanAmount value={summary.bestValid.netProfitToman} /> : "—"
            }
            hint={
              summary.bestValid
                ? `خرید از ${summary.bestValid.buySourceName} · فروش در ${summary.bestValid.sellSourceName} · ${toFaDigits(summary.bestValid.sizeUsdt)} تتر`
                : "در حال حاضر فرصت معتبر خالص مثبتی وجود ندارد"
            }
            tone={summary.bestValid ? "good" : "muted"}
          />
        </div>
      </section>

      {/* Filter rail — the material comes from the shared glass controls. */}
      <section className="panel sa-panel sa-op-filterbar" aria-label="فیلترها و مرتب‌سازی">
        <div className="panel-body sa-op-filter-grid">
          <label className="sa-op-field sa-op-field-search">
            <span className="sa-op-field-label">جست‌وجوی صرافی</span>
            <input
              className="sa-input glass-control sa-op-control"
              type="search"
              value={filters.query}
              placeholder="نام صرافی…"
              onChange={(e) => set("query", e.target.value)}
            />
          </label>

          <div className="sa-op-field" role="group" aria-label="حجم معامله">
            <span className="sa-op-field-label">حجم (تتر)</span>
            {/* Same pairing as the tab strip: container material + active control. */}
            <div className="sa-op-segmented glass-tabbar">
              <button
                type="button"
                className={`sa-op-seg${filters.size === "all" ? " is-active glass-control" : ""}`}
                aria-pressed={filters.size === "all"}
                onClick={() => set("size", "all")}
              >
                همه
              </button>
              {sizes.map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`sa-op-seg${filters.size === String(s) ? " is-active glass-control" : ""}`}
                  aria-pressed={filters.size === String(s)}
                  onClick={() => set("size", String(s))}
                >
                  {toFaDigits(s)}
                </button>
              ))}
            </div>
          </div>

          <label className="sa-op-field">
            <span className="sa-op-field-label">صرافی</span>
            <select
              className="sa-select glass-control sa-op-control"
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

          <label className="sa-op-field">
            <span className="sa-op-field-label">مرتب‌سازی بر اساس</span>
            <select
              className="sa-select glass-control sa-op-control"
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

          <div className="sa-op-toggles" role="group" aria-label="محدودکردن نتایج">
            <Toggle
              checked={filters.currentAccountsOnly}
              onChange={(v) => set("currentAccountsOnly", v)}
              label="فقط حساب‌های فعلی"
              title="فقط مسیرهایی که با حساب‌های احرازشدهٔ موجود قابل استفاده‌اند"
            />
            <Toggle
              checked={filters.netPositiveOnly}
              onChange={(v) => set("netPositiveOnly", v)}
              label="فقط سود خالص مثبت"
              title="کارمزد هر دو طرف معلوم و سود خالص بزرگ‌تر از صفر"
            />
            <Toggle
              checked={filters.includeCompleted}
              onChange={(v) => set("includeCompleted", v)}
              label="شامل چرخه‌های پایان‌یافته"
              title="فرصت‌هایی که دیگر فعال نیستند نیز نمایش داده شوند"
            />
            {filterCount ? (
              <button
                type="button"
                className="sa-op-clear glass-control"
                onClick={clearAll}
              >
                پاک‌کردن {toFaDigits(filterCount)} فیلتر
              </button>
            ) : null}
          </div>
        </div>
        <div className="panel-body sa-op-filter-foot">
          <span>
            {formatCountFa(summary.shown)} فرصت نمایش داده می‌شود از{" "}
            {formatCountFa(opportunities.length)} مسیر ثبت‌شده
          </span>
          {!paperSessionPresent ? (
            <span className="sa-op-note">
              سود نقدی، اقتصادی و تعدیل‌شده تنها پس از ارزیابی موتور اجرای کاغذی ثبت می‌شود؛ تا آن
              زمان «—» نمایش داده می‌شود.
            </span>
          ) : null}
        </div>
      </section>

      {summary.shown === 0 ? (
        <section className="panel sa-panel sa-empty">
          <strong>فرصتی با این فیلترها پیدا نشد</strong>
          <span>
            {opportunities.length
              ? "فیلترها را پاک کنید تا همهٔ مسیرهای ثبت‌شده را ببینید."
              : "پس از نخستین چرخه‌های جمع‌آوری، مسیرها اینجا ظاهر می‌شوند."}
          </span>
          {filterCount ? (
            <button type="button" className="sa-op-clear glass-control" onClick={clearAll}>
              پاک‌کردن فیلترها
            </button>
          ) : null}
        </section>
      ) : null}

      {GROUP_ORDER.map((group) =>
        groups[group].length ? (
          <OpportunityGroup
            key={group}
            group={group}
            rows={groups[group]}
            evidence={evidence}
            feeMetaById={feeMetaById}
            pollIntervalMs={pollIntervalMs}
            onSelect={onSelect}
          />
        ) : null
      )}
    </div>
  );
}

/* ── pieces ────────────────────────────────────────────────────────────────── */

function SummaryStat({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
  tone: "good" | "warn" | "muted";
}) {
  return (
    <div className={`sa-op-stat sa-rail-${tone}`}>
      <div className="sa-op-stat-label">{label}</div>
      <div className="sa-op-stat-value">{value}</div>
      <div className="sa-op-stat-hint">{hint}</div>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  title
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  title: string;
}) {
  return (
    <label className={`sa-op-toggle${checked ? " is-on glass-control" : ""}`} title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function OpportunityGroup({
  group,
  rows,
  evidence,
  feeMetaById,
  pollIntervalMs,
  onSelect
}: {
  group: OppClass;
  rows: ShadowOpportunity[];
  evidence: Map<string, PaperEvidence>;
  feeMetaById: Map<string, FeeMeta>;
  pollIntervalMs: number;
  onSelect: (o: ShadowOpportunity) => void;
}) {
  const tone = group === "valid" ? "good" : group === "raw" ? "warn" : "muted";
  return (
    <section className={`panel sa-panel sa-op-group sa-rail-${tone}`} aria-label={OPP_CLASS_FA[group]}>
      <div className="panel-header sa-panel-header">
        <h3 className="panel-title sa-panel-title">{OPP_CLASS_FA[group]}</h3>
        <div className="sa-panel-note">
          {formatCountFa(rows.length)} مسیر · {GROUP_MEANING_FA[group]}
        </div>
      </div>

      {/* Desktop: one compact professional table, scrollable inside itself. */}
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
              <th scope="col" title={TOOLTIP_FA.fee}>
                کارمزد دو طرف
              </th>
              <th scope="col" className="num" title={TOOLTIP_FA.buffer}>
                بافر ریسک
              </th>
              <th scope="col" className="num">
                سود نقدی تومانی
              </th>
              <th scope="col" className="num">
                سود خالص اقتصادی
              </th>
              <th scope="col" className="num">
                سود تعدیل‌شده با بافر
              </th>
              <th scope="col">وضعیت و دلیل</th>
              <th scope="col">تازگی و دوام</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => {
              const ev = evidenceFor(o, evidence);
              const fresh = freshnessLabel(Math.max(o.buyAgeMs, o.sellAgeMs), pollIntervalMs);
              const primary = primaryBlockingReason(o);
              return (
                <tr
                  key={o.id}
                  className="sa-row"
                  tabIndex={0}
                  role="button"
                  aria-label={`جزئیات محاسبهٔ خرید از ${o.buySourceName} و فروش در ${o.sellSourceName}`}
                  onClick={() => onSelect(o)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(o);
                    }
                  }}
                >
                  <td>
                    <RouteCell o={o} />
                  </td>
                  <td className="num">{toFaDigits(o.sizeUsdt)}</td>
                  <td className="num">
                    <div className="sa-op-stack">
                      <span>
                        <TomanAmount value={o.buyVwapToman} />
                      </span>
                      <span className="sa-op-sub">
                        <TomanAmount value={o.sellVwapToman} />
                      </span>
                    </div>
                  </td>
                  <td className="num sa-raw">
                    <Bidi>{formatPercentFa(o.rawSpreadPercent, 3, true)}</Bidi>
                  </td>
                  <td>
                    <FeeCell o={o} feeMetaById={feeMetaById} />
                  </td>
                  <td className="num sa-muted-cell">
                    <TomanAmount value={o.slippageBufferToman} />
                  </td>
                  <td className="num">
                    <Money value={ev?.cashPnlIrtToman ?? null} unknownHint={UNKNOWN_PNL_FA} />
                  </td>
                  <td className="num">
                    <Money value={ev?.economicNetPnlToman ?? null} unknownHint={UNKNOWN_PNL_FA} signed />
                  </td>
                  <td className="num">
                    <Money
                      value={ev?.riskAdjustedPnlToman ?? null}
                      unknownHint={UNKNOWN_PNL_FA}
                      signed
                      strong
                    />
                  </td>
                  <td>
                    <StatusCell o={o} primary={primary} />
                  </td>
                  <td>
                    <div className="sa-op-stack">
                      <span className={`sa-fresh sa-fresh-${fresh.tone}`}>{fresh.label}</span>
                      <span className="sa-op-sub">
                        {o.durationMs > 0 ? formatDurationFa(o.durationMs) : "تازه"}
                      </span>
                      {!o.isActive ? <span className="sa-op-sub">چرخهٔ پایان‌یافته</span> : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile: the same facts as readable cards, never a squeezed table. */}
      <div className="panel-body sa-op-cards">
        {rows.map((o) => {
          const ev = evidenceFor(o, evidence);
          const fresh = freshnessLabel(Math.max(o.buyAgeMs, o.sellAgeMs), pollIntervalMs);
          const primary = primaryBlockingReason(o);
          return (
            <article
              key={o.id}
              className="sa-op-card glass-control"
              tabIndex={0}
              role="button"
              aria-label={`جزئیات محاسبهٔ خرید از ${o.buySourceName} و فروش در ${o.sellSourceName}`}
              onClick={() => onSelect(o)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(o);
                }
              }}
            >
              <header className="sa-op-card-head">
                <RouteCell o={o} />
                <span className="sa-op-card-size">{toFaDigits(o.sizeUsdt)} تتر</span>
              </header>
              <dl className="sa-op-card-grid">
                <CardLine label="قیمت خرید" value={<TomanAmount value={o.buyVwapToman} />} />
                <CardLine label="قیمت فروش" value={<TomanAmount value={o.sellVwapToman} />} />
                <CardLine
                  label="اسپرد خام"
                  value={<Bidi>{formatPercentFa(o.rawSpreadPercent, 3, true)}</Bidi>}
                />
                <CardLine label="بافر ریسک" value={<TomanAmount value={o.slippageBufferToman} />} />
                <CardLine
                  label="سود نقدی تومانی"
                  value={<Money value={ev?.cashPnlIrtToman ?? null} unknownHint={UNKNOWN_PNL_FA} />}
                />
                <CardLine
                  label="سود خالص اقتصادی"
                  value={
                    <Money value={ev?.economicNetPnlToman ?? null} unknownHint={UNKNOWN_PNL_FA} signed />
                  }
                />
                <CardLine
                  label="سود تعدیل‌شده با بافر"
                  value={
                    <Money
                      value={ev?.riskAdjustedPnlToman ?? null}
                      unknownHint={UNKNOWN_PNL_FA}
                      signed
                      strong
                    />
                  }
                />
                <CardLine label="تازگی" value={<span className={`sa-fresh sa-fresh-${fresh.tone}`}>{fresh.label}</span>} />
                <CardLine
                  label="مدت دوام"
                  value={o.durationMs > 0 ? formatDurationFa(o.durationMs) : "تازه"}
                />
              </dl>
              <div className="sa-op-card-fees">
                <FeeCell o={o} feeMetaById={feeMetaById} />
              </div>
              <footer className="sa-op-card-foot">
                <StatusCell o={o} primary={primary} />
              </footer>
            </article>
          );
        })}
      </div>
    </section>
  );
}

const UNKNOWN_PNL_FA =
  "این رقم را موتور اجرای کاغذی ثبت می‌کند؛ برای این چرخه ثبتی وجود ندارد.";

function RouteCell({ o }: { o: ShadowOpportunity }) {
  return (
    <div className="sa-op-route">
      <div className="sa-op-route-line">
        <span className="sa-op-route-key">خرید از:</span>
        <strong>{o.buySourceName}</strong>
      </div>
      <div className="sa-op-route-line">
        <span className="sa-op-route-key">فروش در:</span>
        <strong>{o.sellSourceName}</strong>
      </div>
    </div>
  );
}

function FeeCell({
  o,
  feeMetaById
}: {
  o: ShadowOpportunity;
  feeMetaById: Map<string, FeeMeta>;
}) {
  const buy = feeMetaById.get(o.buySourceId) ?? null;
  const sell = feeMetaById.get(o.sellSourceId) ?? null;
  return (
    <div className="sa-op-fees">
      <FeeLeg
        legFa="خرید"
        venueFa={o.buySourceName}
        toman={o.feeUnknown ? null : o.buyFeeToman}
        bps={o.buyFeeBps}
        meta={buy}
      />
      <FeeLeg
        legFa="فروش"
        venueFa={o.sellSourceName}
        toman={o.feeUnknown ? null : o.sellFeeToman}
        bps={o.sellFeeBps}
        meta={sell}
      />
    </div>
  );
}

function FeeLeg({
  legFa,
  venueFa,
  toman,
  bps,
  meta
}: {
  legFa: string;
  venueFa: string;
  toman: number | null;
  bps: number | null;
  meta: FeeMeta | null;
}) {
  return (
    <div className="sa-op-fee-leg">
      <span className="sa-op-fee-label">{legFa}</span>
      <span className="sa-op-fee-value">
        {toman === null ? (
          <span title="کارمزد رسمی این صرافی تأیید نشده است">—</span>
        ) : (
          <TomanAmount value={toman} />
        )}
      </span>
      <span className="sa-op-fee-meta">
        {bps !== null ? <Bidi>{formatPercentFa(bps / 100, 3)}</Bidi> : "—"}
        {meta ? (
          <>
            {" · "}
            <span
              className={`sa-op-fee-prov${meta.stale ? " is-stale" : ""}`}
              title={`منبع کارمزد ${venueFa}: ${meta.provenanceFa}${
                meta.verifiedAt ? ` · تأیید ${meta.verifiedAt}` : ""
              }${meta.stale ? " · اعتبار منقضی شده" : ""}`}
            >
              {meta.provenanceFa}
              {meta.stale ? " (منقضی)" : ""}
            </span>
          </>
        ) : (
          <>{" · "}<span title="وضعیت کارمزد این صرافی گزارش نشده است">نامشخص</span></>
        )}
      </span>
    </div>
  );
}

function StatusCell({ o, primary }: { o: ShadowOpportunity; primary: string | null }) {
  const rest = o.blockedReasons.slice(1);
  return (
    <div className="sa-op-status">
      <span className={`sa-chip sa-chip-${eligibilityTone(o.eligibility)} sa-chip-sm`}>
        {ELIGIBILITY_FA[o.eligibility]}
      </span>
      {primary ? (
        <span className="sa-op-primary-reason" title={blockedDetail(primary)}>
          {blockedShort(primary)}
        </span>
      ) : null}
      {rest.length ? (
        <details className="sa-op-reasons">
          <summary>{toFaDigits(rest.length)} دلیل دیگر</summary>
          <ul>
            {rest.map((r) => (
              <li key={r} title={blockedDetail(r)}>
                {blockedShort(r)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
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
  unknownHint,
  signed,
  strong
}: {
  value: number | null;
  unknownHint: string;
  signed?: boolean;
  strong?: boolean;
}) {
  if (value === null) {
    return (
      <span className="sa-op-unknown" title={unknownHint}>
        —
      </span>
    );
  }
  const tone = signed ? (value > 0 ? " sa-pos" : value < 0 ? " sa-neg" : "") : "";
  return (
    <span className={`${strong ? "sa-op-strong" : ""}${tone}`}>
      <TomanAmount value={value} />
    </span>
  );
}
