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

export type ForexResultClass = "better" | "weaker" | "inline" | "incomplete";
export type ForexReactionDirection = "up" | "down" | "flat";
export type ForexReactionWindow = "15m" | "1h" | "eod";

/** Observed price reaction window for a historical forex release (real samples only). */
export interface ForexMarketReaction {
  symbol: string;
  label: string;
  window: ForexReactionWindow;
  windowLabel: string;
  before: number | null;
  after: number | null;
  absoluteChange: number | null;
  percentChange: number | null;
  direction: ForexReactionDirection;
  directionLabel: string;
}

export interface ForexHistoricalEvent {
  id: string;
  title: string;
  titleFa: string;
  category: string;
  country: string;
  date: string;
  impact: ForexImpact;
  previous: string | null;
  forecast: string | null;
  actual: string | null;
  complete: boolean;
  surprise: number | null;
  surpriseDisplay: string | null;
  resultClass: ForexResultClass;
  resultLabel: string;
  summaryFa: string;
  reactionAvailable: boolean;
  reactionNote: string;
  reactions: ForexMarketReaction[];
  link?: string | null;
}

export interface ForexPreviousMonthSection {
  monthKey: string;
  monthLabelFa: string;
  /** Inclusive UTC start (first moment of previous calendar month). */
  rangeStart: string;
  /** Exclusive UTC end (first moment of current calendar month). */
  rangeEnd: string;
  events: ForexHistoricalEvent[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
}

export interface ForexEventsResponse {
  events: ForexEvent[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  message?: string;
  /** Important completed USD events for the immediately previous calendar month. */
  previousMonth?: ForexPreviousMonthSection;
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

/* ===== Configurable price alerts (Alerts page) ===== */

export type PriceAlertInstrumentId =
  | "usdt_irt"
  | "xau_usd"
  | "coin_emami"
  | "gold_18"
  | "aed"
  | "btc_usdt"
  | "eth_usdt";

export type PriceAlertPriceType = "buy" | "sell" | "mid" | "reference";
export type PriceAlertCondition = "gte" | "lte" | "cross_up" | "cross_down";
export type PriceAlertRepeatMode = "once" | "repeat";
export type PriceAlertStatus =
  | "active"
  | "degraded"
  | "disconnected"
  | "triggered"
  | "disabled";

export type PriceAlertProviderMode = "any" | "specific";

export interface PriceAlertRule {
  id: string;
  instrument: PriceAlertInstrumentId;
  targetPrice: number;
  condition: PriceAlertCondition;
  priceType: PriceAlertPriceType;
  providerMode: PriceAlertProviderMode;
  providerId: string | null;
  enabled: boolean;
  repeatMode: PriceAlertRepeatMode;
  cooldownSeconds: number;
  /** Always null — kept for backward-compatible storage only; not used by evaluation/UI. */
  expiresAt: string | null;
  note: string | null;
  previousObservedPrice: number | null;
  lastEvaluatedPrice: number | null;
  lastEvaluatedAt: string | null;
  lastTriggeredAt: string | null;
  triggerCount: number;
  lastProviderId: string | null;
  lastProviderName: string | null;
  status: PriceAlertStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface PriceAlertNotification {
  id: string;
  alertId: string;
  instrument: PriceAlertInstrumentId;
  providerId: string;
  providerName: string;
  priceType: PriceAlertPriceType;
  targetPrice: number;
  actualPrice: number;
  condition: PriceAlertCondition;
  triggeredAt: string;
  note: string | null;
  readAt: string | null;
}

export interface PriceAlertProviderOption {
  id: string;
  name: string;
  supportedPriceTypes: PriceAlertPriceType[];
  status: SourceStatus;
  buy: number | null;
  sell: number | null;
  mid: number | null;
  lastUpdated: string | null;
}

export interface PriceAlertInstrumentSnapshot {
  id: PriceAlertInstrumentId;
  label: string;
  unit: "toman" | "usd";
  unitLabel: string;
  price: number | null;
  priceType: PriceAlertPriceType | null;
  lastUpdated: string | null;
  sourceCount: number;
  health: SourceStatus;
  providers: PriceAlertProviderOption[];
}

export interface PriceAlertSummary {
  active: number;
  triggered: number;
  unread: number;
}

export interface PriceAlertsStorageDiagnostics {
  storageType: "file" | "upstash" | "none";
  storageConfigured: boolean;
  persistent: boolean;
  readable?: boolean | null;
  writable?: boolean | null;
  /** Same as vercel — explicit for production clients. */
  isVercel?: boolean;
  vercel: boolean;
  runtime: string;
  commit: string | null;
  region: string | null;
  databaseReachable: boolean | null;
  schemaAvailable: boolean;
  lastErrorCode: string | null;
  alertQuerySucceeded: boolean;
  notificationQuerySucceeded: boolean;
  authenticatedRole: string | null;
}

export interface PriceAlertsPageResponse {
  summary: PriceAlertSummary;
  instruments: PriceAlertInstrumentSnapshot[];
  alerts: PriceAlertRule[];
  notifications: PriceAlertNotification[];
  lastEvaluatedAt: string | null;
  diagnostics?: PriceAlertsStorageDiagnostics;
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

export interface ViewerAuthPublicMeta {
  source: "override" | "env" | "none";
  sessionEpoch: number;
  updatedAt: string | null;
  updatedBy: string | null;
  passwordConfigured: boolean;
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
  /** Present on settings GET/PATCH for admin (viewer password status). */
  viewerAuth?: ViewerAuthPublicMeta;
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

/** Per-source health from the same gold fetch cycle (no extra polling). */
export interface GoldProviderHealth {
  id: GoldPricesApiSource;
  name: string;
  status: SourceStatus;
  /** Instruments with a valid live/stale price this cycle. */
  instruments: GoldInstrumentType[];
  /** Expected instruments missing a valid price. */
  missingInstruments: GoldInstrumentType[];
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  error: string | null;
  stale: boolean;
}

export interface GoldMarketResponse {
  quotes: GoldMarketQuote[];
  sourceStatus: SourceStatus;
  lastUpdated: string | null;
  notes?: string[];
  stale?: boolean;
  /** Same-cycle provider health for the Gold LP warning panel. */
  providers?: GoldProviderHealth[];
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
  /** Same-cycle provider health for the Gold LP warning panel. */
  providers?: GoldProviderHealth[];
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
