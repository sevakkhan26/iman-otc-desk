"use client";

import { useEffect, useRef, useState } from "react";
import { SHADOW_TABS, type ShadowTabId } from "@/components/shadowArbitrage/tabs";

type Props = {
  active: ShadowTabId;
  onSelect: (id: ShadowTabId) => void;
  /** Per-tab count/state chip, e.g. blocked gates or open opportunities. */
  badges?: Partial<Record<ShadowTabId, string>>;
};

/**
 * Shadow tab bar.
 *
 * A real tablist: arrow keys move between tabs and the selected one owns the
 * tab stop, so keyboard users are not forced through every tab to reach the
 * panel. On narrow screens the strip scrolls horizontally rather than wrapping
 * or shrinking labels to the point of clipping.
 */
export function ShadowTabs({ active, onSelect, badges }: Props) {
  const stripRef = useRef<HTMLDivElement>(null);

  const [indicatorStyle, setIndicatorStyle] = useState({ width: 0, insetInlineStart: 0, opacity: 0 });

  /**
   * Bring the active tab fully into view when the strip is scrollable.
   *
   * On a narrow screen the selected tab is often the one off-screen — arriving
   * from a URL with `?tab=analytics` would otherwise show a strip that looks
   * like nothing is selected.
   */
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const tablist = strip.querySelector<HTMLElement>('.sa-tabs');
    if (!tablist) return;

    const updateIndicator = () => {
      const current = strip.querySelector<HTMLElement>('[aria-selected="true"]');
      if (!current) return;
      
      const parentRect = tablist.getBoundingClientRect();
      const tabRect = current.getBoundingClientRect();
      
      const dir = window.getComputedStyle(tablist).direction;
      
      // Calculate offset based on logical position inside the positioned tablist
      const insetInlineStart = dir === 'rtl' 
        ? parentRect.right - tabRect.right
        : tabRect.left - parentRect.left;

      // Update indicator
      setIndicatorStyle({
        width: tabRect.width,
        insetInlineStart: insetInlineStart,
        opacity: 1
      });
    };

    updateIndicator();

    const resizeObserver = new ResizeObserver(() => updateIndicator());
    resizeObserver.observe(tablist);
    
    strip.addEventListener("scroll", updateIndicator, { passive: true });

    const current = strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (current && strip.scrollWidth > strip.clientWidth + 1) {
      current.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
    }

    return () => {
      resizeObserver.disconnect();
      strip.removeEventListener("scroll", updateIndicator);
    };
  }, [active, badges]);

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const index = SHADOW_TABS.findIndex((t) => t.id === active);
    // RTL: ArrowLeft advances, ArrowRight goes back.
    const delta = event.key === "ArrowLeft" ? 1 : event.key === "ArrowRight" ? -1 : 0;
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? SHADOW_TABS.length - 1
          : (index + delta + SHADOW_TABS.length) % SHADOW_TABS.length;
    onSelect(SHADOW_TABS[next].id);
  };

  return (
    <div className="sa-tabs-wrap" ref={stripRef}>
      {/* .glass-tabbar is the shared tab-container material. */}
      <div className="sa-tabs glass-tabbar sa-pill-tabs" role="tablist" aria-label="بخش‌های آربیتراژ آزمایشی" onKeyDown={onKeyDown}>
        <div 
          className="sa-pill-indicator"
          style={{ 
            width: indicatorStyle.width,
            insetInlineStart: indicatorStyle.insetInlineStart,
            opacity: indicatorStyle.opacity 
          }}
          aria-hidden="true"
        />
        {SHADOW_TABS.map((tab) => {
          const selected = tab.id === active;
          const badge = badges?.[tab.id];
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`sa-tab-${tab.id}`}
              aria-selected={selected}
              aria-controls={`sa-panel-${tab.id}`}
              tabIndex={selected ? 0 : -1}
              title={tab.hintFa}
              /* The selected tab wears the shared .glass-control material. */
              className={`sa-tab${selected ? " is-active glass-control" : ""}`}
              onClick={() => onSelect(tab.id)}
            >
              <span className="sa-tab-label">{tab.labelFa}</span>
              {badge ? <span className="sa-tab-badge">{badge}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
