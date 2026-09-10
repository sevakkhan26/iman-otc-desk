-- Step 2/3: typed identity links on paper ledger + session-scoped residual liquidity ledger.
-- Additive only. Does NOT backfill historical fills. Old evidence preserved.

-- ── Fill / skip identity + durable trace links (nullable for pre-fix rows) ──
ALTER TABLE shadow_paper_ledger
  ADD COLUMN IF NOT EXISTS decision_trace_id uuid,
  ADD COLUMN IF NOT EXISTS experiment_id uuid,
  ADD COLUMN IF NOT EXISTS deployment_version text,
  ADD COLUMN IF NOT EXISTS collector_run_id uuid,
  ADD COLUMN IF NOT EXISTS observation_id uuid,
  ADD COLUMN IF NOT EXISTS detection_snapshot_ref jsonb,
  ADD COLUMN IF NOT EXISTS arrival_snapshot_ref jsonb,
  ADD COLUMN IF NOT EXISTS allocator_decision_ref jsonb,
  ADD COLUMN IF NOT EXISTS liquidity_consumption_evidence jsonb;

CREATE INDEX IF NOT EXISTS shadow_paper_ledger_decision_trace_idx
  ON shadow_paper_ledger (decision_trace_id);
CREATE INDEX IF NOT EXISTS shadow_paper_ledger_experiment_idx
  ON shadow_paper_ledger (experiment_id);

-- Decision traces: typed identity columns (run_id already exists as collector run).
ALTER TABLE shadow_paper_decision_traces
  ADD COLUMN IF NOT EXISTS experiment_id uuid,
  ADD COLUMN IF NOT EXISTS observation_id uuid,
  ADD COLUMN IF NOT EXISTS deployment_version text,
  ADD COLUMN IF NOT EXISTS paper_session_id uuid;

UPDATE shadow_paper_decision_traces
SET paper_session_id = session_id
WHERE paper_session_id IS NULL AND session_id IS NOT NULL;

-- ── Session-scoped simulated residual liquidity ──────────────────────────────
-- Key: paperSessionId + venue + symbol + side + deterministic price-level identity.
-- A new snapshot generation alone MUST NOT reset outstanding consumption.
CREATE TABLE IF NOT EXISTS shadow_paper_residual_liquidity (
  id uuid PRIMARY KEY NOT NULL,
  paper_session_id uuid NOT NULL,
  venue_id text NOT NULL,
  symbol text NOT NULL DEFAULT 'USDTIRT',
  side text NOT NULL,
  price_level_key text NOT NULL,
  price_toman bigint NOT NULL,
  outstanding_consumed_micros bigint NOT NULL DEFAULT 0,
  lifetime_consumed_micros bigint NOT NULL DEFAULT 0,
  lifetime_released_micros bigint NOT NULL DEFAULT 0,
  last_raw_displayed_micros bigint,
  absent_consecutive_snapshots integer NOT NULL DEFAULT 0,
  last_seen_snapshot_generation text,
  last_seen_book_hash text,
  state text NOT NULL DEFAULT 'ACTIVE',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shadow_paper_residual_liq_level_uidx
  ON shadow_paper_residual_liquidity (paper_session_id, venue_id, symbol, side, price_level_key);

CREATE INDEX IF NOT EXISTS shadow_paper_residual_liq_session_idx
  ON shadow_paper_residual_liquidity (paper_session_id, state);

-- Append-only consumption / release events (exact reasons; idempotent retries).
CREATE TABLE IF NOT EXISTS shadow_paper_residual_liquidity_events (
  id uuid PRIMARY KEY NOT NULL,
  paper_session_id uuid NOT NULL,
  residual_id uuid,
  venue_id text NOT NULL,
  symbol text NOT NULL DEFAULT 'USDTIRT',
  side text NOT NULL,
  price_level_key text NOT NULL,
  price_toman bigint NOT NULL,
  event_kind text NOT NULL,
  delta_micros bigint NOT NULL,
  outstanding_after_micros bigint NOT NULL,
  reason text NOT NULL,
  idempotency_key text NOT NULL,
  fill_ledger_id uuid,
  lifecycle_id text,
  decision_trace_id uuid,
  raw_snapshot_id text,
  arrival_snapshot_id text,
  immutable_generation text,
  immutable_book_hash text,
  raw_displayed_micros bigint,
  prior_outstanding_micros bigint,
  actual_consumed_micros bigint,
  effective_remaining_micros bigint,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shadow_paper_residual_liq_evt_idem_uidx
  ON shadow_paper_residual_liquidity_events (idempotency_key);

CREATE INDEX IF NOT EXISTS shadow_paper_residual_liq_evt_session_idx
  ON shadow_paper_residual_liquidity_events (paper_session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS shadow_paper_residual_liq_evt_lifecycle_idx
  ON shadow_paper_residual_liquidity_events (lifecycle_id, occurred_at DESC);
