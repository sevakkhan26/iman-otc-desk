"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { serverTimeToEpochMs } from "@/hooks/useServerClock";

/** In-flight dedupe only (same URL). Not a durable multi-user cache. */
const inflightClient = new Map<string, Promise<unknown>>();

/**
 * Tab-lifetime last-good payloads so menu switches paint instantly
 * (dashboard ↔ tether ↔ gold) without re-waiting for the network.
 * Memory-only is safe after mount; never seed useState from sessionStorage
 * (that caused React #418 hydration text mismatches).
 */
const clientLastGood = new Map<string, { data: unknown; at: number }>();

const CLIENT_FETCH_TIMEOUT_MS = 15_000;

function readSessionCache<T>(url: string): T | null {
  if (typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(`otc:api:${url}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { data: T; at: number };
    // Keep for the whole browser tab session (max 48h — matches offline gold/FX/bubble window)
    if (Date.now() - parsed.at > 48 * 60 * 60_000) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

function writeSessionCache(url: string, data: unknown): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(`otc:api:${url}`, JSON.stringify({ data, at: Date.now() }));
  } catch {
    /* quota / private mode */
  }
}

function seedFromCaches<T>(url: string): T | null {
  const mem = clientLastGood.get(url);
  if (mem) return mem.data as T;
  return readSessionCache<T>(url);
}

function applySeedTimes(
  seeded: unknown,
  setServerNow: (v: string | null) => void,
  setLastUpdated: (v: number | null) => void
) {
  const times = extractServerTimes(seeded);
  setServerNow(times.serverNowIso);
  setLastUpdated(times.lastUpdatedMs);
}

function clientFetchJson<T>(url: string): Promise<T> {
  const existing = inflightClient.get(url);
  if (existing) {
    return existing as Promise<T>;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_FETCH_TIMEOUT_MS);

  const promise = fetch(url, {
    cache: "no-store",
    signal: controller.signal,
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
      clearTimeout(timer);
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
  /**
   * Always start empty on both server and client first paint.
   * Seeding from sessionStorage in useState() made SSR HTML (skeleton) diverge
   * from client HTML (cached prices) → React minified error #418.
   */
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [serverNow, setServerNow] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const hasDataRef = useRef(false);
  const mountedRef = useRef(true);
  const urlRef = useRef(url);
  const hydratedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // After mount: restore tab/session cache, then fetch (SWR style).
  useEffect(() => {
    let cancelled = false;
    setError(null);

    // Client-only seed (safe post-hydration)
    if (!hydratedRef.current || urlRef.current !== url) {
      hydratedRef.current = true;
      urlRef.current = url;
      const seeded = seedFromCaches<T>(url);
      if (seeded) {
        setData(seeded);
        hasDataRef.current = true;
        applySeedTimes(seeded, setServerNow, setLastUpdated);
        setLoading(false);
        setRefreshing(true);
      } else {
        hasDataRef.current = false;
        setLoading(true);
        setRefreshing(false);
      }
    } else if (hasDataRef.current) {
      setRefreshing(true);
      setLoading(false);
    } else {
      setLoading(true);
    }

    clientFetchJson<T>(url)
      .then((value) => {
        if (cancelled || !mountedRef.current) return;
        setData(value);
        hasDataRef.current = true;
        clientLastGood.set(url, { data: value, at: Date.now() });
        writeSessionCache(url, value);
        const times = extractServerTimes(value);
        setServerNow(times.serverNowIso);
        setLastUpdated(times.lastUpdatedMs);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled || !mountedRef.current) return;
        if (err instanceof Error && err.name === "AbortError") {
          if (!hasDataRef.current) {
            setError("پاسخ سرور طول کشید — دوباره تلاش کنید");
          }
          return;
        }
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
