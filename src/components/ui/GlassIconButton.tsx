"use client";

import Link from "next/link";
import {
  forwardRef,
  type ButtonHTMLAttributes,
  type ReactNode
} from "react";
import { GlassTooltip } from "@/components/ui/GlassTooltip";

export type GlassIconButtonProps = {
  label: string;
  children: ReactNode;
  tooltip?: string;
  suppressTooltip?: boolean;
  active?: boolean;
  className?: string;
  badge?: ReactNode;
  href?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>["onClick"];
  "aria-expanded"?: boolean;
  "aria-haspopup"?: ButtonHTMLAttributes<HTMLButtonElement>["aria-haspopup"];
  "aria-controls"?: string;
  "aria-busy"?: boolean | "true" | "false";
};

function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

/**
 * Neutral iOS 27 glass utility control — never brand-gold primary.
 */
export const GlassIconButton = forwardRef<HTMLButtonElement, GlassIconButtonProps>(
  function GlassIconButton(
    {
      label,
      children,
      tooltip,
      suppressTooltip = false,
      active = false,
      className,
      badge,
      href,
      type = "button",
      disabled,
      onClick,
      "aria-expanded": ariaExpanded,
      "aria-haspopup": ariaHaspopup,
      "aria-controls": ariaControls,
      "aria-busy": ariaBusy
    },
    ref
  ) {
    const tip = suppressTooltip ? undefined : tooltip ?? label;
    const classes = cn("glass-icon-button", "glass-control", active && "is-active", className);

    const control = href ? (
      <Link href={href} className={classes} aria-label={label}>
        <span className="glass-icon-button-glyph" aria-hidden="true">
          {children}
        </span>
        {badge}
      </Link>
    ) : (
      <button
        ref={ref}
        type={type}
        className={classes}
        aria-label={label}
        disabled={disabled}
        aria-expanded={ariaExpanded}
        aria-haspopup={ariaHaspopup}
        aria-controls={ariaControls}
        aria-busy={ariaBusy}
        onClick={onClick}
      >
        <span className="glass-icon-button-glyph" aria-hidden="true">
          {children}
        </span>
        {badge}
      </button>
    );

    if (!tip) return control;
    return (
      <GlassTooltip label={tip} disabled={suppressTooltip}>
        {control}
      </GlassTooltip>
    );
  }
);
