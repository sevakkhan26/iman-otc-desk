export class ProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

export async function fetchJson<T>(url: string, timeoutMs = 10_000, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      cache: "no-store",
      headers: {
        accept: "application/json, text/plain;q=0.8, */*;q=0.5",
        "user-agent": "dealing-desk-otc-dashboard/0.1",
        ...(init?.headers ?? {})
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new ProviderError("پاسخ خالی بود");
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProviderError("پاسخ JSON معتبر نبود");
    }
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    throw new ProviderError(error instanceof Error ? error.message : "خطای نامشخص منبع");
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchText(url: string, timeoutMs = 10_000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      headers: {
        accept: "application/rss+xml, application/xml, text/xml, text/plain;q=0.8",
        "user-agent": "dealing-desk-otc-dashboard/0.1"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new ProviderError(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new ProviderError("پاسخ خالی بود");
    }

    return text;
  } catch (error) {
    if (error instanceof ProviderError) {
      throw error;
    }
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderError("زمان پاسخ‌دهی منبع تمام شد");
    }
    throw new ProviderError(error instanceof Error ? error.message : "خطای نامشخص منبع");
  } finally {
    clearTimeout(timeout);
  }
}

export function numeric(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.replace(/,/g, "").trim();
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
