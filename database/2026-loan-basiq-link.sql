-- ── Link imported loans/mortgages back to their Basiq account ─────────────────
-- Run this in the Supabase SQL editor.
--
-- Basiq returns mortgage/loan-class accounts alongside everyday/savings ones.
-- These must land in the Loans section (a liability), NOT as a bank account
-- (an asset) — otherwise the same debt is double-counted in net worth. This
-- column lets a re-sync find and update the existing loan row instead of
-- inserting a duplicate, mirroring bank_accounts.basiq_account_id.

ALTER TABLE loans ADD COLUMN IF NOT EXISTS basiq_account_id TEXT;

CREATE INDEX IF NOT EXISTS idx_loans_basiq
  ON loans(basiq_account_id) WHERE basiq_account_id IS NOT NULL;
