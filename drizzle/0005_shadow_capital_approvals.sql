-- Phase 5 — explicit admin confirmation of a simulated capital plan.
-- Additive only: one new table, no drops and no changes to existing tables.
-- Records a decision about a simulation. No credentials, orders or transfers.

CREATE TABLE IF NOT EXISTS "shadow_capital_approvals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "plan_id" uuid,
  "plan_fingerprint" text NOT NULL,
  "readiness_fingerprint" text NOT NULL,
  "approved_by" text NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "shadow_capital_approvals_time_idx"
  ON "shadow_capital_approvals" ("approved_at");
