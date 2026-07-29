-- Shadow Arbitrage Phase 2 — additive only (no drops, no destructive rewrites).
-- Adds: health-event log, lifecycle transition log, compact route aggregates,
-- observation pause accounting, per-source response metadata, worker lease.
-- OMPFinex is intentionally not part of this schema.

/* ── observation sessions: honest progress across pauses ───────────────── */
ALTER TABLE "shadow_observation_sessions"
  ADD COLUMN IF NOT EXISTS "paused_at" timestamp with time zone;
ALTER TABLE "shadow_observation_sessions"
  ADD COLUMN IF NOT EXISTS "paused_total_ms" bigint NOT NULL DEFAULT 0;

/* ── collection runs: coverage math per cycle ──────────────────────────── */
ALTER TABLE "shadow_collection_runs"
  ADD COLUMN IF NOT EXISTS "sources_total" integer NOT NULL DEFAULT 0;
ALTER TABLE "shadow_collection_runs"
  ADD COLUMN IF NOT EXISTS "coverage_percent" numeric(6, 2);
ALTER TABLE "shadow_collection_runs"
  ADD COLUMN IF NOT EXISTS "poll_interval_ms" integer;

/* ── source snapshots: response metadata for certification + analytics ─── */
ALTER TABLE "shadow_source_snapshots"
  ADD COLUMN IF NOT EXISTS "http_status" integer;
ALTER TABLE "shadow_source_snapshots"
  ADD COLUMN IF NOT EXISTS "depth_available" boolean;
ALTER TABLE "shadow_source_snapshots"
  ADD COLUMN IF NOT EXISTS "max_executable_usdt" numeric(18, 4);
ALTER TABLE "shadow_source_snapshots"
  ADD COLUMN IF NOT EXISTS "fee_status" text;
ALTER TABLE "shadow_source_snapshots"
  ADD COLUMN IF NOT EXISTS "stale" boolean NOT NULL DEFAULT false;

/* ── opportunity lifecycles: raw-vs-net integrity fields ───────────────── */
ALTER TABLE "shadow_opportunity_lifecycles"
  ADD COLUMN IF NOT EXISTS "max_raw_spread_percent" numeric(18, 8);
ALTER TABLE "shadow_opportunity_lifecycles"
  ADD COLUMN IF NOT EXISTS "fee_unknown" boolean NOT NULL DEFAULT false;
ALTER TABLE "shadow_opportunity_lifecycles"
  ADD COLUMN IF NOT EXISTS "observation_count" integer NOT NULL DEFAULT 1;

/* ── worker heartbeat: cooperative lease for duplicate-worker prevention ─ */
ALTER TABLE "shadow_worker_heartbeat"
  ADD COLUMN IF NOT EXISTS "lease_expires_at" timestamp with time zone;

/* ── source health events (transitions only, not per cycle) ────────────── */
CREATE TABLE IF NOT EXISTS "shadow_source_health_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" text NOT NULL,
  "run_id" uuid,
  "occurred_at" timestamp with time zone NOT NULL,
  "from_health" text,
  "to_health" text NOT NULL,
  "from_cert_status" text,
  "to_cert_status" text,
  "reason" text,
  "http_status" integer,
  "latency_ms" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_health_evt_source_time_idx"
  ON "shadow_source_health_events" ("source_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "shadow_health_evt_time_idx"
  ON "shadow_source_health_events" ("occurred_at");

/* ── opportunity lifecycle transitions ─────────────────────────────────── */
CREATE TABLE IF NOT EXISTS "shadow_opportunity_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "lifecycle_id" text NOT NULL,
  "route_key" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "event_type" text NOT NULL,
  "from_eligibility" text,
  "to_eligibility" text,
  "net_edge_percent" numeric(18, 8),
  "net_profit_toman" numeric(24, 0),
  "raw_spread_percent" numeric(18, 8),
  "blocked_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_opp_evt_lifecycle_idx"
  ON "shadow_opportunity_events" ("lifecycle_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "shadow_opp_evt_time_idx"
  ON "shadow_opportunity_events" ("occurred_at");
CREATE INDEX IF NOT EXISTS "shadow_opp_evt_route_idx"
  ON "shadow_opportunity_events" ("route_key");

/* ── compact per-route/per-day aggregates ──────────────────────────────── */
CREATE TABLE IF NOT EXISTS "shadow_route_metrics" (
  "id" text PRIMARY KEY NOT NULL,
  "route_key" text NOT NULL,
  "buy_source_id" text NOT NULL,
  "sell_source_id" text NOT NULL,
  "size_usdt" numeric(12, 4) NOT NULL,
  "bucket_date" text NOT NULL,
  "samples" integer NOT NULL DEFAULT 0,
  "positive_raw_samples" integer NOT NULL DEFAULT 0,
  "positive_net_samples" integer NOT NULL DEFAULT 0,
  "sum_raw_spread_percent" numeric(24, 8) NOT NULL DEFAULT '0',
  "max_raw_spread_percent" numeric(18, 8),
  "sum_net_edge_percent" numeric(24, 8) NOT NULL DEFAULT '0',
  "max_net_edge_percent" numeric(18, 8),
  "max_net_profit_toman" numeric(24, 0),
  "fee_unknown" boolean NOT NULL DEFAULT false,
  "blocked_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_route_metrics_route_idx"
  ON "shadow_route_metrics" ("route_key");
CREATE INDEX IF NOT EXISTS "shadow_route_metrics_bucket_idx"
  ON "shadow_route_metrics" ("bucket_date");

/* ── retention support: time indexes used by cleanup ───────────────────── */
CREATE INDEX IF NOT EXISTS "shadow_src_snap_received_idx"
  ON "shadow_source_snapshots" ("received_at");
