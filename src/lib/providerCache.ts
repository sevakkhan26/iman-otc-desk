type CacheEntry<T> = {
  value: T;
  at: number;
  key: string;
};

/** In-memory TTL cache with min-gap throttling and in-flight deduplication. */
export function createProviderCache<T>(options?: { minGapMs?: number }) {
  const minGapMs = options?.minGapMs ?? 15_000;
  let entry: CacheEntry<T> | null = null;
  let inflight: Promise<T> | null = null;

  return {
    async get(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
      const now = Date.now();
      if (entry && entry.key === key && now - entry.at < ttlMs) {
        return entry.value;
      }
      if (entry && entry.key === key && now - entry.at < minGapMs) {
        return entry.value;
      }

      if (!inflight) {
        inflight = fetcher()
          .then((value) => {
            entry = { value, at: Date.now(), key };
            return value;
          })
          .finally(() => {
            inflight = null;
          });
      }

      return inflight;
    },
    clear() {
      entry = null;
      inflight = null;
    }
  };
}

export function ttlFromMinutes(minutes: number, floorMs = 60_000): number {
  return Math.max(floorMs, minutes * 60_000);
}