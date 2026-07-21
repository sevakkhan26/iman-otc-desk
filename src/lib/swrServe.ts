/**
 * Process-local stale-while-revalidate for expensive desk APIs.
 * Menu navigation must return in milliseconds when a prior payload exists.
 */

type Entry<T> = {
  value: T;
  at: number;
  inflight: Promise<T> | null;
};

const store = new Map<string, Entry<unknown>>();

function entryOf<T>(key: string): Entry<T> {
  let e = store.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { value: null as unknown as T, at: 0, inflight: null };
    store.set(key, e as Entry<unknown>);
  }
  return e;
}

/**
 * @param ttlMs Fresh window — return cached without revalidate kick.
 * @param maxStaleMs After ttl, still return cached immediately and refresh in background.
 * @param fetcher Builds a new payload (may hit LPs / DB).
 */
export async function serveSwr<T>(
  key: string,
  ttlMs: number,
  maxStaleMs: number,
  fetcher: () => Promise<T>
): Promise<T> {
  const e = entryOf<T>(key);
  const now = Date.now();
  const age = e.at ? now - e.at : Number.POSITIVE_INFINITY;
  const hasValue = e.at > 0;

  if (hasValue && age < ttlMs) {
    return e.value;
  }

  if (hasValue && age < maxStaleMs) {
    if (!e.inflight) {
      e.inflight = fetcher()
        .then((value) => {
          e.value = value;
          e.at = Date.now();
          return value;
        })
        .catch((err) => {
          console.warn(`[swr] background refresh failed (${key}):`, err instanceof Error ? err.message : err);
          return e.value;
        })
        .finally(() => {
          e.inflight = null;
        });
    }
    return e.value;
  }

  // Cold or too stale: wait (but dedupe concurrent)
  if (e.inflight) return e.inflight;

  e.inflight = fetcher()
    .then((value) => {
      e.value = value;
      e.at = Date.now();
      return value;
    })
    .finally(() => {
      e.inflight = null;
    });

  try {
    return await e.inflight;
  } catch (err) {
    if (hasValue) {
      console.warn(`[swr] serve stale after error (${key}):`, err instanceof Error ? err.message : err);
      return e.value;
    }
    throw err;
  }
}

/** Optional hard deadline so cold paths never hang the browser for minutes. */
export async function withDeadline<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} deadline ${ms}ms`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
