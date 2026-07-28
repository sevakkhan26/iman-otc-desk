import type { ReactNode } from "react";

type MaterialVariant = "card" | "elevated" | "modal" | "subtle" | "popover";

const VARIANT_CLASS: Record<MaterialVariant, string> = {
  card: "material-card",
  elevated: "material-elevated",
  modal: "material-modal",
  subtle: "material-subtle",
  popover: "material-popover"
};

/**
 * Surface primitive — Liquid Glass / Materials from iOS 27 kit.
 */
export function Material({
  variant = "card",
  className,
  children
}: {
  variant?: MaterialVariant;
  className?: string;
  children?: ReactNode;
}) {
  const cls = [VARIANT_CLASS[variant], className].filter(Boolean).join(" ");
  return <div className={cls}>{children}</div>;
}
