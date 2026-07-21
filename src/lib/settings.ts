/**
 * Desk settings — PostgreSQL app_settings (single source of truth).
 * Fail closed when DATABASE_URL is unavailable.
 */
import {
  DatabaseUnavailableError,
  getDatabaseUrl,
  isTransientDbError,
  withDbRetry
} from "@/db/client";
import { pgGetSettingsJson, pgSaveSettingsJson } from "@/db/repositories/settings";
import type { DeskSettings, PublicSettings, SettingsPatch } from "@/lib/types";

const allSources = [
  "nobitex",
  "wallex",
  "bitpin",
  "tabdeal",
  "ramzinex",
  "abantether",
  "ompfinex",
  "exir",
  "tetherland",
  "bit24",
  "okex_ir",
  "arzinja",
  "navasan",
  "bonbast",
  "talavest",
  "binance",
  "kraken",
  "okx",
  "bybit",
  "coinbase",
  "news",
  "forex"
] as const;

export const defaultSettings: DeskSettings = {
  providerApiKeys: {},
  openAiApiKey: "",
  priceRefreshMinutes: 3,
  globalMarketRefreshMinutes: 1,
  globalExchangeRefreshMinutes: 5,
  newsRefreshMinutes: 15,
  intelligenceRefreshMinutes: 60,
  outlierThresholdPercent: 1.5,
  marketSpreadAlertThresholdPercent: 1,
  depegAlertThresholdPercent: 0.5,
  enabledSources: Object.fromEntries(allSources.map((source) => [source, true]))
};

function mergeSettings(value: Partial<DeskSettings>): DeskSettings {
  return {
    ...defaultSettings,
    ...value,
    providerApiKeys: {
      ...defaultSettings.providerApiKeys,
      ...(value.providerApiKeys ?? {})
    },
    enabledSources: {
      ...defaultSettings.enabledSources,
      ...(value.enabledSources ?? {})
    },
    openAiApiKey: process.env.OPENAI_API_KEY || value.openAiApiKey || ""
  };
}

let settingsMemCache: { value: DeskSettings; at: number } | null = null;
/** Fresh TTL — dashboard hits settings on almost every API; avoid hammering Postgres. */
const SETTINGS_MEM_TTL_MS = 30_000;
/** After a transient CONNECT_TIMEOUT, keep serving last good settings instead of HTTP 503. */
const SETTINGS_STALE_MAX_MS = 15 * 60_000;

/**
 * Read desk settings.
 * Resilience (v3.4+): never take down market pages on a blip —
 *   1) fresh mem cache
 *   2) live Postgres (with connect retry)
 *   3) stale mem cache (up to SETTINGS_STALE_MAX_MS)
 *   4) process defaults (soft) when OTC_SETTINGS_SOFT_FAIL is not "0"
 */
export async function getSettings(): Promise<DeskSettings> {
  if (settingsMemCache && Date.now() - settingsMemCache.at < SETTINGS_MEM_TTL_MS) {
    return settingsMemCache.value;
  }
  try {
    getDatabaseUrl();
    const stored = await withDbRetry(() => pgGetSettingsJson(), "settings-read");
    const value = mergeSettings(stored ?? {});
    settingsMemCache = { value, at: Date.now() };
    return value;
  } catch (error) {
    if (
      settingsMemCache &&
      Date.now() - settingsMemCache.at < SETTINGS_STALE_MAX_MS
    ) {
      console.warn(
        "[settings] DB read failed — serving stale cache",
        error instanceof Error ? error.message : error
      );
      return settingsMemCache.value;
    }
    const soft = (process.env.OTC_SETTINGS_SOFT_FAIL ?? "1") !== "0";
    if (soft && (isTransientDbError(error) || error instanceof DatabaseUnavailableError)) {
      console.warn(
        "[settings] DB unavailable — serving process defaults (soft fail)",
        error instanceof Error ? error.message : error
      );
      const value = mergeSettings({});
      // short cache so we retry DB soon without hammering every request
      settingsMemCache = { value, at: Date.now() - SETTINGS_MEM_TTL_MS + 3_000 };
      return value;
    }
    if (error instanceof DatabaseUnavailableError) throw error;
    const msg = error instanceof Error ? error.message : "PostgreSQL settings read failed";
    const cause =
      error && typeof error === "object" && "cause" in error
        ? (error as { cause?: unknown }).cause
        : undefined;
    const causeMsg = cause instanceof Error ? ` (${cause.message})` : "";
    throw new DatabaseUnavailableError(`${msg}${causeMsg}`, error);
  }
}

export async function patchSettings(patch: SettingsPatch): Promise<PublicSettings> {
  const current = await getSettings();
  const next: DeskSettings = {
    ...current,
    ...sanitizePatch(patch),
    providerApiKeys: {
      ...current.providerApiKeys,
      ...(patch.providerApiKeys ?? {})
    },
    enabledSources: {
      ...current.enabledSources,
      ...(patch.enabledSources ?? {})
    }
  };

  try {
    getDatabaseUrl();
    await pgSaveSettingsJson(next, null);
  } catch (error) {
    if (error instanceof DatabaseUnavailableError) throw error;
    throw new DatabaseUnavailableError(
      error instanceof Error ? error.message : "PostgreSQL settings write failed"
    );
  }
  settingsMemCache = { value: next, at: Date.now() };
  return toPublicSettings(next);
}

export function toPublicSettings(settings: DeskSettings): PublicSettings {
  return {
    providerApiKeysConfigured: Object.fromEntries(
      Object.entries(settings.providerApiKeys).map(([key, value]) => [key, Boolean(value)])
    ),
    openAiApiKeyConfigured: Boolean(settings.openAiApiKey),
    priceRefreshMinutes: settings.priceRefreshMinutes,
    globalMarketRefreshMinutes: settings.globalMarketRefreshMinutes,
    globalExchangeRefreshMinutes: settings.globalExchangeRefreshMinutes,
    newsRefreshMinutes: settings.newsRefreshMinutes,
    intelligenceRefreshMinutes: settings.intelligenceRefreshMinutes,
    outlierThresholdPercent: settings.outlierThresholdPercent,
    marketSpreadAlertThresholdPercent: settings.marketSpreadAlertThresholdPercent,
    depegAlertThresholdPercent: settings.depegAlertThresholdPercent,
    enabledSources: settings.enabledSources
  };
}

function sanitizePatch(patch: SettingsPatch): Partial<DeskSettings> {
  const numericFields: Array<
    keyof Pick<
      DeskSettings,
      | "priceRefreshMinutes"
      | "globalMarketRefreshMinutes"
      | "globalExchangeRefreshMinutes"
      | "newsRefreshMinutes"
      | "intelligenceRefreshMinutes"
      | "outlierThresholdPercent"
      | "marketSpreadAlertThresholdPercent"
      | "depegAlertThresholdPercent"
    >
  > = [
    "priceRefreshMinutes",
    "globalMarketRefreshMinutes",
    "globalExchangeRefreshMinutes",
    "newsRefreshMinutes",
    "intelligenceRefreshMinutes",
    "outlierThresholdPercent",
    "marketSpreadAlertThresholdPercent",
    "depegAlertThresholdPercent"
  ];

  const cleaned: Partial<DeskSettings> = {};
  for (const field of numericFields) {
    const value = patch[field];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      cleaned[field] = value;
    }
  }

  if (typeof patch.openAiApiKey === "string" && patch.openAiApiKey.trim()) {
    cleaned.openAiApiKey = patch.openAiApiKey.trim();
  }

  return cleaned;
}

/** Test helper */
export function clearSettingsMemCache(): void {
  settingsMemCache = null;
}
