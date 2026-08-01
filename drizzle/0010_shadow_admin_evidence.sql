-- Phase 8B follow-up — admin-confirmed account and fee evidence.
--
-- Purely additive: new nullable columns and one new append-only table. No DROP,
-- no DELETE, no rename, no destructive ALTER, and nothing is activated by
-- applying this file — every row is written by an explicit admin action.
--
-- Why the new columns exist:
--   * maker_fee_bps       the desk's maker rate, kept as REFERENCE ONLY until a
--                         maker-order simulation exists; it never reaches the
--                         paper engine, which settles takers.
--   * provenance          how the number was evidenced. Legacy rows are NULL and
--                         keep reading as ADMIN_CONFIRMED.
--   * valid_days          per-confirmation validity, so a screenshot can expire
--                         sooner than the global re-verification window.
--   * reference_metadata  quoted-market and easy-trade rates that must never be
--                         applied to a USDT/IRT calculation.
--   * evidence_key        idempotency handle: the same evidence imported twice
--                         is the same row, never a duplicate.

ALTER TABLE shadow_fee_confirmations ADD COLUMN IF NOT EXISTS maker_fee_bps integer;
ALTER TABLE shadow_fee_confirmations ADD COLUMN IF NOT EXISTS provenance text;
ALTER TABLE shadow_fee_confirmations ADD COLUMN IF NOT EXISTS valid_days integer;
ALTER TABLE shadow_fee_confirmations ADD COLUMN IF NOT EXISTS reference_metadata jsonb;
ALTER TABLE shadow_fee_confirmations ADD COLUMN IF NOT EXISTS evidence_key text;

-- One row per (venue, evidence). Re-running an import is a no-op, not a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS shadow_fee_conf_evidence_key_idx
  ON shadow_fee_confirmations (source_id, evidence_key)
  WHERE evidence_key IS NOT NULL;

-- Append-only account / KYC evidence.
--
-- Account state used to be compiled-in configuration. An admin confirmation is
-- real evidence about this desk's accounts, so it belongs in the database with
-- the same append-only, expiring, provenance-carrying shape as fee evidence.
-- Execution eligibility is stored separately from KYC on purpose: a venue can be
-- fully KYC-verified and still never be allowed to execute.
CREATE TABLE IF NOT EXISTS shadow_account_confirmations (
  id uuid PRIMARY KEY,
  source_id text NOT NULL,
  kyc_complete boolean NOT NULL,
  account_state text NOT NULL,
  execution_eligible boolean NOT NULL,
  ineligible_reason text,
  provenance text NOT NULL,
  valid_days integer,
  evidence_key text,
  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_account_conf_source_time_idx
  ON shadow_account_confirmations (source_id, confirmed_at);

CREATE UNIQUE INDEX IF NOT EXISTS shadow_account_conf_evidence_key_idx
  ON shadow_account_confirmations (source_id, evidence_key)
  WHERE evidence_key IS NOT NULL;
