"use client";

import { formatToman, formatTomanCore } from "@/components/format";

type TomanAmountProps = {
  value: number | null | undefined;
  className?: string;
  title?: string;
};

/**
 * Shared Toman display: isolated LTR unit with visual order
 * LEFT «تومان» · RIGHT amount (Persian digits, sign preserved).
 */
export function TomanAmount({ value, className, title }: TomanAmountProps) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return <span className={className}>{formatToman(value)}</span>;
  }

  const plain = formatTomanCore(value);
  return (
    <bdi dir="ltr" className={className ? `toman-amount ${className}` : "toman-amount"} title={title ?? plain}>
      {plain}
    </bdi>
  );
}
