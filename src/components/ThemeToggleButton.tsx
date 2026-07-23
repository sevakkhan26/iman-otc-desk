"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";

/**
 * Header icon control — same size/style as Refresh (icon-button).
 * Light → moon (enable night); Dark → sun (enable day).
 * Mount-gated so SSR + first client paint always match (React #418 safe).
 */
export function ThemeToggleButton() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Until mounted, assume dark (matches layout data-theme default + boot script fallback).
  const isDark = !mounted || theme === "dark";
  const label = isDark ? "فعال‌کردن حالت روز" : "فعال‌کردن حالت شب";

  return (
    <button
      type="button"
      className="icon-button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={label}
      aria-label={label}
      suppressHydrationWarning
    >
      {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}
