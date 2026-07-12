"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, Menu, ShieldAlert } from "lucide-react";
import { sidebarNavItems } from "@/lib/sidebarNav";
import { formatAppVersionLabel } from "@/lib/version";

const STORAGE_KEY = "otc-sidebar-collapsed";

export function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  // default open; restore the user's last choice after mount (avoids hydration mismatch)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* ignore storage errors */
    }
  }, []);

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
          {sidebarNavItems.map((item) => {
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
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-version" title={`نسخه: ${formatAppVersionLabel()}`}>
            نسخه: <span className="sidebar-version-value">{formatAppVersionLabel()}</span>
          </div>
          <button
            type="button"
            className="nav-link logout-link"
            title="خروج"
            onClick={() => {
              fetch("/api/auth/logout", { method: "POST" })
                .catch(() => {})
                .finally(() => window.location.replace("/login"));
            }}
          >
            <LogOut aria-hidden="true" />
            <span>خروج</span>
          </button>
          <div className="sidebar-foot">
            <ShieldAlert aria-hidden="true" size={17} />
            <div className="sidebar-foot-text">منابع واقعی؛ منبع قطع باشد، عددی نمایش داده نمی‌شود.</div>
          </div>
        </div>
      </aside>
      <main className="main">{children}</main>
    </div>
  );
}