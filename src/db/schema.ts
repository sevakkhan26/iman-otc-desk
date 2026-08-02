/**
 * Canonical PostgreSQL schema for OTC desk durable state.
 * All timestamps are UTC. Financial amounts use numeric (no float).
 */
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

/** Managed + bootstrap users (env admin/viewer mirrored as rows with source flag in metadata). */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull(),
    usernameKey: text("username_key").notNull(),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull(), // admin | viewer
    isActive: boolean("is_active").notNull().default(true),
    /** Session invalidation counter (maps to JWT pv / sessionEpoch). */
    credentialVersion: integer("credential_version").notNull().default(0),
    source: text("source").notNull().default("managed"), // env | managed
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at"),
    lastLoginAt: ts("last_login_at"),
    updatedBy: text("updated_by"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({})
  },
  (t) => [uniqueIndex("users_username_key_uidx").on(t.usernameKey)]
);

/** Optional server-side session registry (hashed tokens). JWT pv still enforced via credentialVersion. */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    lastSeenAt: ts("last_seen_at"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("auth_sessions_token_hash_uidx").on(t.tokenHash),
    index("auth_sessions_user_idx").on(t.userId)
  ]
);

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedBy: text("updated_by"),
  updatedAt: ts("updated_at").notNull().defaultNow()
});

export const apiClients = pgTable("api_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdBy: text("created_by"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at")
});

export const apiKeys = pgTable(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id").references(() => apiClients.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keySuffix: text("key_suffix").notNull(),
    keyHash: text("key_hash").notNull(),
    expiresAt: ts("expires_at"),
    revokedAt: ts("revoked_at"),
    lastUsedAt: ts("last_used_at"),
    createdBy: text("created_by"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_uidx").on(t.keyHash),
    index("api_keys_prefix_idx").on(t.keyPrefix)
  ]
);

export const apiKeyScopes = pgTable(
  "api_key_scopes",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    scope: text("scope").notNull()
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.scope] })]
);

export const apiRateLimitBuckets = pgTable(
  "api_rate_limit_buckets",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    /** Epoch ms window start — bigint (JS Date.now exceeds int32). */
    bucketStartMs: bigint("bucket_start_ms", { mode: "number" }).notNull(),
    requestCount: integer("request_count").notNull().default(0)
  },
  (t) => [primaryKey({ columns: [t.apiKeyId, t.bucketStartMs] })]
);

export const marketSources = pgTable(
  "market_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    displayName: text("display_name").notNull(),
    marketType: text("market_type").notNull(), // tether | usd | aed | gold | global
    isEnabled: boolean("is_enabled").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
  },
  (t) => [uniqueIndex("market_sources_code_uidx").on(t.code)]
);

export const marketSnapshots = pgTable(
  "market_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketType: text("market_type").notNull(), // tether | fx | gold | bubble | composite
    generatedAt: ts("generated_at").notNull(),
    serverTime: ts("server_time").notNull(),
    isStale: boolean("is_stale").notNull().default(false),
    summary: jsonb("summary").$type<Record<string, unknown>>().notNull().default({}),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    contentHash: text("content_hash").notNull(),
    settingsKey: text("settings_key"),
    refreshIntervalMs: integer("refresh_interval_ms"),
    lastSuccessfulRefreshAt: ts("last_successful_refresh_at"),
    lastAttemptedRefreshAt: ts("last_attempted_refresh_at"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("market_snapshots_type_hash_uidx").on(t.marketType, t.contentHash),
    index("market_snapshots_type_generated_idx").on(t.marketType, t.generatedAt)
  ]
);

export const marketQuotes = pgTable(
  "market_quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => marketSnapshots.id, { onDelete: "cascade" }),
    sourceCode: text("source_code").notNull(),
    sourceName: text("source_name"),
    instrument: text("instrument").notNull(),
    currencyUnit: text("currency_unit"),
    /** Desk bid (user sell USDT) */
    buyPrice: numeric("buy_price", { precision: 24, scale: 8 }),
    /** Desk ask (user buy USDT) */
    sellPrice: numeric("sell_price", { precision: 24, scale: 8 }),
    midPrice: numeric("mid_price", { precision: 24, scale: 8 }),
    userBuyPrice: numeric("user_buy_price", { precision: 24, scale: 8 }),
    userSellPrice: numeric("user_sell_price", { precision: 24, scale: 8 }),
    sourceUpdatedAt: ts("source_updated_at"),
    sourceStatus: text("source_status").notNull().default("available"),
    sanitizedError: text("sanitized_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    index("market_quotes_snapshot_idx").on(t.snapshotId),
    index("market_quotes_source_idx").on(t.sourceCode)
  ]
);

