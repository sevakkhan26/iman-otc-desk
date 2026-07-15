type CacheEntry<T> = {
  value: T;
  at: number;
  key: string;
};

/** In-memory TTL cache with min-gap throttling and in-flight deduplication (keyed). */
export function createProviderCache<T>(options?: { minGapMs?: number }) {
  const minGapMs = options?.minGapMs ?? 15_000;
  let entry: CacheEntry<T> | null = null;
  let inflightKey: string | null = null;
  let inflight: Promise<T> | null = null;

  return {
    async get(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
      const now = Date.now();
      if (entry && entry.key === key && now - entry.at < ttlMs) {
        return entry.value;
      }
      // Serve last value during min-gap (stale-while-revalidate for rapid polls)
      if (entry && entry.key === key && now - entry.at < minGapMs) {
        return entry.value;
      }

      // Deduplicate concurrent requests for the same key only
      if (inflight && inflightKey === key) {
        return inflight;
      }

      inflightKey = key;
      inflight = fetcher()
        .then((value) => {
          entry = { value, at: Date.now(), key };
          return value;
        })
        .finally(() => {
          if (inflightKey === key) {
            inflight = null;
            inflightKey = null;
          }
        });

      return inflight;
    },
    /** Peek last cached value without fetching (for instant shell). */
    peek(key: string): T | null {
      if (entry && entry.key === key) return entry.value;
      return null;
    },
    clear() {
      entry = null;
      inflight = null;
      inflightKey = null;
    }
  };
}

export function ttlFromMinutes(minutes: number, floorMs = 60_000): number {
  return Math.max(floorMs, minutes * 60_000);
}