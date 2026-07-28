"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { OverlayPortal } from "@/components/ui/OverlayPortal";

type Props = {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  placement?: "top" | "bottom";
};

/**
 * Small glass tooltip for utility controls. Portaled; hidden when disabled
 * (e.g. while a menu is open so it never stacks over the popover).
 */
export function GlassTooltip({ label, children, disabled = false, placement = "top" }: Props) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const tipId = useId();

  const updatePosition = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const gap = 8;
    const centerX = rect.left + rect.width / 2;
    if (placement === "bottom") {
      setStyle({
        position: "fixed",
        top: rect.bottom + gap,
        left: centerX,
        transform: "translateX(-50%)",
        zIndex: 11000
      });
    } else {
      setStyle({
        position: "fixed",
        top: rect.top - gap,
        left: centerX,
        transform: "translate(-50%, -100%)",
        zIndex: 11000
      });
    }
  }, [placement]);

  useEffect(() => {
    if (!open || disabled) return;
    updatePosition();
    const onScroll = () => updatePosition();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open, disabled, updatePosition]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  return (
    <span
      ref={wrapRef}
      className="glass-tooltip-wrap"
      onMouseEnter={() => {
        if (!disabled) {
          setOpen(true);
          requestAnimationFrame(updatePosition);
        }
      }}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => {
        if (!disabled) {
          setOpen(true);
          requestAnimationFrame(updatePosition);
        }
      }}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
        }
      }}
    >
      {children}
      {open && !disabled && style ? (
        <OverlayPortal>
          <span id={tipId} role="tooltip" className="glass-tooltip" style={style}>
            {label}
          </span>
        </OverlayPortal>
      ) : null}
    </span>
  );
}
