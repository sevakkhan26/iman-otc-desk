"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { AlertsHeaderButton } from "@/components/AlertsHeaderButton";
import { ProfileMenu } from "@/components/ProfileMenu";
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
 * title (start) | live clock + last-update with compact refresh | theme + profile + alerts (end)
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

  const refreshButton =
    onRefresh != null ? (
      <button
        type="button"
        className="icon-button icon-button--compact last-update-refresh"
        onClick={onRefresh}
        title="بروزرسانی"
        aria-label="بروزرسانی"
        disabled={loading}
      >
        <RefreshCw aria-hidden="true" className={loading ? "spinning" : undefined} />
      </button>
    ) : null;

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
          <div className="last-update last-update-row">
            <span className="last-update-text">
              <span className="last-update-label">آخرین به‌روزرسانی:</span>{" "}
              <span className="number">{lastUpdateText}</span>
            </span>
            {refreshButton}
          </div>
        ) : refreshButton ? (
          <div className="last-update last-update-row">{refreshButton}</div>
        ) : null}
      </div>

      {/* RTL flex start = right: Alerts sits to the right of Profile */}
      <div className="header-meta header-actions">
        <AlertsHeaderButton />
        <ProfileMenu />
        <ThemeToggleButton />
      </div>
    </header>
  );
}
