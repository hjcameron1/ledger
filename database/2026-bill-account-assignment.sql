-- Phase 3.4: account-assigned Bills & Reminders.
--
-- A bill can be assigned to a bank account or credit card. When it is manually
-- marked paid, the app records a matching transaction on that account and moves
-- its balance; paid_transaction_id links that transaction so an un-pay can reverse
-- it, and a later Basiq/statement import of the same payment reconciles against it
-- (see utils/reconcile.ts) instead of duplicating.
--
-- All additive — existing rows keep working (all three columns null → unassigned,
-- so pay() behaves exactly as before).
ALTER TABLE bills ADD COLUMN IF NOT EXISTS account_id TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS account_type TEXT;   -- 'bank' | 'credit_card'
ALTER TABLE bills ADD COLUMN IF NOT EXISTS paid_transaction_id TEXT;
