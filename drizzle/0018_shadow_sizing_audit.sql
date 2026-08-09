-- Complete final sizing audit on every paper fill (restart-stable explanation).
-- Purely additive: nullable jsonb, no default rewrite of existing rows.

ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS sizing_audit jsonb;
