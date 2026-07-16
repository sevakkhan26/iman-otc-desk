"use client";

import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "dark" | "light";

const STORAGE_KEY = "otc-theme";

function readThemeFromDom(): ThemeMode {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}

/** Shared theme state — same localStorage key and data-theme attribute as the boot script. */
export function useTheme(): { theme: ThemeMode; setTheme: (mode: ThemeMode) => void; toggleTheme: () => void } {
  // Default matches layout.html data-theme="dark"; boot script may set light before paint.
  const [theme, setThemeState] = useState<ThemeMode>("dark");

  useEffect(() => {
    setThemeState(readThemeFromDom());
  }, []);

  const setTheme = useCallback((mode: ThemeMode) => {
    document.documentElement.setAttribute("data-theme", mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* ignore storage errors */
    }
    setThemeState(mode);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(readThemeFromDom() === "dark" ? "light" : "dark");
  }, [setTheme]);

  return { theme, setTheme, toggleTheme };
}
