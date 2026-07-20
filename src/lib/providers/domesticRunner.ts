import type { DomesticProviderHealth, DomesticQuote, SourceStatus } from "@/lib/types";

export type { DomesticProviderHealth };

export type IsolatedProviderDef = {
  id: string;
  name: string;
  /** Primary official endpoint (for diagnostics). */
  endpoint: string;
  /** Hard timeout per attempt (ms). */
  timeoutMs: number;
  /** Min gap between live fetches (ms) — serves last good to avoid 429. */
  minFetchMs: number;
  /** How long last-good may be served as degraded (ms). */
  staleTtlMs: number;
  /** Extra retries after first failure (0 = single attempt). */
  maxRetries: number;
  /** Backoff after HTTP 429 (ms). */
  rateLimitBackoffMs: number;
  /** Live fetch only — no shared cache; throw or return valid quote. */
  live: () => Promise<DomesticQuote>;
};

type Slot = {
  lastGood: DomesticQuote | null;
  lastSuccessAt: number | null;
  lastAttemptAt: number | null;
  lastError: string | null;
  lastEndpoint: string;
  rateLimitedUntil: number;
  lastLiveFetchAt: number;
  inflight: Promise<DomesticQuote> | null;
};

const slots = new Map<string, Slot>();

function slotFor(def: IsolatedProviderDef): Slot {
  let s = slots.get(def.id);
  if (!s) {
    s = {
      lastGood: null,
      lastSuccessAt: null,
      lastAttemptAt: null,
      lastError: null,
      lastEndpoint: def.endpoint,
      rateLimitedUntil: 0,
      lastLiveFetchAt: 0,
      inflight: null
    };
    slots.set(def.id, s);
  }
  return s;
}

function unavailable(id: string, name: string, message: string): DomesticQuote {
  return {
    exchangeId: id,
    exchangeName: name,
    buyPrice: null,
    sellPrice: null,
    midPrice: null,
    volume: null,
    spread: null,
    spreadPercent: null,
    deviationFromMedianPercent: null,
    sourceStatus: "unavailable",
    lastUpdated: null,
    errorMessage: message,
    isOutlier: false,
    excludedFromMedian: false
  };
}

function isRateLimitError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /429|rate.?limit|too many requests|مکرر|Retry-After/i.test(msg);
}

/** 4xx client errors (except 408/429) — do not retry; thrashing WAFs (e.g. Exir CloudFront 403). */
function isNonRetryableProviderError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  if (isRateLimitError(error)) return false;
  if (/\bHTTP 408\b/.test(msg)) return false;
  return /\bHTTP (400|401|403|404|405|410|422)\b/.test(msg);
}

function parseRetryAfterMs(error: unknown): number | null {
  const msg = error instanceof Error ? error.message : String(error);
  const m = msg.match(/retry-after[=:\s]+(\d+)/i);
  if (!m) return null;
  const sec = Number(m[1]);
  return Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, 15 * 60_000) : null;
}

function hasUsablePrices(q: DomesticQuote | null): boolean {
  if (!q) return false;
  return q.buyPrice !== null || q.sellPrice !== null || q.midPrice !== null;
}

/**
 * Per-call hard timeout. Timer is always cleared.
 * Does not share AbortControllers across providers — each live() owns its own fetch signal.
 * Note: this does not cancel the underlying I/O; live() timeouts still apply independently.
 */
function withHardTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`زمان پاسخ‌دهی ${label} تمام شد (${timeoutMs}ms)`));
    }, timeoutMs);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/**
 * Run one provider with isolated timeout, min-gap cache, stale fallback, retry/backoff.
 * Never mutates another provider's slot.
 */
