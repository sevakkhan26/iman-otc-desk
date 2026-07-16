"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { LogOut, Menu, ShieldAlert } from "lucide-react";
import type { DeskRole } from "@/lib/auth";
import { sidebarNavItems } from "@/lib/sidebarNav";
import { formatAppVersionLabel } from "@/lib/version";
import { PriceAlertToastBridge } from "@/components/PriceAlertToastBridge";

const STORAGE_KEY = "otc-sidebar-collapsed";
export function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [role, setRole] = useState<DeskRole | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const logoutInFlight = useRef(false);

  // default open; restore the user's last choice after mount (avoids hydration mismatch)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { role?: DeskRole };
      })
      .then((data) => {
        if (data?.role === "admin" || data?.role === "viewer") setRole(data.role);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    const pull = () => {
      fetch("/api/alerts/notifications?evaluate=1", { cache: "no-store", credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) return null;
          return (await response.json()) as { unread?: number };
        })
        .then((data) => {
          if (!cancelled && typeof data?.unread === "number") setUnreadAlerts(data.unread);
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

  const navItems = sidebarNavItems.filter((item) => !item.adminOnly || role === "admin");

  const toggle = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* ignore storage errors */
      }
      return next;
    });
  };

  async function handleLogout() {
    if (logoutInFlight.current || loggingOut) return;
    logoutInFlight.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    try {
      const response = await fetch("/api/auth/logout", {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store"
      });
      if (!response.ok) {
        setLogoutError("خروج ناموفق بود. دوباره تلاش کنید.");
        setLoggingOut(false);
        logoutInFlight.current = false;
        return;
      }
      // Only redirect after the server confirms cookie clear
      window.location.replace("/login");
    } catch {
      setLogoutError("خروج ناموفق بود. دوباره تلاش کنید.");
      setLoggingOut(false);
      logoutInFlight.current = false;
    }
  }

  return (
    <div className={`shell ${collapsed ? "collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <button
            type="button"
            className="sidebar-toggle"
            onClick={toggle}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "باز کردن منو" : "بستن منو"}
            title={collapsed ? "باز کردن منو" : "بستن منو"}
          >
            <Menu aria-hidden="true" />
          </button>
          <div className="brand">
            <h1 className="brand-title">OTC Desk</h1>
            <div className="brand-subtitle">داشبورد عملیاتی Dealing Desk</div>
          </div>
        </div>
        <nav className="nav" aria-label="صفحات">
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                className={`nav-link ${active ? "active" : ""}`}
                href={item.href}
                title={item.label}
              >
                <Icon aria-hidden="true" />
                <span>{item.label}</span>
                {item.href === "/alerts" && unreadAlerts > 0 ? (
                  <span className="nav-badge" aria-label={`${unreadAlerts} اعلان خوانده‌نشده`}>
                    {unreadAlerts > 99 ? "99+" : unreadAlerts}
                  </span>
                ) : null}
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-meta-bottom">
            <div className="sidebar-version" title={`نسخه: ${formatAppVersionLabel()}`}>
              نسخه: <span className="sidebar-version-value">{formatAppVersionLabel()}</span>
            </div>
          </div>
          {logoutError ? (
            <div className="sidebar-logout-error" role="alert">
              {logoutError}
            </div>
          ) : null}
          <button
            type="button"
            className="nav-link logout-link"
            title="خروج"
            disabled={loggingOut}
            aria-busy={loggingOut}
            onClick={() => {
              void handleLogout();
            }}
          >
            <LogOut aria-hidden="true" />
            <span>{loggingOut ? "در حال خروج..." : "خروج"}</span>
          </button>
          <div className="sidebar-foot">
            <ShieldAlert aria-hidden="true" size={17} />
            <div className="sidebar-foot-text">منابع واقعی؛ منبع قطع باشد، عددی نمایش داده نمی‌شود.</div>
          </div>
        </div>
      </aside>
      <main className="main">
        <PriceAlertToastBridge />
        {children}
      </main>
    </div>
  );
}
