-- Local-first append-only decision cycle traces (read-only observability).
-- Additive only. Does not rewrite history. Candidate-level detail for cycles
-- before this migration cannot be reconstructed as "originally persisted".

CREATE TABLE IF NOT EXISTS shadow_paper_decision_traces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  session_id uuid NOT NULL,
  -- Collection cycle / run id when known.
  run_id uuid,
  occurred_at timestamptz NOT NULL,
  -- Compact cycle-level counters (always present when a row is written).
  venues_available integer NOT NULL DEFAULT 0,
  routes_evaluated integer NOT NULL DEFAULT 0,
  sizes_evaluated integer NOT NULL DEFAULT 0,
  candidates_evaluated integer NOT NULL DEFAULT 0,
  rejected_count integer NOT NULL DEFAULT 0,
  valid_count integer NOT NULL DEFAULT 0,
  selected_count integer NOT NULL DEFAULT 0,
  filled_count integer NOT NULL DEFAULT 0,
  -- Outcome of the cycle for the operator console.
  outcome text NOT NULL,
  outcome_reason_fa text,
  selected_lifecycle_id text,
  -- Soft reference to market snapshot / cycle, not a full book dump.
  snapshot_ref text,
  release_version text,
  policy_fingerprint text,
  -- Structured candidates for THIS cycle only (jsonb array). May be empty when
  -- trace capture was off or only a cycle summary was available.
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- true only when candidates[] was written from the engine evaluation.
  trace_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_paper_decision_traces_session_time_idx
  ON shadow_paper_decision_traces (session_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS shadow_paper_decision_traces_run_idx
  ON shadow_paper_decision_traces (run_id);
