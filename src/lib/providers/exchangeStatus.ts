import { fetchJson } from "@/lib/http";
import type { DeskSettings, ExchangeOperationalStatus, SourceStatus } from "@/lib/types";

type ExchangeName = ExchangeOperationalStatus["exchangeName"];

const nowIso = () => new Date().toISOString();

function unavailable(exchangeName: ExchangeName, message: string): ExchangeOperationalStatus {
  return {
    exchangeName,
    apiStatus: "unavailable",
    depositStatus: "unknown",
    withdrawalStatus: "unknown",
    maintenance: null,
    lastIncident: null,
    lastUpdated: null,
    impactOnDesk: "روی این منبع احتیاط شود؛ وضعیت عملیاتی دریافت نشد.",
    sourceStatus: "unavailable",
    errorMessage: message
  };
}

function normal(exchangeName: ExchangeName, lastIncident: string | null = null): ExchangeOperationalStatus {
  return {
    exchangeName,
    apiStatus: "available",
    depositStatus: "unknown",
    withdrawalStatus: "unknown",
    maintenance: false,
    lastIncident,
    lastUpdated: nowIso(),
    impactOnDesk: "ریسک عملیاتی خاصی از وضعیت عمومی API دیده نشد.",
    sourceStatus: "available"
  };
}

function degraded(exchangeName: ExchangeName, description: string, sourceStatus: SourceStatus = "degraded") {
  return {
    exchangeName,
    apiStatus: "degraded" as const,
    depositStatus: "unknown" as const,
    withdrawalStatus: "unknown" as const,
    maintenance: true,
    lastIncident: description,
    lastUpdated: nowIso(),
    impactOnDesk: "برای قیمت‌گذاری و انتخاب LP با احتیاط عمل شود.",
    sourceStatus
  };
}

async function binance(): Promise<ExchangeOperationalStatus> {
  try {
    const data = await fetchJson<{ status?: number; msg?: string }>(
      "https://api.binance.com/sapi/v1/system/status",
      8_000
    );
    if (data.status === 0) {
      return normal("Binance", data.msg ?? null);
    }
    return degraded("Binance", data.msg ?? "Maintenance");
  } catch (error) {
    return unavailable("Binance", error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function kraken(): Promise<ExchangeOperationalStatus> {
  try {
    const data = await fetchJson<{ status?: { indicator?: string; description?: string } }>(
      "https://status.kraken.com/api/v2/status.json",
      8_000
    );
    const indicator = data.status?.indicator;
    if (indicator === "none") {
      return normal("Kraken", data.status?.description ?? null);
    }
    return degraded("Kraken", data.status?.description ?? "اختلال یا هشدار عملیاتی");
  } catch (error) {
    return unavailable("Kraken", error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function okx(): Promise<ExchangeOperationalStatus> {
  try {
    const data = await fetchJson<{ code?: string; data?: Array<{ state?: string; title?: string }> }>(
      "https://www.okx.com/api/v5/system/status",
      8_000
    );
    const active = data.data?.find((item) => item.state && item.state !== "completed");
    if (!active) {
      return normal("OKX");
    }
    return degraded("OKX", active.title ?? "Maintenance");
  } catch (error) {
    return unavailable("OKX", error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function bybit(): Promise<ExchangeOperationalStatus> {
  try {
    const data = await fetchJson<{ retCode?: number; result?: { list?: Array<{ title?: string; status?: string }> } }>(
      "https://api.bybit.com/v5/system/status",
      8_000
    );
    if (data.retCode !== 0) {
      return degraded("Bybit", "پاسخ وضعیت Bybit غیرعادی بود");
    }
    const active = data.result?.list?.find((item) => item.status && item.status !== "completed");
    if (!active) {
      return normal("Bybit");
    }
    return degraded("Bybit", active.title ?? "Maintenance");
  } catch (error) {
    return unavailable("Bybit", error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

async function coinbase(): Promise<ExchangeOperationalStatus> {
  try {
    const data = await fetchJson<{ status?: { indicator?: string; description?: string } }>(
      "https://status.coinbase.com/api/v2/status.json",
      8_000
    );
    if (data.status?.indicator === "none") {
      return normal("Coinbase", data.status?.description ?? null);
    }
    return degraded("Coinbase", data.status?.description ?? "اختلال یا هشدار عملیاتی");
  } catch (error) {
    return unavailable("Coinbase", error instanceof Error ? error.message : "منبع در دسترس نیست");
  }
}

const providers: Array<{ id: string; name: ExchangeName; run: () => Promise<ExchangeOperationalStatus> }> = [
  { id: "binance", name: "Binance", run: binance },
  { id: "kraken", name: "Kraken", run: kraken },
  { id: "okx", name: "OKX", run: okx },
  { id: "bybit", name: "Bybit", run: bybit },
  { id: "coinbase", name: "Coinbase", run: coinbase }
];

export async function getGlobalExchangeStatuses(settings: DeskSettings): Promise<ExchangeOperationalStatus[]> {
  return Promise.all(
    providers.map((provider) => {
      if (settings.enabledSources[provider.id] === false) {
        return Promise.resolve(unavailable(provider.name, "این منبع در تنظیمات غیرفعال است"));
      }
      return provider.run();
    })
  );
}
