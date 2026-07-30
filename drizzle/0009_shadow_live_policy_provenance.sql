-- Phase 7A.1 — policy provenance and admin-chosen expiry.
-- Additive only: two new nullable/defaulted columns on an existing table.
-- No drops, no type changes, no inserts. Existing rows are preserved and keep
-- their meaning: they were all admin-approved with no stated expiry.

ALTER TABLE "shadow_live_risk_policies"
  ADD COLUMN IF NOT EXISTS "provenance" text DEFAULT 'ADMIN_APPROVED' NOT NULL;
ALTER TABLE "shadow_live_risk_policies"
  ADD COLUMN IF NOT EXISTS "valid_for_days" integer;
