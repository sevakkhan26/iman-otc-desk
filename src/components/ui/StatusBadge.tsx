"use client";

import type { ReactNode } from "react";

export type StatusTone = "success" | "warning" | "danger" | "info" | "neutral" | "stale" | "offline";

const TONE_FA: Record<StatusTone, string> = {
  success: "موفق",
  warning: "هشدار",
  danger: "خطر",
  info: "اطلاع",
  neutral: "خنثی",
  stale: "قدیمی",
  offline: "آفلاین"
};

/**
 * iOS 27 kit status badge — color is never the only cue (dot + label).
 * Ported from iran-pay StatusBadge pattern (without trade-status coupling).
 */
export function StatusBadge({
  label,
  tone = "neutral",
  children
}: {
  label?: string;
  tone?: StatusTone;
  children?: ReactNode;
}) {
  const text = children ?? label ?? "";
  return (
    <span
      className={`status-badge status-badge--${tone}`}
      role="status"
      aria-label={`${String(text)}، ${TONE_FA[tone] ?? tone}`}
    >
      {text}
    </span>
  );
}
