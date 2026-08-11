-- Manual ↔ bank-sync reconciliation lifecycle for manually-added transactions.
--
-- When a user adds a transaction by hand to a LIVE-SYNCED (Basiq-linked) account,
-- the next bank sync may (a) contain the same transaction, (b) not contain it, or
-- (c) contain something similar-but-not-identical (amount off by a few dollars, or
-- the merchant spelled differently). These columns track that reconciliation so the
-- account's "Needs review" banner can ask the user what to do, and so the balance
-- can layer "kept" manual adjustments on top of the authoritative bank figure.
--
-- All nullable / no default — existing rows and bank/statement-sourced rows are
-- unaffected (reconcile_state stays NULL = not applicable). Only manual entries on
-- linked accounts ever carry a state.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS reconcile_state      TEXT,         -- pending | kept | conflict | resolved (NULL = n/a)
  ADD COLUMN IF NOT EXISTS reconcile_match_id   UUID,         -- Basiq txn this manual one may duplicate (state=conflict)
  ADD COLUMN IF NOT EXISTS reconcile_checked_at TIMESTAMPTZ;  -- last time the user deferred ("check again next sync")
