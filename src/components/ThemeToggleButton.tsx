"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "@/hooks/useTheme";
import { GlassIconButton } from "@/components/ui/GlassIconButton";

/**
 * Header theme control — neutral glass (never brand gold).
 * Mount-gated so SSR + first client paint match (React #418 safe).
 */
export function ThemeToggleButton() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const isDark = !mounted || theme === "dark";
  const label = isDark ? "فعال‌کردن حالت روز" : "فعال‌کردن حالت شب";

  return (
    <GlassIconButton label={label} tooltip={label} onClick={() => setTheme(isDark ? "light" : "dark")}>
      {isDark ? <Sun size={18} strokeWidth={1.75} /> : <Moon size={18} strokeWidth={1.75} />}
    </GlassIconButton>
  );
}
