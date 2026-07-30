-- Phase 4 — admin-confirmed exchange fee tiers with append-only audit history.
-- Additive only: one new table, no drops and no changes to existing tables.
-- No credentials are stored here; this records fee evidence only.

CREATE TABLE IF NOT EXISTS "shadow_fee_confirmations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "source_id" text NOT NULL,
  "taker_fee_bps" integer NOT NULL,
  "fee_tier" text,
  "source_url" text,
  "confirmed_by" text NOT NULL,
  "confirmed_at" timestamp with time zone NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_fee_conf_source_time_idx"
  ON "shadow_fee_confirmations" ("source_id", "confirmed_at");
