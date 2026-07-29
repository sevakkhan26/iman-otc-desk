-- Shadow Arbitrage Phase 2 — dedicated tables (14-day observation)
-- OMPFinex is intentionally not part of this schema.

CREATE TABLE IF NOT EXISTS "shadow_observation_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "status" text NOT NULL DEFAULT 'NOT_STARTED',
  "target_duration_ms" bigint NOT NULL DEFAULT 1209600000,
  "started_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "last_heartbeat_at" timestamp with time zone,
  "last_success_at" timestamp with time zone,
  "completed_cycles" integer NOT NULL DEFAULT 0,
  "successful_cycles" integer NOT NULL DEFAULT 0,
  "failed_cycles" integer NOT NULL DEFAULT 0,
  "partial_cycles" integer NOT NULL DEFAULT 0,
  "poll_interval_ms" integer NOT NULL DEFAULT 30000,
  "worker_id" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "shadow_collection_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid REFERENCES "shadow_observation_sessions"("id") ON DELETE set null,
  "idempotency_key" text NOT NULL,
  "started_at" timestamp with time zone NOT NULL,
  "finished_at" timestamp with time zone,
  "status" text NOT NULL DEFAULT 'running',
  "sources_ok" integer NOT NULL DEFAULT 0,
  "sources_failed" integer NOT NULL DEFAULT 0,
  "opportunity_count" integer NOT NULL DEFAULT 0,
  "duration_ms" integer,
  "error_message" text,
  "worker_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "shadow_runs_idempotency_uidx" ON "shadow_collection_runs" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "shadow_runs_started_idx" ON "shadow_collection_runs" ("started_at");

CREATE TABLE IF NOT EXISTS "shadow_source_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "run_id" uuid NOT NULL REFERENCES "shadow_collection_runs"("id") ON DELETE cascade,
  "source_id" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "source_timestamp" timestamp with time zone,
  "health" text NOT NULL,
  "market_model" text NOT NULL,
  "cert_status" text,
  "user_buy_toman" numeric(24, 0),
  "user_sell_toman" numeric(24, 0),
  "latency_ms" integer,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "error_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_src_snap_source_time_idx" ON "shadow_source_snapshots" ("source_id", "received_at");
CREATE INDEX IF NOT EXISTS "shadow_src_snap_run_idx" ON "shadow_source_snapshots" ("run_id");

CREATE TABLE IF NOT EXISTS "shadow_opportunity_lifecycles" (
  "id" text PRIMARY KEY NOT NULL,
  "route_key" text NOT NULL,
  "buy_source_id" text NOT NULL,
  "sell_source_id" text NOT NULL,
  "size_usdt" numeric(12, 4) NOT NULL,
  "eligibility" text NOT NULL,
  "is_active" boolean NOT NULL DEFAULT true,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "ended_at" timestamp with time zone,
  "buy_vwap_toman" numeric(24, 0) NOT NULL,
  "sell_vwap_toman" numeric(24, 0) NOT NULL,
  "raw_spread_percent" numeric(18, 8) NOT NULL,
  "net_edge_percent" numeric(18, 8) NOT NULL,
  "net_profit_toman" numeric(24, 0) NOT NULL,
  "max_net_edge_percent" numeric(18, 8) NOT NULL,
  "max_net_profit_toman" numeric(24, 0) NOT NULL,
  "blocked_reasons" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "payload" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_opp_route_active_idx" ON "shadow_opportunity_lifecycles" ("route_key", "is_active");
CREATE INDEX IF NOT EXISTS "shadow_opp_last_seen_idx" ON "shadow_opportunity_lifecycles" ("last_seen_at");
CREATE INDEX IF NOT EXISTS "shadow_opp_active_idx" ON "shadow_opportunity_lifecycles" ("is_active");

CREATE TABLE IF NOT EXISTS "shadow_worker_heartbeat" (
  "id" text PRIMARY KEY NOT NULL DEFAULT 'primary',
  "worker_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'idle',
  "last_heartbeat_at" timestamp with time zone NOT NULL,
  "last_cycle_at" timestamp with time zone,
  "last_cycle_status" text,
  "poll_interval_ms" integer NOT NULL DEFAULT 30000,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
