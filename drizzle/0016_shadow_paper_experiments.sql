-- Release 4.1.10.0 — four-day Paper experiment runs with permanent audit linkage.
-- Additive only: new table + nullable columns. No DROP, DELETE, TRUNCATE or rewrite.

CREATE TABLE IF NOT EXISTS shadow_paper_experiments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  -- Stable activation key for idempotent bootstrap (e.g. paper-4d-v1).
  run_key text NOT NULL,
  -- PENDING | ACTIVE | COMPLETED | SUPERSEDED
  status text NOT NULL,
  policy_set_key text NOT NULL,
  policy_fingerprint text NOT NULL,
  release_version text NOT NULL,
  -- Frozen once at first successful activation. Restarts never move ends_at.
  started_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  completed_at timestamptz,
  session_id uuid,
  initial_capital_toman bigint NOT NULL,
  target_utilization_percent numeric(8, 4) NOT NULL DEFAULT 70,
  max_utilization_percent numeric(8, 4) NOT NULL DEFAULT 80,
  min_reserve_percent numeric(8, 4) NOT NULL DEFAULT 20,
  max_route_capital_percent numeric(8, 4) NOT NULL DEFAULT 10,
  max_venue_exposure_percent numeric(8, 4) NOT NULL DEFAULT 20,
  -- Capital-relative hard USDT cap frozen at start (derived, not a silent 500).
  derived_max_order_usdt numeric(18, 4),
  derived_max_order_reference_price integer,
  derived_max_order_at timestamptz,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Frozen when COMPLETED.
  summary jsonb,
  peak_utilization_percent numeric(8, 4),
  -- Running sum for average: { sum: number, n: number }
  utilization_stats jsonb NOT NULL DEFAULT '{"sum":0,"n":0}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shadow_paper_experiments_run_key_uidx
  ON shadow_paper_experiments (run_key);

CREATE INDEX IF NOT EXISTS shadow_paper_experiments_status_idx
  ON shadow_paper_experiments (status, started_at);

-- At most one ACTIVE experiment at a time (partial unique index).
CREATE UNIQUE INDEX IF NOT EXISTS shadow_paper_experiments_one_active_uidx
  ON shadow_paper_experiments (status)
  WHERE status = 'ACTIVE';

ALTER TABLE shadow_paper_sessions
  ADD COLUMN IF NOT EXISTS experiment_run_id uuid;

ALTER TABLE shadow_paper_ledger
  ADD COLUMN IF NOT EXISTS experiment_run_id uuid;

CREATE INDEX IF NOT EXISTS shadow_paper_ledger_experiment_idx
  ON shadow_paper_ledger (experiment_run_id, occurred_at);

CREATE INDEX IF NOT EXISTS shadow_paper_sessions_experiment_idx
  ON shadow_paper_sessions (experiment_run_id);
