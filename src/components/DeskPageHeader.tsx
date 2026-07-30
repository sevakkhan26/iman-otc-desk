"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Clock, RefreshCw } from "lucide-react";
import { AlertsHeaderButton } from "@/components/AlertsHeaderButton";
import { ProfileMenu } from "@/components/ProfileMenu";
import { ShadowArbitrageHeaderButton } from "@/components/ShadowArbitrageHeaderButton";
import { ThemeToggleButton } from "@/components/ThemeToggleButton";
import { GlassIconButton } from "@/components/ui/GlassIconButton";
import { useServerClock } from "@/hooks/useServerClock";

/* Latin digits (nu-latn) — matches kit financial presentation + SSR/CSR stability */
const clockDateFmt = new Intl.DateTimeFormat("fa-IR-u-nu-latn", {
  weekday: "short",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "Asia/Tehran"
});

const clockTimeFmt = new Intl.DateTimeFormat("fa-IR-u-nu-latn", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "Asia/Tehran"
});

function formatLastUpdatedDateTime(ts: number): string {
  return `${clockDateFmt.format(ts)}، ${clockTimeFmt.format(ts)}`;
}

export type DeskPageHeaderProps = {
  title: ReactNode;
  onRefresh?: () => void;
  /**
   * Last-update instant as epoch ms derived from the server snapshot
   * (e.g. summary.lastUpdated / generatedAt). Not browser receive time.
   */
  lastUpdated?: number | null;
  /** Optional override string (e.g. gold provider Tehran time already formatted). */
  lastUpdatedDisplay?: string | null;
  /**
   * UTC ISO `serverNow` from the latest API payload.
   * Drives the live clock for all devices identically.
   */
  serverNow?: string | null;
  loading?: boolean;
  /** Hide last-update text (e.g. help page). Clock still shows when serverNow is set. */
  showLastUpdate?: boolean;
};

/**
 * Shared desk page header for every route:
 * title | server-synced Tehran clock + last-update | theme + profile + alerts
 */
export function DeskPageHeader({
  title,
  onRefresh,
  lastUpdated = null,
  lastUpdatedDisplay = null,
  serverNow = null,
  loading = false,
  showLastUpdate = true
}: DeskPageHeaderProps) {
  // Bootstrap: wait for client mount; display only after serverNow arrives
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  const clockMs = useServerClock(serverNow);

  const lastUpdateText =
    lastUpdatedDisplay ??
    (lastUpdated != null ? formatLastUpdatedDateTime(lastUpdated) : "—");

  const refreshButton =
    onRefresh != null ? (
      <GlassIconButton
        label="بروزرسانی"
        tooltip="بروزرسانی"
        onClick={onRefresh}
        disabled={loading}
        aria-busy={loading}
        className="glass-icon-button--compact last-update-refresh"
      >
        <RefreshCw size={16} strokeWidth={1.75} className={loading ? "spinning" : undefined} />
      </GlassIconButton>
    ) : null;

  return (
    <header className="page-header page-header--desk glass-toolbar">
      <h2 className="page-title text-page-title">{title}</h2>

      <div className="header-center header-center--inline" aria-live="polite">
        <div className="clock" title="تاریخ و ساعت سرور (تهران)">
          <Clock aria-hidden="true" size={15} />
          <span className="clock-time number" suppressHydrationWarning>
            {mounted && clockMs != null ? clockTimeFmt.format(clockMs) : "—"}
          </span>
          <span className="clock-date" suppressHydrationWarning>
            {mounted && clockMs != null ? clockDateFmt.format(clockMs) : "—"}
          </span>
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
      <div className="header-meta header-actions" role="group" aria-label="کنترل‌های هدر">
        <AlertsHeaderButton />
        <span className="header-actions-divider" aria-hidden="true" />
        <ProfileMenu />
        <ShadowArbitrageHeaderButton />
        <span className="header-actions-divider" aria-hidden="true" />
        <ThemeToggleButton />
      </div>
    </header>
  );
}
