-- Phase 8E-B — give the append-only fee-tier evidence a real append order.
--
-- Additive only: ADD COLUMN IF NOT EXISTS. No ALTER of existing columns, no
-- DROP, DELETE or TRUNCATE, and no row is rewritten by the application.
--
-- Why this exists. Effective-fee selection takes the NEWEST confirmation for a
-- venue and mode. Ordering by `confirmed_at` alone is ambiguous, because a bulk
-- import deliberately stamps one instant across every venue; the earlier fix
-- broke that tie with `created_at`. But `created_at` is a wall clock read back
-- at millisecond resolution, so two rows appended inside the same millisecond
-- tie AGAIN, and the ordering then fell through to comparing random UUIDs —
-- which means the effective fee could differ between two reads of the same
-- data. A fee that depends on row order is not evidence.
--
-- `seq` is the only monotonic fact about an append-only table: the order the
-- rows were actually appended in. It settles every tie, permanently.

ALTER TABLE shadow_fee_tier_evidence
  ADD COLUMN IF NOT EXISTS seq bigserial;

-- Newest-first lookups scan by (venue, mode) and then take the last append.
CREATE INDEX IF NOT EXISTS shadow_fee_tier_evidence_seq_idx
  ON shadow_fee_tier_evidence (source_id, execution_mode, seq DESC);
