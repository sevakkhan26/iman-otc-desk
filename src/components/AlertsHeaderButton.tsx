"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Bell } from "lucide-react";

/**
 * Header alerts control — same /alerts route and unread poll as the former sidebar item.
 */
export function AlertsHeaderButton() {
  const pathname = usePathname();
  const [unread, setUnread] = useState(0);
  const active = pathname === "/alerts";

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      fetch("/api/alerts/notifications?evaluate=1", {
        cache: "no-store",
        credentials: "same-origin"
      })
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as { unread?: number };
        })
        .then((data) => {
          if (!cancelled && typeof data?.unread === "number") setUnread(data.unread);
        })
        .catch(() => {});
    };
    pull();
    const id = window.setInterval(pull, 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pathname]);

  return (
    <Link
      href="/alerts"
      className={`icon-button header-alerts-button${active ? " is-active" : ""}`}
      title="هشدارها"
      aria-label={unread > 0 ? `هشدارها، ${unread} اعلان خوانده‌نشده` : "هشدارها"}
    >
      <Bell aria-hidden="true" />
      {unread > 0 ? (
        <span className="header-alerts-badge" aria-hidden="true">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
