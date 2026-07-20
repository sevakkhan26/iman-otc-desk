-- OTC desk canonical PostgreSQL schema (UTC timestamps, numeric money)
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "username" text NOT NULL,
  "username_key" text NOT NULL,
  "password_hash" text NOT NULL,
  "role" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "credential_version" integer DEFAULT 0 NOT NULL,
  "source" text DEFAULT 'managed' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone,
  "last_login_at" timestamp with time zone,
  "updated_by" text,
  "metadata" jsonb DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS "users_username_key_uidx" ON "users" ("username_key");

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE cascade,
  "token_hash" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "revoked_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_token_hash_uidx" ON "auth_sessions" ("token_hash");
CREATE INDEX IF NOT EXISTS "auth_sessions_user_idx" ON "auth_sessions" ("user_id");

CREATE TABLE IF NOT EXISTS "app_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" jsonb NOT NULL,
  "updated_by" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "api_clients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);

CREATE TABLE IF NOT EXISTS "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "client_id" uuid REFERENCES "api_clients"("id") ON DELETE set null,
  "name" text NOT NULL,
  "key_prefix" text NOT NULL,
  "key_suffix" text NOT NULL,
  "key_hash" text NOT NULL,
  "expires_at" timestamp with time zone,
  "revoked_at" timestamp with time zone,
  "last_used_at" timestamp with time zone,
  "created_by" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "api_keys_key_hash_uidx" ON "api_keys" ("key_hash");
CREATE INDEX IF NOT EXISTS "api_keys_prefix_idx" ON "api_keys" ("key_prefix");

CREATE TABLE IF NOT EXISTS "api_key_scopes" (
  "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE cascade,
  "scope" text NOT NULL,
  PRIMARY KEY ("api_key_id", "scope")
);

CREATE TABLE IF NOT EXISTS "api_rate_limit_buckets" (
  "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id") ON DELETE cascade,
  "bucket_start_ms" bigint NOT NULL,
  "request_count" integer DEFAULT 0 NOT NULL,
  PRIMARY KEY ("api_key_id", "bucket_start_ms")
);

CREATE TABLE IF NOT EXISTS "market_sources" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "display_name" text NOT NULL,
  "market_type" text NOT NULL,
  "is_enabled" boolean DEFAULT true NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS "market_sources_code_uidx" ON "market_sources" ("code");

CREATE TABLE IF NOT EXISTS "market_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "market_type" text NOT NULL,
  "generated_at" timestamp with time zone NOT NULL,
  "server_time" timestamp with time zone NOT NULL,
  "is_stale" boolean DEFAULT false NOT NULL,
  "summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "settings_key" text,
  "refresh_interval_ms" integer,
  "last_successful_refresh_at" timestamp with time zone,
  "last_attempted_refresh_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "market_snapshots_type_hash_uidx" ON "market_snapshots" ("market_type", "content_hash");
CREATE INDEX IF NOT EXISTS "market_snapshots_type_generated_idx" ON "market_snapshots" ("market_type", "generated_at");

CREATE TABLE IF NOT EXISTS "market_quotes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "snapshot_id" uuid NOT NULL REFERENCES "market_snapshots"("id") ON DELETE cascade,
  "source_code" text NOT NULL,
  "source_name" text,
  "instrument" text NOT NULL,
  "currency_unit" text,
  "buy_price" numeric(24, 8),
  "sell_price" numeric(24, 8),
  "mid_price" numeric(24, 8),
  "user_buy_price" numeric(24, 8),
  "user_sell_price" numeric(24, 8),
  "source_updated_at" timestamp with time zone,
  "source_status" text DEFAULT 'available' NOT NULL,
  "sanitized_error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "market_quotes_snapshot_idx" ON "market_quotes" ("snapshot_id");
CREATE INDEX IF NOT EXISTS "market_quotes_source_idx" ON "market_quotes" ("source_code");

CREATE TABLE IF NOT EXISTS "source_health" (
  "source_code" text NOT NULL,
  "market_type" text NOT NULL,
  "status" text NOT NULL,
  "last_attempt_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "latency_ms" integer,
  "consecutive_failures" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "endpoint" text,
  "buy_price" numeric(24, 8),
  "sell_price" numeric(24, 8),
  "mid_price" numeric(24, 8),
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("source_code", "market_type")
);

CREATE TABLE IF NOT EXISTS "ingestion_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "market_type" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "completed_at" timestamp with time zone,
  "status" text NOT NULL,
  "sources_attempted" integer DEFAULT 0,
  "sources_succeeded" integer DEFAULT 0,
  "sanitized_error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS "ingestion_runs_type_started_idx" ON "ingestion_runs" ("market_type", "started_at");

CREATE TABLE IF NOT EXISTS "price_alerts" (
  "id" text PRIMARY KEY NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "price_alerts_created_idx" ON "price_alerts" ("created_at");

CREATE TABLE IF NOT EXISTS "alert_notifications" (
  "id" text PRIMARY KEY NOT NULL,
  "alert_id" text,
  "payload" jsonb NOT NULL,
  "triggered_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "alert_notifications_alert_idx" ON "alert_notifications" ("alert_id");

CREATE TABLE IF NOT EXISTS "median_history_samples" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "sampled_at_ms" bigint NOT NULL,
  "median_value" numeric(24, 8) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "median_history_sampled_uidx" ON "median_history_samples" ("sampled_at_ms");

CREATE TABLE IF NOT EXISTS "news_items" (
  "id" text PRIMARY KEY NOT NULL,
  "payload" jsonb NOT NULL,
  "published_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "news_items_published_idx" ON "news_items" ("published_at");

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "actor_user_id" uuid REFERENCES "users"("id") ON DELETE set null,
  "actor_api_key_id" uuid REFERENCES "api_keys"("id") ON DELETE set null,
  "action" text NOT NULL,
  "entity_type" text NOT NULL,
  "entity_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "audit_logs_created_idx" ON "audit_logs" ("created_at");

CREATE TABLE IF NOT EXISTS "schema_meta" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

INSERT INTO "schema_meta" ("key", "value") VALUES ('migration_version', '0000_init')
ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value", "updated_at" = now();
