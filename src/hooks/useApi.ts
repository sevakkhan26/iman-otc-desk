"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export function useApi<T>(url: string, refreshMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [revision, setRevision] = useState(0);
  const hasDataRef = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return (await response.json()) as T;
      })
      .then((value) => {
        setData(value);
        hasDataRef.current = true;
        setLastUpdated(Date.now());
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        if (!hasDataRef.current) {
          setError(err instanceof Error ? err.message : "داده‌ای دریافت نشد");
        }
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
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
  return { data, loading, error, reload, lastUpdated };
}