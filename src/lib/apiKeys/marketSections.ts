/**
 * Map existing FX / gold server data into public API sections.
 * Uses only canonical provider functions already used by the panel —
 * no parallel caches or new pricing formulas beyond reusing bubble consolidation.
 */
import { buildConsolidatedDollarBubble } from "@/lib/bubble/compute";
import { sanitizeProviderError } from "@/lib/apiKeys/tetherPrices";
import { buildTetherPricesResponse, type TetherPricesResponse } from "@/lib/apiKeys/tetherPrices";
import type { ApiKeyScope } from "@/lib/apiKeys/types";
import { getFxStreetPrices } from "@/lib/providers/fxStreet";
import { getGoldMarketPrices } from "@/lib/providers/goldMarket";
import { getTetherMarketSnapshot } from "@/lib/marketSnapshot";
import { getSettings } from "@/lib/settings";
import type {
  FxStreetAssetType,
  FxStreetQuote,
  GoldInstrumentType,
  GoldMarketQuote,
  SourceStatus
} from "@/lib/types";

const SCHEMA = "1.0" as const;

function toNum(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

function mapStatus(status: SourceStatus): "active" | "degraded" | "disconnected" {
  if (status === "available") return "active";
  if (status === "degraded") return "degraded";
  return "disconnected";
}

function isUsdAsset(asset: FxStreetAssetType): boolean {
  return asset !== "درهم امارات";
}

function isAedAsset(asset: FxStreetAssetType): boolean {
  return asset === "درهم امارات";
}

export type FxSourcePrice = {
  sourceId: string;
  sourceName: string;
  asset: FxStreetAssetType;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  status: "active" | "degraded" | "disconnected";
  updatedAt: string | null;
  error: string | null;
};

function mapFxQuote(q: FxStreetQuote): FxSourcePrice {
  const disconnected = q.status === "unavailable";
  return {
    sourceId: q.sourceId,
    sourceName: q.sourceName,
    asset: q.assetType,
    buyPrice: disconnected ? null : toNum(q.buyPrice),
    sellPrice: disconnected ? null : toNum(q.sellPrice),
    midPrice: disconnected ? null : toNum(q.midPrice),
    status: mapStatus(q.status),
    updatedAt: disconnected ? null : q.lastUpdated,
    error: q.errorMessage ? sanitizeProviderError(q.errorMessage) : null
  };
}

export type UsdPricesResponse = {
  schemaVersion: typeof SCHEMA;
  generatedAt: string;
  serverNow: string;
  timezone: "Asia/Tehran";
  unit: "IRT";
  isStale: boolean;
  summary: {
    /** Arithmetic mean of valid market USD sources (existing bubble consolidation). */
    marketUsdAverage: number | null;
    /** USD implied from AED via existing DIRHAM_TO_USD conversion used by bubble. */
    usdFromAed: number | null;
    aedAverage: number | null;
  };
  sources: FxSourcePrice[];
};

export type AedPricesResponse = {
  schemaVersion: typeof SCHEMA;
  generatedAt: string;
  serverNow: string;
  timezone: "Asia/Tehran";
  unit: "IRT";
  isStale: boolean;
  summary: {
    aedAverage: number | null;
  };
  sources: FxSourcePrice[];
};

export type GoldSourcePrice = {
  sourceId: string;
  sourceName: string;
  instrument: GoldInstrumentType;
  unit: "toman" | "usd_oz";
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  status: "active" | "degraded" | "disconnected";
  updatedAt: string | null;
};

function mapGoldQuote(q: GoldMarketQuote): GoldSourcePrice {
  const disconnected = q.status === "unavailable";
  return {
    sourceId: q.sourceId,
    sourceName: q.sourceName,
    instrument: q.instrument,
    unit: q.unit,
    buyPrice: disconnected ? null : toNum(q.buyPrice),
    sellPrice: disconnected ? null : toNum(q.sellPrice),
    midPrice: disconnected ? null : toNum(q.midPrice),
    status: mapStatus(q.status),
    updatedAt: disconnected ? null : q.lastUpdated
  };
}

export type GoldPricesPublicResponse = {
  schemaVersion: typeof SCHEMA;
  generatedAt: string;
  serverNow: string;
  timezone: "Asia/Tehran";
  isStale: boolean;
  instruments: GoldInstrumentType[];
  sources: GoldSourcePrice[];
  providers?: Array<{
    id: string;
    name: string;
    status: "active" | "degraded" | "disconnected";
    lastSuccessAt: string | null;
    lastAttemptAt: string | null;
    error: string | null;
    stale: boolean;
  }>;
};

export type MarketPricesResponse = {
  schemaVersion: typeof SCHEMA;
  serverNow: string;
  timezone: "Asia/Tehran";
  unit: "IRT";
  grantedScopes: ApiKeyScope[];
  data: {
    tether?: TetherPricesResponse;
    usd?: UsdPricesResponse;
    aed?: AedPricesResponse;
    gold?: GoldPricesPublicResponse;
  };
};

/** Load FX once for USD and/or AED sections (shared process cache inside getFxStreetPrices). */
export async function buildUsdPricesResponse(): Promise<UsdPricesResponse> {
  const settings = await getSettings();
  const fx = await getFxStreetPrices(settings);
  const serverNow = new Date().toISOString();
  const bubble = buildConsolidatedDollarBubble(fx.quotes);
  const sources = fx.quotes.filter((q) => isUsdAsset(q.assetType)).map(mapFxQuote);

  return {
    schemaVersion: SCHEMA,
    generatedAt: fx.lastUpdated ?? serverNow,
    serverNow,
    timezone: "Asia/Tehran",
    unit: "IRT",
    isStale: Boolean(fx.stale),
    summary: {
      marketUsdAverage: bubble.consolidated?.averageMarketDollarToman ?? null,
      usdFromAed: bubble.consolidated?.calculatedDollarToman ?? null,
      aedAverage: bubble.consolidated?.averageDirhamToman ?? null
    },
    sources
  };
}

export async function buildAedPricesResponse(): Promise<AedPricesResponse> {
  const settings = await getSettings();
  const fx = await getFxStreetPrices(settings);
  const serverNow = new Date().toISOString();
  const bubble = buildConsolidatedDollarBubble(fx.quotes);
  const sources = fx.quotes.filter((q) => isAedAsset(q.assetType)).map(mapFxQuote);

  return {
    schemaVersion: SCHEMA,
    generatedAt: fx.lastUpdated ?? serverNow,
    serverNow,
    timezone: "Asia/Tehran",
    unit: "IRT",
    isStale: Boolean(fx.stale),
    summary: {
      aedAverage: bubble.consolidated?.averageDirhamToman ?? null
    },
    sources
  };
}

export async function buildGoldPricesPublicResponse(): Promise<GoldPricesPublicResponse> {
  const settings = await getSettings();
  const gold = await getGoldMarketPrices(settings);
  const serverNow = new Date().toISOString();
  const instruments = [
    ...new Set(gold.quotes.map((q) => q.instrument))
  ] as GoldInstrumentType[];

  return {
    schemaVersion: SCHEMA,
    generatedAt: gold.lastUpdated ?? serverNow,
    serverNow,
    timezone: "Asia/Tehran",
    isStale: Boolean(gold.stale),
    instruments,
    sources: gold.quotes.map(mapGoldQuote),
    providers: gold.providers?.map((p) => ({
      id: p.id,
      name: p.name,
      status: mapStatus(p.status),
      lastSuccessAt: p.lastSuccessAt,
      lastAttemptAt: p.lastAttemptAt,
      error: sanitizeProviderError(p.error),
      stale: p.stale
    }))
  };
}

export async function buildTetherSection(): Promise<TetherPricesResponse> {
  const snapshot = await getTetherMarketSnapshot();
  return buildTetherPricesResponse(snapshot, { serverNow: new Date().toISOString() });
}

/**
 * Combined payload: only sections for grantedScopes are included (keys absent otherwise).
 */
export async function buildMarketPricesResponse(
  grantedScopes: ApiKeyScope[]
): Promise<MarketPricesResponse> {
  const serverNow = new Date().toISOString();
  const data: MarketPricesResponse["data"] = {};

  const wantTether = grantedScopes.includes("tether:read");
  const wantUsd = grantedScopes.includes("usd:read");
  const wantAed = grantedScopes.includes("aed:read");
  const wantGold = grantedScopes.includes("gold:read");

  // Parallel only for requested sections — reuses process caches inside providers.
  const tasks: Promise<void>[] = [];
  if (wantTether) {
    tasks.push(
      buildTetherSection().then((section) => {
        data.tether = section;
      })
    );
  }
  if (wantUsd) {
    tasks.push(
      buildUsdPricesResponse().then((section) => {
        data.usd = section;
      })
    );
  }
  if (wantAed) {
    tasks.push(
      buildAedPricesResponse().then((section) => {
        data.aed = section;
      })
    );
  }
  if (wantGold) {
    tasks.push(
      buildGoldPricesPublicResponse().then((section) => {
        data.gold = section;
      })
    );
  }
  await Promise.all(tasks);

  return {
    schemaVersion: SCHEMA,
    serverNow,
    timezone: "Asia/Tehran",
    unit: "IRT",
    grantedScopes: [...grantedScopes],
    data
  };
}
