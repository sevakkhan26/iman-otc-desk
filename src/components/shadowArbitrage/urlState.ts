"use client";

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Phase 8B — view state that survives a refresh.
 *
 * The selected category, the page and the page size live in the query string
 * next to `tab`, so a reload, a bookmark and the browser's back button all land
 * on the same view. `replace` is used so paging does not fill the history stack.
 */
export function useShadowViewState() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const read = useCallback(
    (key: string, fallback: string) => searchParams.get(key) ?? fallback,
    [searchParams]
  );

  const write = useCallback(
    (patch: Record<string, string | null>) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [pathname, router, searchParams]
  );

  return { read, write };
}

/** Clamp a query-string integer; anything unparsable falls back. */
export function readInt(value: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
