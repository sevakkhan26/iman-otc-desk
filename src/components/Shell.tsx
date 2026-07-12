"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { LogOut, Menu, ShieldAlert } from "lucide-react";
import type { DeskRole } from "@/lib/auth";
import { sidebarNavItems } from "@/lib/sidebarNav";
import { formatAppVersionLabel } from "@/lib/version";

const STORAGE_KEY = "otc-sidebar-collapsed";
const tehranTimeFmt = new Intl.DateTimeFormat("fa-IR", {
  timeZone: "Asia/Tehran",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
});

export function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [tehranTime, setTehranTime] = useState<string | null>(null);
  const [role, setRole] = useState<DeskRole | null>(null);

  // default open; restore the user's last choice after mount (avoids hydration mismatch)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  useEffect(() => {
    const update = () => setTehranTime(tehranTimeFmt.format(new Date()));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { role?: DeskRole };
      })
      .then((data) => {
        if (data?.role === "admin" || data?.role === "viewer") setRole(data.role);
      })
      .catch(() => {});
  }, []);

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
              </Link>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="sidebar-meta-bottom">
            <div className="sidebar-tehran-time" title="ساعت به وقت تهران">
              ساعت تهران: <span className="sidebar-meta-value number">{tehranTime ?? "—"}</span>
            </div>
            <div className="sidebar-version" title={`نسخه: ${formatAppVersionLabel()}`}>
              نسخه: <span className="sidebar-version-value">{formatAppVersionLabel()}</span>
            </div>
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