export const sourceHealth = pgTable(
  "source_health",
  {
    sourceCode: text("source_code").notNull(),
    marketType: text("market_type").notNull(),
    status: text("status").notNull(),
    lastAttemptAt: ts("last_attempt_at"),
    lastSuccessAt: ts("last_success_at"),
    latencyMs: integer("latency_ms"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    lastError: text("last_error"),
    endpoint: text("endpoint"),
    buyPrice: numeric("buy_price", { precision: 24, scale: 8 }),
    sellPrice: numeric("sell_price", { precision: 24, scale: 8 }),
    midPrice: numeric("mid_price", { precision: 24, scale: 8 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [primaryKey({ columns: [t.sourceCode, t.marketType] })]
);

export const ingestionRuns = pgTable(
  "ingestion_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketType: text("market_type").notNull(),
    startedAt: ts("started_at").notNull(),
    completedAt: ts("completed_at"),
    status: text("status").notNull(),
    sourcesAttempted: integer("sources_attempted").default(0),
    sourcesSucceeded: integer("sources_succeeded").default(0),
    sanitizedError: text("sanitized_error"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({})
  },
  (t) => [index("ingestion_runs_type_started_idx").on(t.marketType, t.startedAt)]
);

export const priceAlerts = pgTable(
  "price_alerts",
  {
    id: text("id").primaryKey(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at")
  },
  (t) => [index("price_alerts_created_idx").on(t.createdAt)]
);

export const alertNotifications = pgTable(
  "alert_notifications",
  {
    id: text("id").primaryKey(),
    alertId: text("alert_id"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    triggeredAt: ts("triggered_at"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("alert_notifications_alert_idx").on(t.alertId)]
);

export const medianHistorySamples = pgTable(
  "median_history_samples",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sampledAtMs: bigint("sampled_at_ms", { mode: "number" }).notNull(),
    medianValue: numeric("median_value", { precision: 24, scale: 8 }).notNull()
  },
  (t) => [uniqueIndex("median_history_sampled_uidx").on(t.sampledAtMs)]
);

export const newsItems = pgTable(
  "news_items",
  {
    id: text("id").primaryKey(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    publishedAt: ts("published_at"),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [index("news_items_published_idx").on(t.publishedAt)]
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorApiKeyId: uuid("actor_api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("audit_logs_created_idx").on(t.createdAt)]
);

export const schemaMeta = pgTable("schema_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow()
});

/* ── Shadow Arbitrage Phase 2 (no OMPFinex) ───────────────── */

export const shadowObservationSessions = pgTable("shadow_observation_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  status: text("status").notNull().default("NOT_STARTED"),
  targetDurationMs: bigint("target_duration_ms", { mode: "number" }).notNull().default(1_209_600_000),
  startedAt: ts("started_at"),
  endedAt: ts("ended_at"),
  lastHeartbeatAt: ts("last_heartbeat_at"),
  lastSuccessAt: ts("last_success_at"),
  completedCycles: integer("completed_cycles").notNull().default(0),
  successfulCycles: integer("successful_cycles").notNull().default(0),
  failedCycles: integer("failed_cycles").notNull().default(0),
  partialCycles: integer("partial_cycles").notNull().default(0),
  pollIntervalMs: integer("poll_interval_ms").notNull().default(30_000),
  workerId: text("worker_id"),
  /** Set while status = PAUSED; cleared on resume. */
  pausedAt: ts("paused_at"),
  /** Accumulated paused time so 14-day progress excludes deliberate pauses. */
  pausedTotalMs: bigint("paused_total_ms", { mode: "number" }).notNull().default(0),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow()
});

export const shadowCollectionRuns = pgTable(
  "shadow_collection_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").references(() => shadowObservationSessions.id, {
      onDelete: "set null"
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    startedAt: ts("started_at").notNull(),
    finishedAt: ts("finished_at"),
    status: text("status").notNull().default("running"),
    sourcesOk: integer("sources_ok").notNull().default(0),
    sourcesFailed: integer("sources_failed").notNull().default(0),
    opportunityCount: integer("opportunity_count").notNull().default(0),
    durationMs: integer("duration_ms"),
    errorMessage: text("error_message"),
    workerId: text("worker_id"),
    /** Sources attempted this cycle (for honest coverage math). */
    sourcesTotal: integer("sources_total").notNull().default(0),
    /** sourcesOk / sourcesTotal for this cycle. */
    coveragePercent: numeric("coverage_percent", { precision: 6, scale: 2 }),
    pollIntervalMs: integer("poll_interval_ms"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("shadow_runs_idempotency_uidx").on(t.idempotencyKey),
    index("shadow_runs_started_idx").on(t.startedAt)
  ]
);

export const shadowSourceSnapshots = pgTable(
  "shadow_source_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    runId: uuid("run_id")
      .notNull()
      .references(() => shadowCollectionRuns.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    receivedAt: ts("received_at").notNull(),
    sourceTimestamp: ts("source_timestamp"),
    health: text("health").notNull(),
    marketModel: text("market_model").notNull(),
    certStatus: text("cert_status"),
    userBuyToman: numeric("user_buy_toman", { precision: 24, scale: 0 }),
    userSellToman: numeric("user_sell_toman", { precision: 24, scale: 0 }),
    latencyMs: integer("latency_ms"),
    httpStatus: integer("http_status"),
    /** False when the venue only exposes a headline quote (no walkable book). */
    depthAvailable: boolean("depth_available"),
    maxExecutableUsdt: numeric("max_executable_usdt", { precision: 18, scale: 4 }),
    feeStatus: text("fee_status"),
    /** Snapshot age exceeded the staleness budget at collection time. */
    stale: boolean("stale").notNull().default(false),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    errorReason: text("error_reason"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    index("shadow_src_snap_source_time_idx").on(t.sourceId, t.receivedAt),
    index("shadow_src_snap_run_idx").on(t.runId)
  ]
);

export const shadowOpportunityLifecycles = pgTable(
  "shadow_opportunity_lifecycles",
  {
    id: text("id").primaryKey(),
    routeKey: text("route_key").notNull(),
    buySourceId: text("buy_source_id").notNull(),
    sellSourceId: text("sell_source_id").notNull(),
    sizeUsdt: numeric("size_usdt", { precision: 12, scale: 4 }).notNull(),
    eligibility: text("eligibility").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    endedAt: ts("ended_at"),
    buyVwapToman: numeric("buy_vwap_toman", { precision: 24, scale: 0 }).notNull(),
    sellVwapToman: numeric("sell_vwap_toman", { precision: 24, scale: 0 }).notNull(),
    rawSpreadPercent: numeric("raw_spread_percent", { precision: 18, scale: 8 }).notNull(),
    netEdgePercent: numeric("net_edge_percent", { precision: 18, scale: 8 }).notNull(),
    netProfitToman: numeric("net_profit_toman", { precision: 24, scale: 0 }).notNull(),
    maxNetEdgePercent: numeric("max_net_edge_percent", { precision: 18, scale: 8 }).notNull(),
    maxNetProfitToman: numeric("max_net_profit_toman", { precision: 24, scale: 0 }).notNull(),
    maxRawSpreadPercent: numeric("max_raw_spread_percent", { precision: 18, scale: 8 }),
    /** True when either venue's fee is unverified — net figures are raw potential only. */
    feeUnknown: boolean("fee_unknown").notNull().default(false),
    /** Cycles this lifecycle has been observed in (one lifecycle, many observations). */
    observationCount: integer("observation_count").notNull().default(1),
    blockedReasons: jsonb("blocked_reasons").$type<string[]>().default([]).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}).notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [
    index("shadow_opp_route_active_idx").on(t.routeKey, t.isActive),
    index("shadow_opp_last_seen_idx").on(t.lastSeenAt),
    index("shadow_opp_active_idx").on(t.isActive)
  ]
);

export const shadowWorkerHeartbeat = pgTable("shadow_worker_heartbeat", {
  id: text("id").primaryKey().default("primary"),
  workerId: text("worker_id").notNull(),
  status: text("status").notNull().default("idle"),
  lastHeartbeatAt: ts("last_heartbeat_at").notNull(),
  lastCycleAt: ts("last_cycle_at"),
  lastCycleStatus: text("last_cycle_status"),
  pollIntervalMs: integer("poll_interval_ms").notNull().default(30_000),
  /** Cooperative lease: a second worker may take over only after this passes. */
  leaseExpiresAt: ts("lease_expires_at"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
  updatedAt: ts("updated_at").notNull().defaultNow()
});

/**
 * Health transition log — one row per change of source health/certification,
 * not one row per cycle. Keeps 14 days of source reliability cheap to query.
 */
export const shadowSourceHealthEvents = pgTable(
  "shadow_source_health_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id").notNull(),
    runId: uuid("run_id"),
    occurredAt: ts("occurred_at").notNull(),
    fromHealth: text("from_health"),
    toHealth: text("to_health").notNull(),
    fromCertStatus: text("from_cert_status"),
    toCertStatus: text("to_cert_status"),
    reason: text("reason"),
    httpStatus: integer("http_status"),
    latencyMs: integer("latency_ms"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    index("shadow_health_evt_source_time_idx").on(t.sourceId, t.occurredAt),
    index("shadow_health_evt_time_idx").on(t.occurredAt)
  ]
);

/** Lifecycle transition records — opened / eligibility change / closed / reappeared. */
export const shadowOpportunityEvents = pgTable(
  "shadow_opportunity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    lifecycleId: text("lifecycle_id").notNull(),
    routeKey: text("route_key").notNull(),
    occurredAt: ts("occurred_at").notNull(),
    eventType: text("event_type").notNull(), // opened | eligibility_change | closed | reappeared
    fromEligibility: text("from_eligibility"),
    toEligibility: text("to_eligibility"),
    netEdgePercent: numeric("net_edge_percent", { precision: 18, scale: 8 }),
    netProfitToman: numeric("net_profit_toman", { precision: 24, scale: 0 }),
    rawSpreadPercent: numeric("raw_spread_percent", { precision: 18, scale: 8 }),
    blockedReasons: jsonb("blocked_reasons").$type<string[]>().default([]).notNull(),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    index("shadow_opp_evt_lifecycle_idx").on(t.lifecycleId, t.occurredAt),
    index("shadow_opp_evt_time_idx").on(t.occurredAt),
    index("shadow_opp_evt_route_idx").on(t.routeKey)
  ]
);

/**
 * Compact per-route/per-size/per-day aggregate so 14-day analytics never scans
 * the full snapshot history.
 */
export const shadowRouteMetrics = pgTable(
  "shadow_route_metrics",
  {
    /** `${routeKey}|${bucketDate}` — deterministic, so upserts stay idempotent. */
    id: text("id").primaryKey(),
    routeKey: text("route_key").notNull(),
    buySourceId: text("buy_source_id").notNull(),
    sellSourceId: text("sell_source_id").notNull(),
    sizeUsdt: numeric("size_usdt", { precision: 12, scale: 4 }).notNull(),
    bucketDate: text("bucket_date").notNull(), // UTC YYYY-MM-DD
    samples: integer("samples").notNull().default(0),
    positiveRawSamples: integer("positive_raw_samples").notNull().default(0),
    positiveNetSamples: integer("positive_net_samples").notNull().default(0),
    sumRawSpreadPercent: numeric("sum_raw_spread_percent", { precision: 24, scale: 8 }).notNull().default("0"),
    maxRawSpreadPercent: numeric("max_raw_spread_percent", { precision: 18, scale: 8 }),
    sumNetEdgePercent: numeric("sum_net_edge_percent", { precision: 24, scale: 8 }).notNull().default("0"),
    maxNetEdgePercent: numeric("max_net_edge_percent", { precision: 18, scale: 8 }),
    maxNetProfitToman: numeric("max_net_profit_toman", { precision: 24, scale: 0 }),
    feeUnknown: boolean("fee_unknown").notNull().default(false),
    blockedCounts: jsonb("blocked_counts").$type<Record<string, number>>().default({}).notNull(),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [
    index("shadow_route_metrics_route_idx").on(t.routeKey),
    index("shadow_route_metrics_bucket_idx").on(t.bucketDate)
  ]
);


/**
 * Phase 4 — admin-confirmed fee tiers. Append-only: every confirmation is a new
 * row so the audit history is preserved. Never stores API keys or credentials.
 */
export const shadowFeeConfirmations = pgTable(
  "shadow_fee_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id").notNull(),
    takerFeeBps: integer("taker_fee_bps").notNull(),
    /** Reference only — no maker-order simulation exists, so it never settles. */
    makerFeeBps: integer("maker_fee_bps"),
    feeTier: text("fee_tier"),
    sourceUrl: text("source_url"),
    /** How the number was evidenced. NULL on legacy rows = ADMIN_CONFIRMED. */
    provenance: text("provenance"),
    /** Per-confirmation validity; NULL falls back to the global window. */
    validDays: integer("valid_days"),
    /** Quoted-market and easy-trade rates that must never touch USDT/IRT maths. */
    referenceMetadata: jsonb("reference_metadata"),
    /** Idempotency handle: the same evidence imported twice is one row. */
    evidenceKey: text("evidence_key"),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: ts("confirmed_at").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_fee_conf_source_time_idx").on(t.sourceId, t.confirmedAt)]
);

/**
 * Admin-confirmed account / KYC evidence, append-only.
 *
 * Account state used to be compiled-in configuration; a confirmation is real
 * evidence about this desk's accounts and belongs here, with provenance and an
 * expiry like every other piece of evidence. `executionEligible` is deliberately
 * separate from `kycComplete`: a venue can be fully verified and still be barred
 * from execution (degraded data, reference-only venue).
 */
export const shadowAccountConfirmations = pgTable(
  "shadow_account_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: text("source_id").notNull(),
    kycComplete: boolean("kyc_complete").notNull(),
    accountState: text("account_state").notNull(),
    executionEligible: boolean("execution_eligible").notNull(),
    ineligibleReason: text("ineligible_reason"),
    provenance: text("provenance").notNull(),
    validDays: integer("valid_days"),
    evidenceKey: text("evidence_key"),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: ts("confirmed_at").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_account_conf_source_time_idx").on(t.sourceId, t.confirmedAt)]
);

/**
 * Phase 5 — virtual capital allocation plans for the Shadow simulator.
 * Append-only: every save is a new row, so the allocation history is auditable.
 * These balances are simulated. No exchange account, credential, order or
 * transfer is represented here.
 */
export const shadowCapitalPlans = pgTable(
  "shadow_capital_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    mode: text("mode").notNull(), // MANUAL | OPTIMIZED
    totalCapitalToman: bigint("total_capital_toman", { mode: "number" }).notNull(),
    valuationPriceToman: integer("valuation_price_toman").notNull(),
    reservePercent: integer("reserve_percent").notNull().default(0),
    /** [{ sourceId, irtToman, usdtUnits }] — virtual balances only. */
    allocations: jsonb("allocations")
      .$type<Array<{ sourceId: string; irtToman: number; usdtUnits: number }>>()
      .notNull(),
    createdBy: text("created_by").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_capital_plans_created_idx").on(t.createdAt)]
);

/**
 * Phase 8C-5 — append-only allocation proposals.
 *
 * A proposal is what the optimizer WOULD do with the virtual portfolio. It is
 * never applied automatically and never edited: applying appends a decision
 * row, so the history of what was proposed and what was accepted survives in
 * full. Simulation only — no order, no transfer, no exchange contact.
 */
export const shadowAllocationProposals = pgTable(
  "shadow_allocation_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    totalCapitalToman: bigint("total_capital_toman", { mode: "number" }).notNull(),
    valuationPriceToman: integer("valuation_price_toman").notNull(),
    /** Re-valued from the stored rows, so a row proves its own conservation. */
    allocatedToman: bigint("allocated_toman", { mode: "number" }).notNull(),
    residualToman: bigint("residual_toman", { mode: "number" }).notNull(),
    rows: jsonb("rows").$type<unknown[]>().notNull(),
    booksFingerprint: text("books_fingerprint").notNull(),
    feesFingerprint: text("fees_fingerprint").notNull(),
    accountsFingerprint: text("accounts_fingerprint").notNull(),
    policyFingerprint: text("policy_fingerprint").notNull(),
    /** UNSET caps are listed explicitly; they are never stored as zero. */
    appliedPolicyCaps: jsonb("applied_policy_caps").$type<unknown>().notNull(),
    unsetPolicyCaps: jsonb("unset_policy_caps").$type<string[]>().notNull(),
    observations: jsonb("observations").$type<unknown[]>().notNull(),
    status: text("status").notNull().default("PROPOSED"),
    createdBy: text("created_by").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_allocation_proposals_created_idx").on(t.createdAt)]
);

/**
 * Append-only decision log for proposals.
 *
 * The unique idempotency key is the whole apply-once guarantee: a retry with
 * the same key cannot insert a second row, so a duplicated request returns the
 * first outcome instead of re-applying it.
 */
export const shadowAllocationDecisions = pgTable(
  "shadow_allocation_decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => shadowAllocationProposals.id),
    sessionId: uuid("session_id"),
    decision: text("decision").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    detailFa: text("detail_fa").notNull(),
    balancesBefore: jsonb("balances_before").$type<unknown[]>(),
    balancesAfter: jsonb("balances_after").$type<unknown[]>(),
    decidedBy: text("decided_by").notNull(),
    decidedAt: ts("decided_at").notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("shadow_allocation_decisions_idem_idx").on(t.idempotencyKey),
    index("shadow_allocation_decisions_proposal_idx").on(t.proposalId, t.decidedAt)
  ]
);

/**
 * Phase 5 — explicit admin confirmation of a simulated capital plan.
 * Append-only. An approval is pinned to the plan and to the account/fee
 * readiness it was granted against, so a later change invalidates it.
 * Approving a simulation never places an order and never moves funds.
 */
export const shadowCapitalApprovals = pgTable(
  "shadow_capital_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    planId: uuid("plan_id"),
    planFingerprint: text("plan_fingerprint").notNull(),
    readinessFingerprint: text("readiness_fingerprint").notNull(),
    approvedBy: text("approved_by").notNull(),
    approvedAt: ts("approved_at").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_capital_approvals_time_idx").on(t.approvedAt)]
);

/* ── Shadow Arbitrage Phase 6 — paper execution (simulated, never real) ───── */

/**
 * A paper trading session. Append-only in spirit: rows are created by an admin
 * and only their lifecycle status/timestamps change. Nothing here represents a
 * real exchange account, order or transfer.
 */
export const shadowPaperSessions = pgTable(
  "shadow_paper_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    observationId: uuid("observation_id"),
    name: text("name").notNull(),
    /** PROVISIONAL_EVALUATION | APPROVED_PLAN */
    mode: text("mode").notNull(),
    /** NOT_STARTED | RUNNING | PAUSED | STOPPED */
    status: text("status").notNull().default("NOT_STARTED"),
    totalCapitalToman: bigint("total_capital_toman", { mode: "number" }).notNull(),
    valuationPriceToman: integer("valuation_price_toman").notNull(),
    /** Opening book, kept so inventory drift can be measured against it. */
    openingAllocations: jsonb("opening_allocations")
      .$type<Array<{ sourceId: string; irtToman: number; usdtUnits: number }>>()
      .notNull(),
    /** Fingerprint of the Phase 5 approval this session was started from. */
    approvalFingerprint: text("approval_fingerprint"),
    createdBy: text("created_by").notNull(),
    startedAt: ts("started_at"),
    pausedAt: ts("paused_at"),
    stoppedAt: ts("stopped_at"),
    lastCycleAt: ts("last_cycle_at"),
    cyclesEvaluated: integer("cycles_evaluated").notNull().default(0),
    tradesExecuted: integer("trades_executed").notNull().default(0),
    candidatesSkipped: integer("candidates_skipped").notNull().default(0),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [index("shadow_paper_sessions_status_idx").on(t.status, t.createdAt)]
);

/** Current virtual balances per venue for a session. Integer units only. */
export const shadowPaperBalances = pgTable(
  "shadow_paper_balances",
  {
    /** `${sessionId}|${sourceId}` — deterministic, so upserts stay idempotent. */
    id: text("id").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    sourceId: text("source_id").notNull(),
    irtToman: bigint("irt_toman", { mode: "number" }).notNull().default(0),
    usdtMicros: bigint("usdt_micros", { mode: "number" }).notNull().default(0),
    updatedAt: ts("updated_at").notNull().defaultNow()
  },
  (t) => [index("shadow_paper_balances_session_idx").on(t.sessionId)]
);

/**
 * Immutable paper ledger. One row per decision — filled or skipped — so the
 * reason a candidate did not trade is as auditable as a trade itself.
 * `idempotencyKey` makes a lifecycle executable at most once per session.
 */
export const shadowPaperLedger = pgTable(
  "shadow_paper_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    runId: uuid("run_id"),
    /** `${sessionId}|${lifecycleId}` for fills; unique, so refills are refused. */
    idempotencyKey: text("idempotency_key"),
    lifecycleId: text("lifecycle_id").notNull(),
    routeKey: text("route_key").notNull(),
    /** FILLED | SKIPPED */
    outcome: text("outcome").notNull(),
    rejectionCode: text("rejection_code"),
    rejectionReason: text("rejection_reason"),
    requiredRebalance: text("required_rebalance"),
    buySourceId: text("buy_source_id").notNull(),
    sellSourceId: text("sell_source_id").notNull(),
    sizeUsdt: numeric("size_usdt", { precision: 12, scale: 4 }).notNull(),
    buyVwapToman: bigint("buy_vwap_toman", { mode: "number" }),
    sellVwapToman: bigint("sell_vwap_toman", { mode: "number" }),
    buyNotionalToman: bigint("buy_notional_toman", { mode: "number" }),
    sellNotionalToman: bigint("sell_notional_toman", { mode: "number" }),
    buyFeeBps: integer("buy_fee_bps"),
    sellFeeBps: integer("sell_fee_bps"),
    /** Fee settlement is recorded per side, not as one global fee currency. */
    buyFeeAsset: text("buy_fee_asset"),
    buyFeeDebitMode: text("buy_fee_debit_mode"),
    buyFeeProvenance: text("buy_fee_provenance"),
    sellFeeAsset: text("sell_fee_asset"),
    sellFeeDebitMode: text("sell_fee_debit_mode"),
    sellFeeProvenance: text("sell_fee_provenance"),
    feeTomanTotal: bigint("fee_toman_total", { mode: "number" }),
    feeUsdtMicrosTotal: bigint("fee_usdt_micros_total", { mode: "number" }),
    slippageBufferToman: bigint("slippage_buffer_toman", { mode: "number" }),
    grossSpreadToman: bigint("gross_spread_toman", { mode: "number" }),
    /** Same-cycle mark price used to value the USDT fee. */
    markPriceToman: bigint("mark_price_toman", { mode: "number" }),
    /** Cash only: proceeds − cost − buy fee in IRT. Never the execution gate. */
    cashPnlIrtToman: bigint("cash_pnl_irt_toman", { mode: "number" }),
    inventoryDeltaUsdtMicros: bigint("inventory_delta_usdt_micros", { mode: "number" }),
    sellFeeValueToman: bigint("sell_fee_value_toman", { mode: "number" }),
    economicNetPnlToman: bigint("economic_net_pnl_toman", { mode: "number" }),
    riskAdjustedPnlToman: bigint("risk_adjusted_pnl_toman", { mode: "number" }),
    /** FIRST_SEEN | CHANGED | FILLED | CLOSED — why this row exists at all. */
    eventType: text("event_type"),
    /** Every exact cause that applied, canonically ordered. */
    reasonCodes: jsonb("reason_codes").$type<string[]>().default([]).notNull(),
    /** Balances of both touched venues immediately after the fill. */
    balancesAfter: jsonb("balances_after")
      .$type<Array<{ sourceId: string; irtToman: number; usdtMicros: number }>>()
      .default([])
      .notNull(),
    occurredAt: ts("occurred_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [
    uniqueIndex("shadow_paper_ledger_idem_idx").on(t.idempotencyKey),
    index("shadow_paper_ledger_session_time_idx").on(t.sessionId, t.occurredAt),
    index("shadow_paper_ledger_outcome_idx").on(t.sessionId, t.outcome)
  ]
);

/**
 * v4.9.1 — per-candidate decision state.
 *
 * One row per (session, lifecycle). A detailed ledger event is written only
 * when this row's decision key changes, so an unchanged blocked candidate does
 * not produce a new row every 30 seconds.
 */
export const shadowPaperCandidateState = pgTable(
  "shadow_paper_candidate_state",
  {
    /** `${sessionId}|${lifecycleId}` — deterministic, so upserts stay idempotent. */
    id: text("id").primaryKey(),
    sessionId: uuid("session_id").notNull(),
    lifecycleId: text("lifecycle_id").notNull(),
    routeKey: text("route_key").notNull(),
    buySourceId: text("buy_source_id").notNull(),
    sellSourceId: text("sell_source_id").notNull(),
    sizeUsdt: numeric("size_usdt", { precision: 12, scale: 4 }).notNull(),
    /** `${outcome}:${sorted reason codes}` — the change detector. */
    decisionKey: text("decision_key").notNull(),
    outcome: text("outcome").notNull(),
    primaryReason: text("primary_reason"),
    reasonCodes: jsonb("reason_codes").$type<string[]>().default([]).notNull(),
    /** Cycles this candidate was observed in, including unchanged ones. */
    occurrences: integer("occurrences").notNull().default(1),
    firstSeenAt: ts("first_seen_at").notNull(),
    lastSeenAt: ts("last_seen_at").notNull(),
    lastChangedAt: ts("last_changed_at").notNull(),
    closedAt: ts("closed_at")
  },
  (t) => [
    index("shadow_paper_state_session_idx").on(t.sessionId, t.lastSeenAt),
    index("shadow_paper_state_reason_idx").on(t.sessionId, t.primaryReason)
  ]
);

/**
 * v4.9.1 — one compact summary per paper cycle, with counts grouped by exact
 * reason. This is what makes per-cycle volume constant instead of proportional
 * to the number of evaluated candidates.
 */
export const shadowPaperCycleSummaries = pgTable(
  "shadow_paper_cycle_summaries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sessionId: uuid("session_id").notNull(),
    runId: uuid("run_id"),
    occurredAt: ts("occurred_at").notNull(),
    candidatesEvaluated: integer("candidates_evaluated").notNull().default(0),
    filled: integer("filled").notNull().default(0),
    skipped: integer("skipped").notNull().default(0),
    /** Detailed rows this cycle actually wrote — normally 0 in a steady state. */
    detailedEventsWritten: integer("detailed_events_written").notNull().default(0),
    /** { reasonCode: count } for this cycle. */
    reasonCounts: jsonb("reason_counts").$type<Record<string, number>>().default({}).notNull(),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_paper_cycle_summary_idx").on(t.sessionId, t.occurredAt)]
);

/* ── Phase 7A — guarded live-execution readiness (no live trading) ────────── */

/**
 * Append-only human attestations backing readiness gates a machine cannot
 * verify from inside this system. Stores STATEMENTS about key permissions —
 * never a key, secret or token.
 */
export const shadowLiveAttestations = pgTable(
  "shadow_live_attestations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind").notNull(),
    confirmedBy: text("confirmed_by").notNull(),
    confirmedAt: ts("confirmed_at").notNull(),
    /** Structured boolean/number claims. Missing claims block, never default. */
    claims: jsonb("claims").$type<Record<string, boolean | number | string | null>>().notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_live_attestations_kind_idx").on(t.kind, t.confirmedAt)]
);

/** Append-only risk policy values. Every change is a new row, attributable. */
export const shadowLiveRiskPolicies = pgTable(
  "shadow_live_risk_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Monotonic insertion order, so two writes in the same millisecond still
     * have an unambiguous "latest". Timestamps alone are not enough. */
    seq: bigserial("seq", { mode: "number" }).notNull(),
    policyKey: text("policy_key").notNull(),
    value: numeric("value", { precision: 24, scale: 6 }).notNull(),
    /** Only ADMIN_APPROVED exists; there is no machine-chosen provenance. */
    provenance: text("provenance").notNull().default("ADMIN_APPROVED"),
    /** Chosen by the approver. Null means the approver stated no expiry. */
    validForDays: integer("valid_for_days"),
    setBy: text("set_by").notNull(),
    setAt: ts("set_at").notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_live_risk_policy_idx").on(t.policyKey, t.setAt)]
);

/** Append-only audit trail of readiness reviews. */
export const shadowLiveReadinessReviews = pgTable(
  "shadow_live_readiness_reviews",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reviewedBy: text("reviewed_by").notNull(),
    reviewedAt: ts("reviewed_at").notNull(),
    gateState: text("gate_state").notNull(),
    effectiveState: text("effective_state").notNull(),
    passedCount: integer("passed_count").notNull().default(0),
    blockedCount: integer("blocked_count").notNull().default(0),
    blockers: jsonb("blockers").$type<Array<Record<string, string>>>().default([]).notNull(),
    note: text("note"),
    createdAt: ts("created_at").notNull().defaultNow()
  },
  (t) => [index("shadow_live_reviews_time_idx").on(t.reviewedAt)]
);