export async function runIsolatedProvider(def: IsolatedProviderDef): Promise<DomesticQuote> {
  const slot = slotFor(def);
  const now = Date.now();
  slot.lastAttemptAt = now;
  slot.lastEndpoint = def.endpoint;

  // Rate-limit cooldown: serve stale if possible
  if (slot.rateLimitedUntil > now) {
    if (hasUsablePrices(slot.lastGood) && slot.lastSuccessAt && now - slot.lastSuccessAt < def.staleTtlMs) {
      slot.lastError = "rate-limited cooldown";
      return {
        ...slot.lastGood!,
        sourceStatus: "degraded",
        errorMessage: `محدودیت نرخ ${def.name}؛ آخرین قیمت معتبر نمایش داده می‌شود`
      };
    }
    slot.lastError = "rate-limited";
    return unavailable(def.id, def.name, `محدودیت نرخ ${def.name}؛ بعداً دوباره تلاش کنید`);
  }

  // Min-gap: return last good without hitting network
  if (
    hasUsablePrices(slot.lastGood) &&
    slot.lastLiveFetchAt > 0 &&
    now - slot.lastLiveFetchAt < def.minFetchMs
  ) {
    return slot.lastGood!;
  }

  // Deduplicate concurrent fetches for the same provider only
  if (slot.inflight) {
    return slot.inflight;
  }

  const run = async (): Promise<DomesticQuote> => {
    let lastError: unknown = null;
    const attempts = 1 + Math.max(0, def.maxRetries);

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) {
        // Short jittered backoff — only reached for transient failures
        const jitter = Math.floor(Math.random() * 150);
        await new Promise((r) => setTimeout(r, 200 * attempt + jitter));
      }
      try {
        // Each attempt starts a fresh live() → fresh AbortController inside fetchJson
        const quote = await withHardTimeout(def.live(), def.timeoutMs, def.name);
        if (!hasUsablePrices(quote)) {
          throw new Error("قیمت عددی معتبر برنگشت");
        }
        // Success — isolate write to this slot only
        const successAt = Date.now();
        slot.lastGood = { ...quote, exchangeId: def.id, exchangeName: def.name };
        slot.lastSuccessAt = successAt;
        slot.lastLiveFetchAt = successAt;
        slot.lastError = null;
        slot.rateLimitedUntil = 0;
        return slot.lastGood;
      } catch (error) {
        lastError = error;
        if (isRateLimitError(error)) {
          const retryAfter = parseRetryAfterMs(error);
          slot.rateLimitedUntil = Date.now() + (retryAfter ?? def.rateLimitBackoffMs);
          slot.lastError = "HTTP 429 / rate limit";
          break;
        }
        if (isNonRetryableProviderError(error)) {
          // e.g. Exir CloudFront 403 — do not thrash; short cooldown
          slot.rateLimitedUntil = Date.now() + Math.min(def.rateLimitBackoffMs, 120_000);
          slot.lastError = error instanceof Error ? error.message : "HTTP client error";
          break;
        }
        slot.lastError = error instanceof Error ? error.message : "خطای منبع";
      }
    }

    const failNow = Date.now();
    // Stale last-good
    if (
      hasUsablePrices(slot.lastGood) &&
      slot.lastSuccessAt &&
      failNow - slot.lastSuccessAt < def.staleTtlMs
    ) {
      return {
        ...slot.lastGood!,
        sourceStatus: "degraded",
        errorMessage: `آخرین قیمت معتبر ${def.name} نمایش داده می‌شود${
          slot.lastError ? ` (${slot.lastError})` : ""
        }`
      };
    }

    return unavailable(
      def.id,
      def.name,
      lastError instanceof Error ? lastError.message : "منبع در دسترس نیست"
    );
  };

  slot.inflight = run().finally(() => {
    const s = slots.get(def.id);
    if (s) s.inflight = null;
  });

  return slot.inflight;
}

export function snapshotProviderHealth(defs: IsolatedProviderDef[]): DomesticProviderHealth[] {
  const now = Date.now();
  return defs.map((def) => {
    const slot = slots.get(def.id);
    const q = slot?.lastGood ?? null;
    const lastSuccessAt = slot?.lastSuccessAt ?? null;
    const staleAgeMs =
      lastSuccessAt !== null && hasUsablePrices(q) ? Math.max(0, now - lastSuccessAt) : null;
    let status: SourceStatus = "unavailable";
    if (q && hasUsablePrices(q)) {
      status = q.sourceStatus === "degraded" || (staleAgeMs !== null && staleAgeMs > def.minFetchMs * 2)
        ? q.sourceStatus === "available" && staleAgeMs !== null && staleAgeMs > def.minFetchMs
          ? "degraded"
          : q.sourceStatus
        : q.sourceStatus;
      // If last error exists and we are serving cache past min gap conceptually degraded
      if (slot?.lastError && lastSuccessAt && now - lastSuccessAt > def.minFetchMs) {
        status = "degraded";
      }
    }
    return {
      id: def.id,
      name: def.name,
      status: q?.sourceStatus ?? status,
      endpoint: slot?.lastEndpoint ?? def.endpoint,
      buyPrice: q?.buyPrice ?? null,
      sellPrice: q?.sellPrice ?? null,
      midPrice: q?.midPrice ?? null,
      lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
      lastAttemptAt: slot?.lastAttemptAt ? new Date(slot.lastAttemptAt).toISOString() : null,
      staleAgeMs,
      error: slot?.lastError ?? q?.errorMessage ?? null,
      rateLimitedUntil:
        slot && slot.rateLimitedUntil > now ? new Date(slot.rateLimitedUntil).toISOString() : null
    };
  });
}

/** Clear one provider's slot (e.g. force probe). Does not touch other slots. */
export function clearProviderSlot(id: string): void {
  slots.delete(id);
}

/**
 * Run all providers with Promise.allSettled isolation.
 * One rejection/timeout cannot overwrite another provider's result.
 */
export async function runAllIsolatedProviders(
  defs: IsolatedProviderDef[],
  enabled: Record<string, boolean | undefined>
): Promise<DomesticQuote[]> {
  const tasks = defs.map(async (def) => {
    if (enabled[def.id] === false) {
      return unavailable(def.id, def.name, "این منبع در تنظیمات غیرفعال است");
    }
    try {
      return await runIsolatedProvider(def);
    } catch (error) {
      // Absolute last resort — should not happen (runner swallows)
      const slot = slots.get(def.id);
      if (hasUsablePrices(slot?.lastGood ?? null)) {
        return {
          ...slot!.lastGood!,
          sourceStatus: "degraded" as const,
          errorMessage: "خطای غیرمنتظره؛ آخرین قیمت معتبر"
        };
      }
      return unavailable(def.id, def.name, error instanceof Error ? error.message : "منبع در دسترس نیست");
    }
  });

  const settled = await Promise.allSettled(tasks);
  return settled.map((result, index) => {
    const def = defs[index];
    if (result.status === "fulfilled") {
      return result.value;
    }
    const slot = slots.get(def.id);
    if (hasUsablePrices(slot?.lastGood ?? null)) {
      return {
        ...slot!.lastGood!,
        sourceStatus: "degraded" as const,
        errorMessage: "خطای ایزوله؛ آخرین قیمت معتبر"
      };
    }
    return unavailable(def.id, def.name, result.reason instanceof Error ? result.reason.message : "منبع در دسترس نیست");
  });
}
