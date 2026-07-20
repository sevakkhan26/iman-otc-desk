/**
 * Canonical PostgreSQL schema for OTC desk durable state.
 * All timestamps are UTC. Financial amounts use numeric (no float).
 */
import {
  bigint,
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
