import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeskSettings, PublicSettings, SettingsPatch } from "@/lib/types";

const dataDir = path.join(process.cwd(), ".data");
const settingsPath = path.join(dataDir, "settings.json");

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
    const raw = await readFile(settingsPath, "utf8");
    const value = mergeSettings(JSON.parse(raw) as Partial<DeskSettings>);
    settingsMemCache = { value, at: Date.now() };
    return value;
  } catch {
    const value = mergeSettings({});
    settingsMemCache = { value, at: Date.now() };
    return value;
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

  await mkdir(dataDir, { recursive: true });
  await writeFile(settingsPath, JSON.stringify(next, null, 2), "utf8");
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
  const numericFields: Array<keyof Pick<
    DeskSettings,
    | "priceRefreshMinutes"
    | "globalMarketRefreshMinutes"
    | "globalExchangeRefreshMinutes"
    | "newsRefreshMinutes"
    | "intelligenceRefreshMinutes"
    | "outlierThresholdPercent"
    | "marketSpreadAlertThresholdPercent"
    | "depegAlertThresholdPercent"
  >> = [
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
