"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import { OverlayPortal } from "@/components/ui/OverlayPortal";

type Props = {
  open: boolean;
  onClose: () => void;
  /** Anchor element (trigger) for positioning */
  anchorRef: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  /** Preferred alignment in RTL: end = near trailing edge of trigger (inline-end) */
  align?: "start" | "end" | "center";
  className?: string;
  role?: string;
  id?: string;
  "aria-label"?: string;
};

const VIEWPORT_PAD = 10;
const GAP = 8;
const Z = 12000;

/**
 * Body-portaled frosted popover positioned to an anchor.
 * Escapes header/backdrop-filter stacking and overflow clipping.
 */
export function GlassPopover({
  open,
  onClose,
  anchorRef,
  children,
  align = "end",
  className,
  role = "menu",
  id,
  "aria-label": ariaLabel
}: Props) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: "fixed",
    top: -9999,
    left: -9999,
    zIndex: Z,
    visibility: "hidden"
  });

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;

    const a = anchor.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Prefer below; flip above if not enough room
    let top = a.bottom + GAP;
    if (top + p.height + VIEWPORT_PAD > vh && a.top - GAP - p.height >= VIEWPORT_PAD) {
      top = a.top - GAP - p.height;
    }
    top = Math.max(VIEWPORT_PAD, Math.min(top, vh - p.height - VIEWPORT_PAD));

    // RTL: "end" aligns panel's inline-end with trigger's inline-end (right edge in LTR coords = right)
    let left: number;
    if (align === "center") {
      left = a.left + a.width / 2 - p.width / 2;
    } else if (align === "start") {
      // inline-start in RTL = right side of screen; use left edge of trigger in physical coords
      left = a.left;
    } else {
      // end: align right edges
      left = a.right - p.width;
    }
    left = Math.max(VIEWPORT_PAD, Math.min(left, vw - p.width - VIEWPORT_PAD));

    setStyle({
      position: "fixed",
      top,
      left,
      zIndex: Z,
      visibility: "visible",
      maxWidth: `min(18rem, calc(100vw - ${VIEWPORT_PAD * 2}px))`,
      maxHeight: `calc(100vh - ${VIEWPORT_PAD * 2}px)`,
      overflowY: "auto"
    });
  }, [anchorRef, align]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // second frame after paint for accurate size
    const id = requestAnimationFrame(() => place());
    return () => cancelAnimationFrame(id);
  }, [open, place, children]);

  useEffect(() => {
    if (!open) return;
    const onScroll = () => place();
    window.addEventListener("resize", onScroll);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent | TouchEvent) => {
      const t = event.target as Node | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        anchorRef.current?.focus();
      }
    };
    // Capture phase so we close even if stopPropagation on page
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("touchstart", onPointer, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("touchstart", onPointer, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose, anchorRef]);

  // Keyboard roving for menuitems
  useEffect(() => {
    if (!open || !panelRef.current) return;
    const root = panelRef.current;
    const items = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled]), [role="menuitem"]:not([aria-disabled="true"])')
      ).filter((el) => !el.hasAttribute("disabled") && el.getAttribute("aria-disabled") !== "true");

    const onKeyDown = (event: KeyboardEvent) => {
      const list = items();
      if (!list.length) return;
      const current = document.activeElement as HTMLElement | null;
      const idx = list.indexOf(current as HTMLElement);
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const next = list[(idx + 1 + list.length) % list.length]!;
        next.focus();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        const next = list[(idx - 1 + list.length) % list.length]!;
        next.focus();
      } else if (event.key === "Home") {
        event.preventDefault();
        list[0]!.focus();
      } else if (event.key === "End") {
        event.preventDefault();
        list[list.length - 1]!.focus();
      }
    };
    root.addEventListener("keydown", onKeyDown);
    // Focus first item
    requestAnimationFrame(() => items()[0]?.focus());
    return () => root.removeEventListener("keydown", onKeyDown);
  }, [open]);

  if (!open) return null;

  return (
    <OverlayPortal>
      <div
        ref={panelRef}
        id={id}
        role={role}
        aria-label={ariaLabel}
        className={["glass-popover", "material-popover", className].filter(Boolean).join(" ")}
        style={style}
      >
        {children}
      </div>
    </OverlayPortal>
  );
}
