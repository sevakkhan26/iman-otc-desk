"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { CircleHelp, LogOut, Settings, User } from "lucide-react";
import type { DeskRole } from "@/lib/auth";
import { performClientLogout } from "@/lib/clientLogout";

function roleLabel(role: DeskRole | null): string | null {
  if (role === "admin") return "مدیر";
  if (role === "viewer") return "بیننده";
  return null;
}

/**
 * Header profile control: icon button + compact RTL dropdown
 * (settings, help, logout). Uses existing /api/auth/me and logout.
 */
export function ProfileMenu() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<DeskRole | null>(null);
  const [username, setUsername] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const logoutInFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store", credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) return null;
        return (await response.json()) as { role?: DeskRole; username?: string; user?: string };
      })
      .then((data) => {
        if (cancelled || !data) return;
        if (data.role === "admin" || data.role === "viewer") setRole(data.role);
        const name =
          (typeof data.username === "string" && data.username.trim()) ||
          (typeof data.user === "string" && data.user.trim()) ||
          "";
        if (name) setUsername(name);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    setLogoutError(null);
  }, []);

  // Close on navigation / route selection
  useEffect(() => {
    setOpen(false);
    setLogoutError(null);
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      const root = rootRef.current;
      if (!root) return;
      const target = event.target as Node | null;
      if (target && !root.contains(target)) close();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, close]);

  async function handleLogout() {
    if (logoutInFlight.current || loggingOut) return;
    logoutInFlight.current = true;
    setLoggingOut(true);
    setLogoutError(null);
    const err = await performClientLogout();
    if (err) {
      setLogoutError(err);
      setLoggingOut(false);
      logoutInFlight.current = false;
    }
  }

  const roleText = roleLabel(role);
  const showHeader = Boolean(username || roleText);

  return (
    <div className="profile-menu" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="icon-button"
        title="حساب کاربری"
        aria-label="منوی حساب کاربری"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((v) => !v)}
      >
        <User aria-hidden="true" />
      </button>
      {open ? (
        <div
          id={menuId}
          className="profile-menu-panel"
          role="menu"
          aria-label="منوی حساب کاربری"
        >
          {showHeader ? (
            <div className="profile-menu-header">
              {username ? <div className="profile-menu-username">{username}</div> : null}
              {roleText ? <div className="profile-menu-role muted small">{roleText}</div> : null}
            </div>
          ) : null}
          {role === "admin" ? (
            <Link
              href="/settings"
              className="profile-menu-item"
              role="menuitem"
              onClick={close}
            >
              <Settings aria-hidden="true" size={16} />
              <span>تنظیمات</span>
            </Link>
          ) : null}
          <Link href="/help" className="profile-menu-item" role="menuitem" onClick={close}>
            <CircleHelp aria-hidden="true" size={16} />
            <span>راهنما</span>
          </Link>
          <button
            type="button"
            className="profile-menu-item profile-menu-logout"
            role="menuitem"
            disabled={loggingOut}
            aria-busy={loggingOut}
            onClick={() => {
              void handleLogout();
            }}
          >
            <LogOut aria-hidden="true" size={16} />
            <span>{loggingOut ? "در حال خروج..." : "خروج"}</span>
          </button>
          {logoutError ? (
            <div className="profile-menu-error" role="alert">
              {logoutError}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
