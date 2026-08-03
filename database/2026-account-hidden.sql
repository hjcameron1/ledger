-- Bank accounts: per-account "hidden" flag. A hidden account stays in the
-- Accounts list (collapsed under a "Hidden accounts" section) but is excluded
-- from the bank-balance total and from net worth. Defaults to FALSE so every
-- existing account remains visible and counted, matching prior behaviour.
ALTER TABLE bank_accounts
  ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;
