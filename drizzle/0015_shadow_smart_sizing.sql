-- Smart position sizing (SMART_CAPITAL_DEPTH) — decision evidence on every fill.
--
-- Purely additive: every column is nullable and has no default, so existing
-- rows keep the exact values they already hold and every existing query keeps
-- returning what it returned before. Nothing is dropped, renamed or rewritten,
-- and no session, fill, balance, ledger row or history entry is touched.
--
-- These columns answer, months later and without re-running anything, the two
-- questions an auditor actually asks about a filled size: why THIS size, and
-- why not the next one up.

ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS sizing_policy text;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS sizing_reason text;

-- The capital basis the candidate ladder was generated from.
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS limiting_side text;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS limiting_source_id text;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS limiting_usable_usdt_micros bigint;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS capital_cap_usdt_micros bigint;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS depth_cap_usdt_micros bigint;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS binding_constraint text;

-- Profitability of the chosen size, in the unit the risk policies speak in.
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS risk_adjusted_return_bps numeric(12,2);
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS selected_percent_of_usable numeric(6,2);

-- Inventory effect, in percentage points of USDT share. Negative improves.
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS inventory_impact_points numeric(10,4);

-- Why the next larger candidate was not taken.
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS next_larger_size_usdt numeric(12,4);
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS next_larger_rejection_code text;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS next_larger_rejection_reason text;
ALTER TABLE shadow_paper_ledger ADD COLUMN IF NOT EXISTS next_larger_marginal_pnl_toman bigint;
