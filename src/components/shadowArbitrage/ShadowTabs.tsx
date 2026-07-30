"use client";

import { useEffect, useRef } from "react";
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
    const current = strip.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!current) return;
    if (strip.scrollWidth <= strip.clientWidth + 1) return;
    current.scrollIntoView({ inline: "center", block: "nearest", behavior: "smooth" });
  }, [active]);

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
      <div className="sa-tabs" role="tablist" aria-label="بخش‌های آربیتراژ آزمایشی" onKeyDown={onKeyDown}>
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
              className={`sa-tab${selected ? " is-active" : ""}`}
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
