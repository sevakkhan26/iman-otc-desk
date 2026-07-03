export type SourceStatus = "available" | "degraded" | "unavailable";
export type Severity = "low" | "medium" | "high";
export type MarketState = "calm" | "caution" | "risky";
export type AssetTag = "USDT" | "BTC" | "ETH" | "MACRO";
export type NewsCategory = "macro" | "asset";
export type NewsGroup = "global" | "iran" | "lp";
export type AlertCategory = "forex" | "price-diff" | "lp-specific" | "market";
export type DecisionLevel = "ok" | "watch" | "act";
export type ForexImpact = "high" | "medium" | "low" | "holiday";
export type PremiumImpact = "up" | "down" | "neutral";

export interface ForexEvent {
  id: string;
  title: string;
  category: string;
  country: string;
  date: string | null;
  impact: ForexImpact;
  previous: string | null;
  forecast: string | null;
  actual: string | null;
  premiumImpact: PremiumImpact;
  premiumImpactReason: string | null;
}

export type MedianHistoryRange = "24h" | "7d";

export interface MedianHistoryPoint {
  t: string;
  v: number;
}

export interface MedianHistoryResponse {
  range: MedianHistoryRange;
  points: MedianHistoryPoint[];
  first: number | null;
  last: number | null;
  min: number | null;
  max: number | null;
  changePercent: number | null;
}

export interface ForexEventsResponse {
  events: ForexEvent[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
}

export interface DomesticQuote {
  exchangeId: string;
  exchangeName: string;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  volume: number | null;
  spread: number | null;
  spreadPercent: number | null;
  deviationFromMedianPercent: number | null;
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  errorMessage?: string;
  isOutlier: boolean;
  excludedFromMedian: boolean;
}

export interface TetherMarketSummary {
  median: number | null;
  highest: number | null;
  highestExchange: string | null;
  lowest: number | null;
  lowestExchange: string | null;
  marketSpreadPercent: number | null;
  bestBuy: number | null;
  bestBuyExchange: string | null;
  bestSell: number | null;
  bestSellExchange: string | null;
  activeSources: number;
  unavailableSources: number;
  outlierCount: number;
  lastUpdated: string | null;
}

export interface TetherMarketResponse {
  summary: TetherMarketSummary;
  exchanges: DomesticQuote[];
  settings: Pick<DeskSettings, "outlierThresholdPercent" | "marketSpreadAlertThresholdPercent">;
}

export interface GlobalPrice {
  symbol: "BTC/USDT" | "ETH/USDT" | "USDT/USD";
  price: number | null;
  source: string;
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  errorMessage?: string;
}

export interface ExchangeOperationalStatus {
  exchangeName: "Binance" | "Kraken" | "OKX" | "Bybit" | "Coinbase";
  apiStatus: SourceStatus | "unknown";
  depositStatus: SourceStatus | "unknown";
  withdrawalStatus: SourceStatus | "unknown";
  maintenance: boolean | null;
  lastIncident: string | null;
  lastUpdated: string | null;
  impactOnDesk: string;
  sourceStatus: SourceStatus;
  errorMessage?: string;
}

export interface ImpactNewsItem {
  id: string;
  title: string;
  source: string;
  publishedAt: string | null;
  severity: Severity;
  impactOnUsdtIrt: string;
  recommendedAction: string;
  assets: AssetTag[];
  category: NewsCategory;
  group: NewsGroup;
  url?: string;
}

export interface AlertItem {
  id: string;
  title: string;
  severity: Severity;
  time: string;
  source: string;
  description: string;
  impactOnDesk: string;
  recommendedAction: string;
  assets: AssetTag[];
  category: AlertCategory;
}

export interface DecisionCard {
  level: DecisionLevel;
  headline: string;
  detail: string;
}

export interface QuickDecision {
  median: number | null;
  spreadPercent: number | null;
  highest: { price: number | null; exchange: string | null };
  lowest: { price: number | null; exchange: string | null };
  bestBuy: { price: number | null; exchange: string | null };
  bestSell: { price: number | null; exchange: string | null };
  spreadAction: DecisionCard;
  maxOrderAction: DecisionCard;
  lpCaution: DecisionCard;
  outlierWatch: DecisionCard;
}

export interface IntelligenceReport {
  id: string;
  generatedAt: string;
  riskLevel: Severity;
  summary: string;
  tetherAndCompetitors: string;
  importantNews: string;
  operationalRisks: string;
  pricingAction: string;
  spreadAction: string;
  lpSelectionAction: string;
  riskLimitsAction: string;
  treasuryAction: string;
  rawText: string;
}

export interface IntelligenceState {
  enabled: boolean;
  message: string;
  latest: IntelligenceReport | null;
}

export interface DashboardResponse {
  globalMarket: GlobalPrice[];
  tetherMarket: TetherMarketResponse;
  marketState: MarketState;
  quickDecision: QuickDecision;
  forex: ForexEventsResponse;
  intelligence: IntelligenceState;
  alerts: AlertItem[];
}

export interface ExchangeMonitorResponse {
  domestic: DomesticQuote[];
  global: ExchangeOperationalStatus[];
  tetherSummary: TetherMarketSummary;
}

export interface ImpactNewsResponse {
  items: ImpactNewsItem[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
}

export interface DeskSettings {
  providerApiKeys: Record<string, string>;
  openAiApiKey: string;
  priceRefreshMinutes: number;
  globalMarketRefreshMinutes: number;
  globalExchangeRefreshMinutes: number;
  newsRefreshMinutes: number;
  intelligenceRefreshMinutes: number;
  outlierThresholdPercent: number;
  marketSpreadAlertThresholdPercent: number;
  depegAlertThresholdPercent: number;
  enabledSources: Record<string, boolean>;
}

export interface PublicSettings {
  providerApiKeysConfigured: Record<string, boolean>;
  openAiApiKeyConfigured: boolean;
  priceRefreshMinutes: number;
  globalMarketRefreshMinutes: number;
  globalExchangeRefreshMinutes: number;
  newsRefreshMinutes: number;
  intelligenceRefreshMinutes: number;
  outlierThresholdPercent: number;
  marketSpreadAlertThresholdPercent: number;
  depegAlertThresholdPercent: number;
  enabledSources: Record<string, boolean>;
}

export interface SettingsPatch {
  providerApiKeys?: Record<string, string>;
  openAiApiKey?: string;
  priceRefreshMinutes?: number;
  globalMarketRefreshMinutes?: number;
  globalExchangeRefreshMinutes?: number;
  newsRefreshMinutes?: number;
  intelligenceRefreshMinutes?: number;
  outlierThresholdPercent?: number;
  marketSpreadAlertThresholdPercent?: number;
  depegAlertThresholdPercent?: number;
  enabledSources?: Record<string, boolean>;
}
