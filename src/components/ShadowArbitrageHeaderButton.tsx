"use client";

import { usePathname } from "next/navigation";
import { GitCompareArrows } from "lucide-react";
import { GlassIconButton } from "@/components/ui/GlassIconButton";
import { useDeskRole } from "@/hooks/useDeskRole";

export const SHADOW_SHORTCUT_LABEL = "آربیتراژ آزمایشی";
export const SHADOW_SHORTCUT_HREF = "/shadow-arbitrage";

/**
 * Header shortcut to the Shadow Arbitrage page.
 *
 * It is the same `GlassIconButton` the Theme, Account and Alerts controls use,
 * so dimensions, border, radius, glass surface, hover, active, dark/light and
 * responsive behaviour are inherited rather than re-implemented — there is no
 * new component and no new CSS.
 *
 * Admin-only, matching the sidebar item it replaces. Hiding it from viewers is
 * a UI concern only: the route and API protection are untouched.
 */
export function ShadowArbitrageHeaderButton() {
  const role = useDeskRole();
  const pathname = usePathname();

  if (role !== "admin") return null;

  const active =
    pathname === SHADOW_SHORTCUT_HREF || pathname.startsWith(`${SHADOW_SHORTCUT_HREF}/`);

  return (
    <GlassIconButton
      href={SHADOW_SHORTCUT_HREF}
      label={SHADOW_SHORTCUT_LABEL}
      tooltip={SHADOW_SHORTCUT_LABEL}
      active={active}
    >
      <GitCompareArrows size={18} strokeWidth={1.75} />
    </GlassIconButton>
  );
}
