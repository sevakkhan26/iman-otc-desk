"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** In-flight + short soft cache to dedupe concurrent client fetches (same URL). */
const inflightClient = new Map<string, Promise<unknown>>();
const softClientCache = new Map<string, { at: number; data: unknown }>();
const SOFT_CACHE_MS = 2_500;

function clientFetchJson<T>(url: string): Promise<T> {
  const now = Date.now();
  const soft = softClientCache.get(url);
  if (soft && now - soft.at < SOFT_CACHE_MS) {
    return Promise.resolve(soft.data as T);
  }

  const existing = inflightClient.get(url);
  if (existing) {
    return existing as Promise<T>;
  }

  const promise = fetch(url, { cache: "no-store" })
    .then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    })
    .then((data) => {
      softClientCache.set(url, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflightClient.delete(url);
    });

  inflightClient.set(url, promise);
  return promise;
}

function readSoftCache<T>(url: string): T | null {
  const soft = softClientCache.get(url);
  if (!soft) return null;
  if (Date.now() - soft.at >= SOFT_CACHE_MS) return null;
  return soft.data as T;
}

export function useApi<T>(url: string, refreshMs?: number) {
  // Instant paint when the same URL was fetched very recently (nav back / remount)
  const seed = readSoftCache<T>(url);
  const [data, setData] = useState<T | null>(seed);
  const [loading, setLoading] = useState(!seed);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(seed ? Date.now() : null);
  const [revision, setRevision] = useState(0);
  const hasDataRef = useRef(Boolean(seed));
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

    // Stale-while-revalidate: only block UI on first load
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
        setLastUpdated(Date.now());
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return;
        if (err instanceof Error && err.name === "AbortError") return;
        // Keep previous data on refresh failure
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
  return { data, loading, refreshing, error, reload, lastUpdated };
}
