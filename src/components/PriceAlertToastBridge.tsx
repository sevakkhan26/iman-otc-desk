"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { instrumentMeta, priceTypeLabel } from "@/lib/priceAlerts/instruments";
import type { PriceAlertNotification } from "@/lib/types";
import { formatNumber } from "@/components/format";

type Toast = { id: string; title: string; detail: string };

const SEEN_KEY = "otc-price-alert-seen";

function loadSeen(): Set<string> {
  try {
    const raw = window.sessionStorage.getItem(SEEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw) as string[];
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

function saveSeen(seen: Set<string>) {
  try {
    window.sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-100)));
  } catch {
    /* ignore */
  }
}

export function PriceAlertToastBridge() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seenRef = useRef<Set<string> | null>(null);

  useEffect(() => {
    seenRef.current = loadSeen();
    let cancelled = false;

    const pull = async () => {
      try {
        const res = await fetch("/api/alerts/notifications?evaluate=1", {
          cache: "no-store",
          credentials: "same-origin"
        });
        if (!res.ok) return;
        const data = (await res.json()) as { items?: PriceAlertNotification[] };
        const items = data.items ?? [];
        const seen = seenRef.current ?? new Set<string>();
        const fresh = items.filter((n) => !n.readAt && !seen.has(n.id)).slice(0, 5);
        if (!fresh.length || cancelled) return;
        for (const n of fresh) seen.add(n.id);
        seenRef.current = seen;
        saveSeen(seen);
        const next: Toast[] = fresh.map((n) => {
          const meta = instrumentMeta(n.instrument);
          return {
            id: n.id,
            title: `${meta.label} به قیمت هدف رسید`,
            detail: `${priceTypeLabel(n.priceType)} در ${n.providerName}: ${formatNumber(n.actualPrice, 2)} (هدف ${formatNumber(n.targetPrice, 2)})`
          };
        });
        setToasts((cur) => [...next, ...cur].slice(0, 5));
      } catch {
        /* ignore */
      }
    };

    void pull();
    const id = window.setInterval(() => void pull(), 45_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!toasts.length) return null;

  return (
    <div className="toast-stack" aria-live="assertive">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast warn" role="alert">
          <div className="toast-body">
            <div className="toast-title">{toast.title}</div>
            <div className="toast-detail">{toast.detail}</div>
          </div>
          <button
            type="button"
            className="toast-close"
            aria-label="بستن"
            onClick={() => setToasts((cur) => cur.filter((t) => t.id !== toast.id))}
          >
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
