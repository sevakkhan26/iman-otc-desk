-- Additive lifecycle decision evidence for full funnel telemetry.
-- Identical schema intent for local PGlite and server Postgres.
-- Retention: append-only; prune by occurred_at older than ops policy (default keep 30d).
-- Does NOT backfill historical rows; TASK-008 samples remain as originally persisted.

CREATE TABLE IF NOT EXISTS shadow_paper_lifecycle_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid,
  run_id uuid,
  ledger_id uuid,
  lifecycle_id text NOT NULL,
  route_key text NOT NULL,
  buy_source_id text NOT NULL,
  sell_source_id text NOT NULL,
  occurred_at timestamptz NOT NULL,
  outcome text NOT NULL,
  -- Exact terminal reason for non-fills; NULL only when outcome=FILLED.
  terminal_reason text,
  reason_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Full LifecycleDecisionEvidence (paper_lifecycle_evidence_v1).
  evidence jsonb NOT NULL,
  -- Funnel stage array denormalized for SQL attrition queries.
  stages jsonb NOT NULL DEFAULT '[]'::jsonb,
  release_version text,
  policy_fingerprint text,
  fixture_label text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_paper_lifecycle_evidence_life_idx
  ON shadow_paper_lifecycle_evidence (lifecycle_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS shadow_paper_lifecycle_evidence_session_idx
  ON shadow_paper_lifecycle_evidence (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS shadow_paper_lifecycle_evidence_terminal_idx
  ON shadow_paper_lifecycle_evidence (terminal_reason, occurred_at DESC);

CREATE INDEX IF NOT EXISTS shadow_paper_lifecycle_evidence_outcome_idx
  ON shadow_paper_lifecycle_evidence (outcome, occurred_at DESC);

-- Comment: retention — operators may DELETE WHERE occurred_at < now() - interval '30 days'
-- after exporting forensic artifacts. Never UPDATE evidence jsonb (append-only).
