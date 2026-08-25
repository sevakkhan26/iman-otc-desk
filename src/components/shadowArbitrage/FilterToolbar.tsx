"use client";

import { useShadowViewState } from "@/components/shadowArbitrage/urlState";

type Props = {
  venues: string[];
  reasons: [string, number][];
  reasonLabel: (code: string) => string;
  windows: { id: string; labelFa: string; ms: number | null }[];
  hideOutcome?: boolean;
};

export function FilterToolbar({ venues, reasons, reasonLabel, windows, hideOutcome = false }: Props) {
  const { read, write } = useShadowViewState();
  const venue = read("av", "all");
  const outcome = read("ao", "all");
  const reason = read("ar", "all");
  const window = read("aw", "all");

  const setFilter = (patch: Record<string, string | null>) => write({ ...patch, ap: "1" });

  return (
    <div className="sa-filter-toolbar glass-tabbar">
      <span className="sa-filter-toolbar-field">
        <select
          className="sa-filter-toolbar-select glass-control"
          value={venue}
          onChange={(e) => setFilter({ av: e.target.value })}
          aria-label="صرافی"
        >
          <option value="all">همه صرافی‌ها</option>
          {venues.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <FilterChevron />
      </span>

      {hideOutcome ? null : (
        <>
          <span className="sa-filter-toolbar-sep" aria-hidden="true" />
          <span className="sa-filter-toolbar-field">
            <select
              className="sa-filter-toolbar-select glass-control"
              value={outcome}
              onChange={(e) => setFilter({ ao: e.target.value })}
              aria-label="نتیجه"
            >
              <option value="all">همه نتایج</option>
              <option value="FILLED">اجراشده</option>
              <option value="SKIPPED">ردشده</option>
            </select>
            <FilterChevron />
          </span>
        </>
      )}

      <span className="sa-filter-toolbar-sep" aria-hidden="true" />

      <span className="sa-filter-toolbar-field">
        <select
          className="sa-filter-toolbar-select glass-control"
          value={reason}
          onChange={(e) => setFilter({ ar: e.target.value })}
          aria-label="دلیل رد"
        >
          <option value="all">همه دلایل</option>
          {reasons.map(([code, n]) => (
            <option key={code} value={code}>
              {`${reasonLabel(code)} (${n})`}
            </option>
          ))}
        </select>
        <FilterChevron />
      </span>

      <span className="sa-filter-toolbar-sep" aria-hidden="true" />

      <span className="sa-filter-toolbar-field">
        <select
          className="sa-filter-toolbar-select glass-control"
          value={window}
          onChange={(e) => setFilter({ aw: e.target.value })}
          aria-label="بازه"
        >
          {windows.map((w) => (
            <option key={w.id} value={w.id}>
              {w.labelFa}
            </option>
          ))}
        </select>
        <FilterChevron />
      </span>
    </div>
  );
}

function FilterChevron() {
  return (
    <svg
      className="sa-filter-toolbar-chevron"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
