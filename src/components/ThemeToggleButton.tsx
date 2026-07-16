"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";

/**
 * Header icon control — same size/style as Refresh (icon-button).
 * Light → moon (enable night); Dark → sun (enable day).
 */
export function ThemeToggleButton() {
  const { theme, setTheme } = useTheme();
  const isDark = theme === "dark";
  const label = isDark ? "فعال‌کردن حالت روز" : "فعال‌کردن حالت شب";

  return (
    <button
      type="button"
      className="icon-button"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      title={label}
      aria-label={label}
    >
      {isDark ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
    </button>
  );
}
