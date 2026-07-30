"use client";

/**
 * Bidirectional isolation for a value inside Persian RTL text.
 *
 * Ratios («۳ / ۹»), percentages, latencies and route strings are left-to-right
 * runs that reverse visually when the browser resolves them inside an RTL
 * paragraph. Wrapping isolates the run, so «۳ / ۹» is never rendered as «۹ / ۳».
 */
export function Bidi({ children }: { children: React.ReactNode }) {
  return <span className="sa-bidi">{children}</span>;
}
