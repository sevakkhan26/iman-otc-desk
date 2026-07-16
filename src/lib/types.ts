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
  actualComparison?: string | null;
  link?: string | null;
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

/** Domestic LP runner health snapshot (same slots as live quotes). */
export interface DomesticProviderHealth {
  id: string;
  name: string;
  status: SourceStatus;
  endpoint: string;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  staleAgeMs: number | null;
  error: string | null;
  rateLimitedUntil: string | null;
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
  worstBuy: number | null;
  worstBuyExchange: string | null;
  buySpreadPercent: number | null;
  worstSell: number | null;
  worstSellExchange: string | null;
  sellSpreadPercent: number | null;
  activeSources: number;
  unavailableSources: number;
  outlierCount: number;
  lastUpdated: string | null;
}

export interface TetherMarketResponse {
  summary: TetherMarketSummary;
  exchanges: DomesticQuote[];
  settings: Pick<DeskSettings, "outlierThresholdPercent" | "marketSpreadAlertThresholdPercent">;
  /** Optional LP health from domestic runner slots (same refresh as exchanges). */
  providers?: DomesticProviderHealth[];
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
  translatedTitle: string;
  translatedSummary: string;
  source: string;
  publishedAt: string | null;
  severity: Severity;
  impactOnUsdtIrt: string;
  recommendedAction: string;
  assets: AssetTag[];
  category: NewsCategory;
  group: NewsGroup;
  url?: string;
  /** Extended Impact News fields (optional for backward compatibility). */
  iranRelevanceScore?: number;
  impactScore?: number;
  impactReason?: string;
  categoryLabel?: string;
  fetchedAt?: string;
  status?: "active" | "expired";
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
  buySpread: {
    best: { price: number | null; exchange: string | null };
    worst: { price: number | null; exchange: string | null };
    percent: number | null;
  };
  sellSpread: {
    best: { price: number | null; exchange: string | null };
    worst: { price: number | null; exchange: string | null };
    percent: number | null;
  };
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

export interface ImpactNewsProviderDiag {
  id: string;
  name: string;
  status: "healthy" | "degraded" | "unavailable";
  lastSuccessAt?: string | null;
  articleCount?: number;
  lastError?: string | null;
}

export interface ImpactNewsResponse {
  items: ImpactNewsItem[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
  updatedAt?: string | null;
  nextRefreshAt?: string | null;
  providers?: ImpactNewsProviderDiag[];
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

export type FxStreetAssetType =
  | "دلار کاغذی"
  | "دلار آمریکا هرات"
  | "دلار نقدی"
  | "دلار فردایی"
  | "دلار سبزه میدان"
  | "دلار بن‌بست"
  | "درهم امارات";

export type TelegramPriceType = "دلار کاغذی" | "دلار سبزه میدان" | "درهم امارات" | "دلار خروجی";

export interface FxStreetQuote {
  sourceId: string;
  sourceName: string;
  assetType: FxStreetAssetType;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  lastUpdated: string | null;
  status: SourceStatus;
  errorMessage?: string;
}

export interface FxStreetResponse {
  quotes: FxStreetQuote[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
  notes?: string[];
  stale?: boolean;
}

export type FxPricesApiSource = "navasan" | "bonbast";

export type FxPricesApiStatus = "ok" | "unavailable" | "error";

export interface FxPricesApiItem {
  source: FxPricesApiSource;
  asset: FxStreetAssetType;
  buy: number | null;
  sell: number | null;
  mid: number | null;
  lastUpdated: string;
  status: FxPricesApiStatus;
  error?: string;
}

export interface FxPricesApiResponse {
  items: FxPricesApiItem[];
  lastUpdated?: string;
  notes?: string[];
}

export type GoldInstrumentType =
  | "اونس طلا به دلار"
  | "یک گرم طلای 18 عیار"
  | "سکه طرح امامی"
  | "مثقال طلای آبشده";

export type GoldPriceUnit = "toman" | "usd_oz";

export type GoldPricesApiSource = "navasan" | "bonbast" | "talavest";

export type GoldHistoryRange = "24h" | "7d";

export type GoldPricesApiStatus = "ok" | "unavailable" | "error";

export interface GoldMarketQuote {
  sourceId: GoldPricesApiSource;
  sourceName: string;
  instrument: GoldInstrumentType;
  unit: GoldPriceUnit;
  buyPrice: number | null;
  sellPrice: number | null;
  midPrice: number | null;
  lastUpdated: string | null;
  status: SourceStatus;
}

export interface GoldMarketResponse {
  quotes: GoldMarketQuote[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  notes?: string[];
  stale?: boolean;
}

export interface GoldPricesApiItem {
  source: GoldPricesApiSource;
  instrument: GoldInstrumentType;
  unit: GoldPriceUnit;
  buy: number | null;
  sell: number | null;
  mid: number | null;
  lastUpdated: string;
  status: GoldPricesApiStatus;
}

export interface GoldPricesApiResponse {
  items: GoldPricesApiItem[];
  lastUpdated?: string;
  notes?: string[];
}

export interface GoldHistoryPoint {
  t: string;
  v: number;
}

export interface GoldHistorySeries {
  source: GoldPricesApiSource;
  sourceName: string;
  unit: GoldPriceUnit;
  points: GoldHistoryPoint[];
}

export interface GoldHistoryResponse {
  range: GoldHistoryRange;
  instrument: GoldInstrumentType;
  series: GoldHistorySeries[];
}

export interface TelegramPrice {
  type: TelegramPriceType;
  price: number | null;
  currency: string;
  sourceChannel: string;
  messageDate: string | null;
  receivedAt: string;
  rawText: string;
  confidence: "high" | "medium" | "low";
  status: "ok" | "no-data";
}

export interface TelegramPricesResponse {
  items: TelegramPrice[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
}
