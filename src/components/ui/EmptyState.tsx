"use client";

import type { LucideIcon } from "lucide-react";
import Link from "next/link";

/**
 * iOS 27 empty state — material card, calm hierarchy.
 * Ported from iran-pay EmptyState (pure CSS class names).
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  actionHref,
  onAction
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  actionHref?: string;
  onAction?: () => void;
}) {
  return (
    <div className="material-card empty-state" role="status">
      <span className="empty-state-icon" aria-hidden>
        <Icon size={28} strokeWidth={1.75} />
      </span>
      <h3 className="text-card-title">{title}</h3>
      {description ? <p className="text-caption empty-state-desc">{description}</p> : null}
      {actionLabel && actionHref ? (
        <Link href={actionHref} className="btn-primary empty-state-action">
          {actionLabel}
        </Link>
      ) : null}
      {actionLabel && onAction && !actionHref ? (
        <button type="button" onClick={onAction} className="btn-primary empty-state-action">
          {actionLabel}
        </button>
      ) : null}
    </div>
  );
}
