"use client";

import { formatToman, formatTomanCore } from "@/components/format";

type TomanAmountProps = {
  value: number | null | undefined;
  className?: string;
  /** Optional title / aria; defaults to the formatted string. */
  title?: string;
};

/**
 * Shared Toman display: complete `{number} تومان` as one LTR-isolated unit.
 * Prefer this in React trees; `formatToman()` is the string equivalent for tables/tooltips.
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
