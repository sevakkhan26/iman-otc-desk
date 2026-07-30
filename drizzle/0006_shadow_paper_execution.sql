-- Phase 6 — paper execution. Simulated trading only.
-- Additive only: three new tables, no drops and no changes to existing tables.
-- No credentials, no real orders, no deposits, withdrawals or transfers.

CREATE TABLE IF NOT EXISTS "shadow_paper_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "observation_id" uuid,
  "name" text NOT NULL,
  "mode" text NOT NULL,
  "status" text DEFAULT 'NOT_STARTED' NOT NULL,
  "total_capital_toman" bigint NOT NULL,
  "valuation_price_toman" integer NOT NULL,
  "opening_allocations" jsonb NOT NULL,
  "approval_fingerprint" text,
  "created_by" text NOT NULL,
  "started_at" timestamp with time zone,
  "paused_at" timestamp with time zone,
  "stopped_at" timestamp with time zone,
  "last_cycle_at" timestamp with time zone,
  "cycles_evaluated" integer DEFAULT 0 NOT NULL,
  "trades_executed" integer DEFAULT 0 NOT NULL,
  "candidates_skipped" integer DEFAULT 0 NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_paper_sessions_status_idx"
  ON "shadow_paper_sessions" ("status", "created_at");

CREATE TABLE IF NOT EXISTS "shadow_paper_balances" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL,
  "source_id" text NOT NULL,
  "irt_toman" bigint DEFAULT 0 NOT NULL,
  "usdt_micros" bigint DEFAULT 0 NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_paper_balances_session_idx"
  ON "shadow_paper_balances" ("session_id");

CREATE TABLE IF NOT EXISTS "shadow_paper_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "run_id" uuid,
  "idempotency_key" text,
  "lifecycle_id" text NOT NULL,
  "route_key" text NOT NULL,
  "outcome" text NOT NULL,
  "rejection_code" text,
  "rejection_reason" text,
  "required_rebalance" text,
  "buy_source_id" text NOT NULL,
  "sell_source_id" text NOT NULL,
  "size_usdt" numeric(12, 4) NOT NULL,
  "buy_vwap_toman" bigint,
  "sell_vwap_toman" bigint,
  "buy_notional_toman" bigint,
  "sell_notional_toman" bigint,
  "buy_fee_bps" integer,
  "sell_fee_bps" integer,
  "buy_fee_asset" text,
  "buy_fee_debit_mode" text,
  "buy_fee_provenance" text,
  "sell_fee_asset" text,
  "sell_fee_debit_mode" text,
  "sell_fee_provenance" text,
  "fee_toman_total" bigint,
  "fee_usdt_micros_total" bigint,
  "slippage_buffer_toman" bigint,
  "gross_spread_toman" bigint,
  "net_pnl_toman" bigint,
  "net_pnl_after_buffer_toman" bigint,
  "usdt_drift_micros" bigint,
  "balances_after" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "shadow_paper_ledger_idem_idx"
  ON "shadow_paper_ledger" ("idempotency_key");
CREATE INDEX IF NOT EXISTS "shadow_paper_ledger_session_time_idx"
  ON "shadow_paper_ledger" ("session_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "shadow_paper_ledger_outcome_idx"
  ON "shadow_paper_ledger" ("session_id", "outcome");
