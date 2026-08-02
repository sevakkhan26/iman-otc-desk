-- Phase 8E-B — append-only fee-tier and execution-mode evidence.
--
-- Additive only: CREATE TABLE IF NOT EXISTS, no ALTER, DROP, DELETE or
-- TRUNCATE. The application never issues UPDATE or DELETE against this table —
-- a correction is a NEW row, so "what did we believe, and when" stays
-- answerable rather than being overwritten.
--
-- Why mode is part of the key. A venue can quote different fees for its order
-- book, its Easy Trade widget and its Convert flow. Storing one fee per venue
-- would let a rate evidenced for one mode silently price a trade in another —
-- which is exactly how a 0/0 order-book fee could end up making a Convert trade
-- look free. Mode is therefore part of the identity of the evidence, not a note
-- attached to it.

CREATE TABLE IF NOT EXISTS shadow_fee_tier_evidence (
  -- Supplied by the application: the migration runner strips
  -- `DEFAULT gen_random_uuid()` on PGlite.
  id uuid PRIMARY KEY,

  source_id text NOT NULL,

  -- ORDER_BOOK | EASY_TRADE | CONVERT | OTC_QUOTE
  execution_mode text NOT NULL,

  -- The venue's own tier label. NULL when the evidence names none — never a
  -- guessed "Base", because an invented tier would match a real fee row and
  -- quietly authorise it.
  tier_label text,

  maker_fee_bps integer,
  taker_fee_bps integer,

  provenance text NOT NULL,
  -- Idempotency: one confirmation of the same fact writes one row.
  evidence_key text NOT NULL,

  confirmed_by text NOT NULL,
  confirmed_at timestamptz NOT NULL,
  valid_for_days integer,
  expires_at timestamptz,

  -- NULL when the evidence carried no link. Never fabricated.
  source_url text,
  note text,

  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per (venue, mode, evidence key). A re-import of the same confirmation
-- is a no-op; a genuinely new confirmation carries a new key and appends.
CREATE UNIQUE INDEX IF NOT EXISTS shadow_fee_tier_evidence_key_idx
  ON shadow_fee_tier_evidence (source_id, execution_mode, evidence_key);

CREATE INDEX IF NOT EXISTS shadow_fee_tier_evidence_lookup_idx
  ON shadow_fee_tier_evidence (source_id, execution_mode, confirmed_at DESC);
