"use client";

import { getExchangePublicUsdtUrl } from "@/lib/exchangePublicUrls";

type Props = {
  exchangeId: string;
  exchangeName: string;
  /** Visual weight: card header uses span-like styling; table cells use strong. */
  as?: "span" | "strong";
  className?: string;
};

/**
 * Renders an exchange display name. When a verified public USDT page exists for
 * the provider ID, only the name is linked (not the whole card/row).
 */
export function ExchangeNameLink({
  exchangeId,
  exchangeName,
  as = "span",
  className
}: Props) {
  const href = getExchangePublicUsdtUrl(exchangeId);
  const Tag = as === "strong" ? "strong" : "span";
  const nameClass = ["exch-name", className].filter(Boolean).join(" ");

  if (!href) {
    return <Tag className={nameClass}>{exchangeName}</Tag>;
  }

  return (
    <a
      className={["exch-name-link", nameClass].filter(Boolean).join(" ")}
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={`${exchangeName} — صفحه عمومی تتر (تب جدید)`}
    >
      <Tag className="exch-name-link-text">{exchangeName}</Tag>
      <span className="sr-only"> (باز شدن در تب جدید)</span>
    </a>
  );
}
