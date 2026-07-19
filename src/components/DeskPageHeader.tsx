"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { ThemeToggleButton } from "@/components/ThemeToggleButton";

const CLOCK_TICK_MS = 1_000;

const clockDateFmt = new Intl.DateTimeFormat("fa-IR", {
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Tehran"
});

const clockTimeFmt = new Intl.DateTimeFormat("fa-IR", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "Asia/Tehran"
});

function formatLastUpdatedDateTime(ts: number): string {
  return `${clockDateFmt.format(ts)}، ${clockTimeFmt.format(ts)}`;
}

export type DeskPageHeaderProps = {
  title: ReactNode;
  onRefresh?: () => void;
  /** Client poll timestamp (Date.now() from useApi). */
  lastUpdated?: number | null;
  /** Optional override string (e.g. gold provider Tehran time). */
  lastUpdatedDisplay?: string | null;
  loading?: boolean;
  /** Hide last-update text (e.g. help page). Clock still shows. */
  showLastUpdate?: boolean;
};

/**
 * Shared desk page header for every route:
 * title (start) | live clock + last update on one centered line | refresh + theme (end)
 */
export function DeskPageHeader({
  title,
  onRefresh,
  lastUpdated = null,
  lastUpdatedDisplay = null,
  loading = false,
  showLastUpdate = true
}: DeskPageHeaderProps) {
  // mount-guarded so server render matches first client paint, then ticks every second
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const lastUpdateText =
    lastUpdatedDisplay ??
    (lastUpdated != null ? formatLastUpdatedDateTime(lastUpdated) : "—");

  return (
    <header className="page-header page-header--desk">
      <h2 className="page-title">{title}</h2>

      <div className="header-center header-center--inline" aria-live="polite">
        <div className="clock" title="تاریخ و ساعت جاری (تهران)">
          <Clock aria-hidden="true" size={15} />
          <span className="clock-time number">{now ? clockTimeFmt.format(now) : "—"}</span>
          <span className="clock-date">{now ? clockDateFmt.format(now) : "—"}</span>
        </div>
        {showLastUpdate ? (
          <div className="last-update">
            <span className="last-update-label">آخرین به‌روزرسانی:</span>{" "}
            <span className="number">{lastUpdateText}</span>
          </div>
        ) : null}
      </div>

      <div className="header-meta header-actions">
        {onRefresh ? (
          <button
            type="button"
            className="icon-button"
            onClick={onRefresh}
            title="بروزرسانی"
            aria-label="بروزرسانی"
            disabled={loading}
          >
            <RefreshCw aria-hidden="true" className={loading ? "spinning" : undefined} />
          </button>
        ) : null}
        <ThemeToggleButton />
      </div>
    </header>
  );
}
