-- Phase 5 — virtual capital allocation plans for the Shadow simulator.
-- Additive only: one new table, no drops and no changes to existing tables.
-- Stores simulated balances only. No credentials, orders or transfers.

CREATE TABLE IF NOT EXISTS "shadow_capital_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "mode" text NOT NULL,
  "total_capital_toman" bigint NOT NULL,
  "valuation_price_toman" integer NOT NULL,
  "reserve_percent" integer DEFAULT 0 NOT NULL,
  "allocations" jsonb NOT NULL,
  "created_by" text NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_capital_plans_created_idx"
  ON "shadow_capital_plans" ("created_at");
