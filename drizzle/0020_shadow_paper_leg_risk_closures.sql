-- Paper-only LEG_RISK exposure closures (audited). Never deletes ledger rows,
-- never invents fills/hedges, never mutates balances. Resume checks this table.
CREATE TABLE IF NOT EXISTS "shadow_paper_leg_risk_closures" (
  "id" uuid PRIMARY KEY NOT NULL,
  "session_id" uuid NOT NULL,
  "ledger_id" uuid NOT NULL,
  "lifecycle_id" text NOT NULL,
  "rejection_code" text,
  "closed_by" text NOT NULL,
  "closed_at" timestamp with time zone NOT NULL,
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "shadow_paper_leg_risk_closures_ledger_uidx"
  ON "shadow_paper_leg_risk_closures" ("ledger_id");
CREATE INDEX IF NOT EXISTS "shadow_paper_leg_risk_closures_session_idx"
  ON "shadow_paper_leg_risk_closures" ("session_id", "closed_at");
