-- Release 4.1.6.0 — the marker that makes the startup reconciliation run once.
--
-- Additive only: CREATE TABLE IF NOT EXISTS. No ALTER, DROP, DELETE or
-- TRUNCATE, and nothing existing is rewritten.
--
-- Why a table and not a flag in code. Git carries files, not rows: the approved
-- account, fee and capital state lived only in a local database, so deploying
-- the code left production showing the old figures. The reconciliation
-- therefore has to run from the application at startup — and something durable
-- has to remember that it already did, or every container restart would create
-- another capital plan and another paper session.
--
-- The primary key IS the guard. Two containers starting at once both try to
-- insert the same release key; exactly one wins and the other's
-- ON CONFLICT DO NOTHING makes it a no-op. That is a database constraint doing
-- the work, not a check-then-write race in application code.

CREATE TABLE IF NOT EXISTS shadow_release_bootstrap (
  -- Stable per release, e.g. 'release-4.1.6.0-admin-evidence-10b'.
  release_key text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now(),
  -- What the run actually wrote, for audit: counts and the ids it created.
  detail jsonb
);
