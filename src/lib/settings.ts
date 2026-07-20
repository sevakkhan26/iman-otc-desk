/**
 * Desk settings — PostgreSQL app_settings (single source of truth).
 * Fail closed when DATABASE_URL is unavailable.
 */
import { DatabaseUnavailableError, getDatabaseUrl } from "@/db/client";
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
const SETTINGS_MEM_TTL_MS = 5_000;

export async function getSettings(): Promise<DeskSettings> {
  if (settingsMemCache && Date.now() - settingsMemCache.at < SETTINGS_MEM_TTL_MS) {
    return settingsMemCache.value;
  }
  try {
    getDatabaseUrl();
    const stored = await pgGetSettingsJson();
    const value = mergeSettings(stored ?? {});
    settingsMemCache = { value, at: Date.now() };
    return value;
  } catch (error) {
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
