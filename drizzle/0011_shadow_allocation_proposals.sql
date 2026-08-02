-- Phase 8C-5 — append-only allocation proposals for the virtual portfolio.
--
-- Additive only. Nothing here alters, drops or rewrites an existing table, and
-- the application never issues UPDATE or DELETE against these two: a proposal's
-- lifecycle is expressed by APPENDING a decision row, so the full history of
-- what was proposed and what was applied is always reconstructible.
--
-- A proposal is a SIMULATION of how virtual money would be split. Applying one
-- writes virtual balances for a paper session. It places no order, moves no
-- funds and touches no exchange.

CREATE TABLE IF NOT EXISTS shadow_allocation_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- What the proposal is for. Conservation is checked against this figure and
  -- stored beside it, so a stored row proves its own arithmetic.
  total_capital_toman bigint NOT NULL,
  valuation_price_toman integer NOT NULL,
  allocated_toman bigint NOT NULL,
  residual_toman bigint NOT NULL,

  -- [{ sourceId, role, irtToman, usdtUnits, valueToman, sharePercent,
  --    buyCapacityUsdtMicros, sellCapacityUsdtMicros, buyLimiter, sellLimiter,
  --    buyReason, sellReason, reasonFa }]
  rows jsonb NOT NULL,

  -- The evidence this proposal was computed from. A later apply re-derives
  -- these and refuses when any of them moved — a proposal is only valid against
  -- the world it was built in.
  books_fingerprint text NOT NULL,
  fees_fingerprint text NOT NULL,
  accounts_fingerprint text NOT NULL,
  policy_fingerprint text NOT NULL,

  -- Which policy caps were applied and which were UNSET at generation time.
  -- UNSET is recorded explicitly; it is never stored as a zero.
  applied_policy_caps jsonb NOT NULL,
  unset_policy_caps jsonb NOT NULL,

  -- Observations the optimizer used, kept so a proposal can be re-explained.
  observations jsonb NOT NULL,

  status text NOT NULL DEFAULT 'PROPOSED',
  created_by text NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS shadow_allocation_proposals_created_idx
  ON shadow_allocation_proposals (created_at DESC);

-- Append-only decision log. Applying a proposal appends one row; the proposal
-- itself is never mutated. The unique index is what makes apply idempotent:
-- a second attempt with the same idempotency key cannot write a second row.
CREATE TABLE IF NOT EXISTS shadow_allocation_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES shadow_allocation_proposals (id),
  session_id uuid,
  decision text NOT NULL,              -- APPLIED | REJECTED_STALE | FAILED
  idempotency_key text NOT NULL,
  -- Why an apply was refused, or what it changed when it succeeded.
  detail_fa text NOT NULL,
  balances_before jsonb,
  balances_after jsonb,
  decided_by text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS shadow_allocation_decisions_idem_idx
  ON shadow_allocation_decisions (idempotency_key);

CREATE INDEX IF NOT EXISTS shadow_allocation_decisions_proposal_idx
  ON shadow_allocation_decisions (proposal_id, decided_at DESC);
