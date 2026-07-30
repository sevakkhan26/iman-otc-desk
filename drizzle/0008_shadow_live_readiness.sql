-- Phase 7A — guarded live-execution readiness.
-- Additive only: three new tables, no drops and no changes to existing tables.
--
-- These tables hold STATEMENTS about readiness — never an API key, secret,
-- token or any credential. Nothing here can place a real order or move funds.

CREATE TABLE IF NOT EXISTS "shadow_live_attestations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "kind" text NOT NULL,
  "confirmed_by" text NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL,
  "claims" jsonb NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_live_attestations_kind_idx"
  ON "shadow_live_attestations" ("kind", "confirmed_at");

CREATE TABLE IF NOT EXISTS "shadow_live_risk_policies" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Monotonic insertion order: two writes in the same millisecond must still
  -- have an unambiguous "latest".
  "seq" bigserial NOT NULL,
  "policy_key" text NOT NULL,
  "value" numeric(24, 6) NOT NULL,
  "set_by" text NOT NULL,
  "set_at" timestamp with time zone NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_live_risk_policy_idx"
  ON "shadow_live_risk_policies" ("policy_key", "set_at");

CREATE TABLE IF NOT EXISTS "shadow_live_readiness_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "reviewed_by" text NOT NULL,
  "reviewed_at" timestamp with time zone NOT NULL,
  "gate_state" text NOT NULL,
  "effective_state" text NOT NULL,
  "passed_count" integer DEFAULT 0 NOT NULL,
  "blocked_count" integer DEFAULT 0 NOT NULL,
  "blockers" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_live_reviews_time_idx"
  ON "shadow_live_readiness_reviews" ("reviewed_at");
