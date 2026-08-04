-- ── Allow transactions to belong to a loan ────────────────────────────────────
-- Run this in the Supabase SQL editor.
--
-- Imported mortgage/loan accounts move into the Loans section, and their
-- repayment transactions move with them (account_type = 'loan', account_id =
-- the loan's id). The transactions.account_type CHECK previously allowed only
-- 'bank' and 'credit_card', which would reject those updates.

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_account_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_account_type_check
  CHECK (account_type IN ('bank', 'credit_card', 'loan'));
