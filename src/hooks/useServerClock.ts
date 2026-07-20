"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Server-authoritative clock for UI display.
 * Synchronizes once to `serverNow` (UTC ISO), then advances with monotonic
 * `performance.now()` — never uses the browser wall clock as source of truth.
 * Re-syncs whenever a new serverNow arrives (API poll).
 */
export function useServerClock(serverNowIso: string | null | undefined): number | null {
  const [displayMs, setDisplayMs] = useState<number | null>(null);
  const baseRef = useRef<{ serverMs: number; perfMs: number } | null>(null);

  useEffect(() => {
    if (!serverNowIso) return;
    const serverMs = Date.parse(serverNowIso);
    if (!Number.isFinite(serverMs)) return;

    const perfMs = performance.now();
    baseRef.current = { serverMs, perfMs };
    setDisplayMs(serverMs);

    const id = window.setInterval(() => {
      const base = baseRef.current;
      if (!base) return;
      setDisplayMs(base.serverMs + (performance.now() - base.perfMs));
    }, 1_000);

    return () => window.clearInterval(id);
  }, [serverNowIso]);

  return displayMs;
}

/** Parse server ISO (or epoch ms) to epoch ms without using client "now". */
export function serverTimeToEpochMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}
