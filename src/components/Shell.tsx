"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { LogOut, Menu, X } from "lucide-react";
import type { DeskRole } from "@/lib/auth";
import { sidebarNavItems } from "@/lib/sidebarNav";
import { formatAppVersionLabel } from "@/lib/version";
import { PriceAlertToastBridge } from "@/components/PriceAlertToastBridge";

const STORAGE_KEY = "otc-sidebar-collapsed";
const MOBILE_MQ = "(max-width: 760px)";

export function Shell({ children }: Readonly<{ children: React.ReactNode }>) {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [role, setRole] = useState<DeskRole | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const [unreadAlerts, setUnreadAlerts] = useState(0);
  const logoutInFlight = useRef(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const sidebarId = useId();

  // default open; restore the user's last choice after mount (avoids hydration mismatch)
  useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setCollapsed(true);
    } catch {
      /* ignore storage errors */
    }
  }, []);

  useEffect(() => {
    const mq = window.matchMedia(MOBILE_MQ);
    const sync = () => {
      setIsMobile(mq.matches);
      if (!mq.matches) setMobileOpen(false);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Close drawer on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  // Body scroll lock while mobile drawer is open
  useEffect(() => {
    if (!mobileOpen) return;
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
    };
  }, [mobileOpen]);

  // Escape closes drawer
  useEffect(() => {
    if (!mobileOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setMobileOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  // Focus close button when drawer opens
  useEffect(() => {
    if (mobileOpen) {
      requestAnimationFrame(() => closeButtonRef.current?.focus());
    }
  }, [mobileOpen]);

  // Simple focus trap inside open drawer
  useEffect(() => {
    if (!mobileOpen || !drawerRef.current) return;
    const root = drawerRef.current;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const list = Array.from(focusables).filter((el) => !el.hasAttribute("disabled"));
      if (!list.length) return;
      const first = list[0]!;
      const last = list[list.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [mobileOpen]);

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

  const toggleDesktop = () => {
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

  const openMobile = useCallback(() => setMobileOpen(true), []);
  const closeMobile = useCallback(() => {
    setMobileOpen(false);
    requestAnimationFrame(() => menuButtonRef.current?.focus());
  }, []);

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
      window.location.replace("/login");
    } catch {
      setLogoutError("خروج ناموفق بود. دوباره تلاش کنید.");
      setLoggingOut(false);
      logoutInFlight.current = false;
    }
  }

  return (
    <div
      className={`shell ${collapsed ? "collapsed" : ""}${mobileOpen ? " mobile-drawer-open" : ""}`}
    >
      {/* Compact mobile top bar — not the full nav list */}
      <header className="mobile-topbar">
        <div className="brand mobile-topbar-brand">
          <h1 className="brand-title">OTC Desk</h1>
          <div className="brand-subtitle">داشبورد عملیاتی Dealing Desk</div>
        </div>
        <button
          ref={menuButtonRef}
          type="button"
          className="sidebar-toggle mobile-menu-button"
          onClick={() => (mobileOpen ? closeMobile() : openMobile())}
          aria-expanded={mobileOpen}
          aria-controls={sidebarId}
          aria-label={mobileOpen ? "بستن منو" : "باز کردن منو"}
          title={mobileOpen ? "بستن منو" : "باز کردن منو"}
        >
          {mobileOpen ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
        </button>
      </header>

      <div
        className={`sidebar-backdrop${mobileOpen ? " is-open" : ""}`}
        onClick={closeMobile}
        aria-hidden="true"
      />

      <aside
        ref={drawerRef}
        id={sidebarId}
        className={`sidebar${mobileOpen ? " is-open" : ""}`}
        aria-label="منوی اصلی"
        {...(isMobile ? { role: "dialog" as const, "aria-modal": true as const } : {})}
        inert={isMobile && !mobileOpen ? true : undefined}
      >
        <div className="sidebar-top">
          <button
            type="button"
            className="sidebar-toggle desktop-sidebar-toggle"
            onClick={toggleDesktop}
            aria-expanded={!collapsed}
            aria-label={collapsed ? "باز کردن منو" : "بستن منو"}
            title={collapsed ? "باز کردن منو" : "بستن منو"}
          >
            <Menu aria-hidden="true" />
          </button>
          <div className="brand sidebar-brand">
            <h1 className="brand-title" style={{ marginBottom: 0 }}>
              OTC Desk
            </h1>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            className="sidebar-toggle mobile-drawer-close"
            onClick={closeMobile}
            aria-label="بستن منو"
            title="بستن منو"
          >
            <X aria-hidden="true" />
          </button>
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
                onClick={() => {
                  if (isMobile) setMobileOpen(false);
                }}
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
          <div className="sidebar-meta-bottom">
            <div className="sidebar-version" title={formatAppVersionLabel()}>
              <span className="sidebar-version-value">{formatAppVersionLabel()}</span>
            </div>
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
