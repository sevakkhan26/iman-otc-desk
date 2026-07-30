"use client";

import { useEffect, useState } from "react";
import type { DeskRole } from "@/lib/auth";

/**
 * Current session role for client-side visibility decisions only.
 *
 * This hides UI a viewer must not see; it is NOT a security boundary. Route and
 * API protection stay exactly where they were — the middleware and
 * `requireAdminSession` — and are unchanged by this hook.
 *
 * The in-flight request is shared, so several components asking at once produce
 * one network call rather than one each.
 */
let inFlight: Promise<DeskRole | null> | null = null;

async function fetchRole(): Promise<DeskRole | null> {
  try {
    const response = await fetch("/api/auth/me", {
      cache: "no-store",
      credentials: "same-origin"
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { role?: DeskRole };
    return data?.role === "admin" || data?.role === "viewer" ? data.role : null;
  } catch {
    return null;
  }
}

export function useDeskRole(): DeskRole | null {
  const [role, setRole] = useState<DeskRole | null>(null);

  useEffect(() => {
    let cancelled = false;
    inFlight = inFlight ?? fetchRole();
    void inFlight.then((value) => {
      // Let a later mount retry rather than caching a failed lookup forever.
      if (value === null) inFlight = null;
      if (!cancelled) setRole(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return role;
}
