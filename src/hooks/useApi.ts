"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { serverTimeToEpochMs } from "@/hooks/useServerClock";

/** In-flight dedupe only (same URL). Not a durable multi-user cache. */
const inflightClient = new Map<string, Promise<unknown>>();

function clientFetchJson<T>(url: string): Promise<T> {
  const existing = inflightClient.get(url);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fetch(url, {
    cache: "no-store",
    headers: {
      accept: "application/json",
      "cache-control": "no-store"
    }
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    })
    .finally(() => {
      inflightClient.delete(url);
    });

  inflightClient.set(url, promise);
  return promise;
}

/**
 * Pull authoritative server timestamps from known API shapes.
 * Never falls back to browser wall-clock for "last update".
 */
export function extractServerTimes(data: unknown): {
  serverNowIso: string | null;
  lastUpdatedMs: number | null;
} {
  if (!data || typeof data !== "object") {
    return { serverNowIso: null, lastUpdatedMs: null };
  }
  const d = data as Record<string, unknown>;
  const serverNowIso =
    typeof d.serverNow === "string"
      ? d.serverNow
      : typeof d.generatedAt === "string"
        ? d.generatedAt
        : null;

  const summary =
    d.summary && typeof d.summary === "object"
      ? (d.summary as Record<string, unknown>)
      : null;
  const tether =
    d.tetherMarket && typeof d.tetherMarket === "object"
      ? (d.tetherMarket as Record<string, unknown>)
      : null;
  const tetherSummary =
    tether?.summary && typeof tether.summary === "object"
      ? (tether.summary as Record<string, unknown>)
      : null;

  const lastUpdatedIso =
    (typeof d.lastUpdated === "string" ? d.lastUpdated : null) ||
    (summary && typeof summary.lastUpdated === "string" ? summary.lastUpdated : null) ||
    (tetherSummary && typeof tetherSummary.lastUpdated === "string"
      ? tetherSummary.lastUpdated
      : null) ||
    (typeof d.generatedAt === "string" ? d.generatedAt : null) ||
    serverNowIso;

  return {
    serverNowIso,
    lastUpdatedMs: serverTimeToEpochMs(lastUpdatedIso)
  };
}

export function useApi<T>(url: string, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Epoch ms from server snapshot (not browser receive time). */
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  /** Latest serverNow ISO from payload — drives shared header clock. */
  const [serverNow, setServerNow] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const hasDataRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setError(null);

    if (hasDataRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    clientFetchJson<T>(url)
      .then((value) => {
        if (cancelled || !mountedRef.current) return;
        setData(value);
        hasDataRef.current = true;
        const times = extractServerTimes(value);
        setServerNow(times.serverNowIso);
        setLastUpdated(times.lastUpdatedMs);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return;
        if (err instanceof Error && err.name === "AbortError") return;
        if (!hasDataRef.current) {
          setError(err instanceof Error ? err.message : "داده‌ای دریافت نشد");
        }
      })
      .finally(() => {
        if (cancelled || !mountedRef.current) return;
        setLoading(false);
        setRefreshing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [url, revision]);

  useEffect(() => {
    if (!refreshMs) return;
    const id = setInterval(() => {
      if (typeof document !== "undefined" && document.hidden) return;
      setRevision((value) => value + 1);
    }, refreshMs);
    return () => clearInterval(id);
  }, [refreshMs]);

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  return { data, loading, refreshing, error, reload, lastUpdated, serverNow };
}
