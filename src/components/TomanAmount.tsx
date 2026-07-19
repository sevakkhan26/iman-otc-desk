"use client";

import { formatToman, formatTomanDigits } from "@/components/format";

type TomanAmountProps = {
  value: number | null | undefined;
  className?: string;
};

/**
 * Atomic Toman amount — LTR only on this isolated fragment.
 * Visual L→R: «تومان» then number (unit left, amount right).
 * Parents/sentences stay RTL; do not put dir=ltr on rows/cards.
 */
export function TomanAmount({ value, className }: TomanAmountProps) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={className}>{formatToman(value)}</span>;
  }

  return (
    <span
      dir="ltr"
      className={className ? `toman-amount ${className}` : "toman-amount"}
    >
      <span dir="rtl" className="toman-amount-unit">
        تومان
      </span>
      <bdi dir="ltr" className="toman-amount-num">
        {formatTomanDigits(value)}
      </bdi>
    </span>
  );
}
