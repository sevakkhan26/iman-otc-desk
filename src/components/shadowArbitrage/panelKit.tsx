"use client";

import { Bidi } from "@/components/shadowArbitrage/Bidi";
import { formatCountFa, toFaDigits } from "@/components/shadowArbitrage/labels";

/**
 * Phase 8B — the two layout pieces both redesigned tabs share.
 *
 * Both are pure presentation built from the shared glass primitives: a KPI card
 * is a `.panel`, and every control in the pager is a `.glass-control` inside a
 * `.glass-tabbar`. Neither invents a surface of its own.
 */

/** One headline number: a label, the figure, and a single supporting line. */
export function Kpi({
  label,
  value,
  hint,
  tone
}: {
  label: string;
  value: React.ReactNode;
  hint: string;
  tone: "good" | "warn" | "danger" | "muted";
}) {
  return (
    <section className={`panel sa-panel sa-kpi sa-rail-${tone}`}>
      <div className="panel-body sa-kpi-body">
        <div className="sa-kpi-label">{label}</div>
        <div className="sa-kpi-value">{value}</div>
        <div className="sa-kpi-hint">{hint}</div>
      </div>
    </section>
  );
}

/**
 * Page controls for an already-paged list.
 *
 * Page size is optional: the Opportunities table offers 10 / 20 / 50, while the
 * venue grid is a fixed six cards a page.
 */
export function Pager({
  page,
  pageCount,
  total,
  from,
  to,
  perPage,
  pageSizes,
  onPage,
  onPerPage
}: {
  page: number;
  pageCount: number;
  total: number;
  from: number;
  to: number;
  perPage: number;
  pageSizes?: readonly number[];
  onPage: (p: number) => void;
  onPerPage?: (n: number) => void;
}) {
  return (
    <div className="panel-body sa-pager" role="navigation" aria-label="صفحه‌بندی نتایج">
      <div className="sa-pager-count">
        <Bidi>{`${toFaDigits(from)}–${toFaDigits(to)}`}</Bidi> از {formatCountFa(total)} نتیجه
      </div>

      {pageSizes && onPerPage ? (
        <div className="sa-pager-size">
          <span className="sa-field-label">در هر صفحه</span>
          <div className="sa-segmented glass-tabbar">
            {pageSizes.map((n) => (
              <button
                key={n}
                type="button"
                className={`sa-seg${perPage === n ? " is-active glass-control" : ""}`}
                aria-pressed={perPage === n}
                onClick={() => onPerPage(n)}
              >
                {toFaDigits(n)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="sa-pager-size sa-sub">
          {toFaDigits(perPage)} مورد در هر صفحه
        </div>
      )}

      <div className="sa-pager-nav">
        <button
          type="button"
          className="sa-btn-page glass-control"
          onClick={() => onPage(page - 1)}
          disabled={page <= 1}
        >
          قبلی
        </button>
        <span className="sa-pager-page">
          صفحهٔ <Bidi>{`${toFaDigits(page)} / ${toFaDigits(pageCount)}`}</Bidi>
        </span>
        <button
          type="button"
          className="sa-btn-page glass-control"
          onClick={() => onPage(page + 1)}
          disabled={page >= pageCount}
        >
          بعدی
        </button>
      </div>
    </div>
  );
}
