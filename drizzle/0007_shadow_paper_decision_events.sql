-- v4.9.1 — exact decision reasons, change-only detailed events and compact
-- per-cycle summaries for paper execution.
--
-- Additive only: two new tables plus new nullable columns on the existing
-- ledger. No drops, no type changes, and every existing row is preserved.

ALTER TABLE "shadow_paper_ledger" ADD COLUMN IF NOT EXISTS "event_type" text;
ALTER TABLE "shadow_paper_ledger"
  ADD COLUMN IF NOT EXISTS "reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;

CREATE TABLE IF NOT EXISTS "shadow_paper_candidate_state" (
  "id" text PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL,
  "lifecycle_id" text NOT NULL,
  "route_key" text NOT NULL,
  "buy_source_id" text NOT NULL,
  "sell_source_id" text NOT NULL,
  "size_usdt" numeric(12, 4) NOT NULL,
  "decision_key" text NOT NULL,
  "outcome" text NOT NULL,
  "primary_reason" text,
  "reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "occurrences" integer DEFAULT 1 NOT NULL,
  "first_seen_at" timestamp with time zone NOT NULL,
  "last_seen_at" timestamp with time zone NOT NULL,
  "last_changed_at" timestamp with time zone NOT NULL,
  "closed_at" timestamp with time zone
);
CREATE INDEX IF NOT EXISTS "shadow_paper_state_session_idx"
  ON "shadow_paper_candidate_state" ("session_id", "last_seen_at");
CREATE INDEX IF NOT EXISTS "shadow_paper_state_reason_idx"
  ON "shadow_paper_candidate_state" ("session_id", "primary_reason");

CREATE TABLE IF NOT EXISTS "shadow_paper_cycle_summaries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "run_id" uuid,
  "occurred_at" timestamp with time zone NOT NULL,
  "candidates_evaluated" integer DEFAULT 0 NOT NULL,
  "filled" integer DEFAULT 0 NOT NULL,
  "skipped" integer DEFAULT 0 NOT NULL,
  "detailed_events_written" integer DEFAULT 0 NOT NULL,
  "reason_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_paper_cycle_summary_idx"
  ON "shadow_paper_cycle_summaries" ("session_id", "occurred_at");
