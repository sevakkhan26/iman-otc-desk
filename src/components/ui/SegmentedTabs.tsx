"use client";

export type SegmentedTab<T extends string> = {
  value: T;
  label: string;
};

/**
 * iOS 27 glass segmented control (kit large ~48px segments).
 * Ported from iran-pay SegmentedTabs.
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  fullWidth = false,
  className
}: {
  tabs: SegmentedTab<T>[];
  value: T;
  onChange: (value: T) => void;
  fullWidth?: boolean;
  className?: string;
}) {
  return (
    <div
      className={["segmented-tabs", fullWidth ? "segmented-tabs--full" : "", className ?? ""]
        .filter(Boolean)
        .join(" ")}
      role="tablist"
    >
      {tabs.map((tab) => {
        const active = value === tab.value;
        return (
          <button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.value)}
            className={["segmented-tab", active ? "segmented-tab--active" : "", fullWidth ? "segmented-tab--grow" : ""]
              .filter(Boolean)
              .join(" ")}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
