"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

const OVERLAY_ROOT_ID = "otc-overlay-root";

function ensureOverlayRoot(): HTMLElement {
  let root = document.getElementById(OVERLAY_ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = OVERLAY_ROOT_ID;
    root.setAttribute("data-overlay-root", "true");
    document.body.appendChild(root);
  }
  return root;
}

/**
 * Renders children into a dedicated body-level overlay root so popovers
 * escape header/panel stacking contexts (backdrop-filter, overflow).
 */
export function OverlayPortal({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    ensureOverlayRoot();
    setMounted(true);
  }, []);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(children, ensureOverlayRoot());
}
