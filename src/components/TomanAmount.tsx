"use client";

import { formatToman, formatTomanDigits } from "@/components/format";

type TomanAmountProps = {
  value: number | null | undefined;
  className?: string;
};

/**
 * Surgical Toman display:
 * - Outer fragment stays in RTL flow (sentence/card order unchanged).
 * - Only the number is LTR-isolated via <bdi dir="ltr">.
 * - Visual: RIGHT → amount → تومان → LEFT.
 */
export function TomanAmount({ value, className }: TomanAmountProps) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={className}>{formatToman(value)}</span>;
  }

  return (
    <span className={className ? `toman-amount ${className}` : "toman-amount"} dir="rtl">
      <bdi dir="ltr" className="toman-amount-num">
        {formatTomanDigits(value)}
      </bdi>
      <span className="toman-amount-unit">{"\u00A0"}تومان</span>
    </span>
  );
}
