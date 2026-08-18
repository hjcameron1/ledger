-- ── Phase 4.3: property performance ─────────────────────────────────────────
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- This phase adds rental income, expenses, yield and cash flow to properties —
-- and adds NO tables. That is the whole point of these two columns.
--
-- Rent is money that already arrived in a bank account and an expense is money
-- that already left one: both are rows in `transactions`, filed under the same
-- categories as everything else. A second "property ledger" would mean the same
-- dollar recorded twice, drifting apart the moment one copy was edited, and it
-- would leave property spending out of budgets and spend-by-category.
--
-- So a property stores only how to RECOGNISE its own transactions:
--
--   match_terms        text the property answers to — an agent, a council, a
--                      strata manager — matched case-insensitively against the
--                      merchant, the raw description and the notes.
--   match_account_ids  accounts wholly dedicated to the property; everything on
--                      them is its own, whatever the description says.
--
-- Both are the user's explicit say-so. A property with neither claims nothing,
-- which is deliberate: a guessed rent payment is invented income.
--
-- Every figure the app shows (rent, expenses, gross/net yield, monthly and
-- annual cash flow, vacancy) is derived from those transactions at read time and
-- is stored nowhere, so correcting a transaction corrects the yield. The
-- mortgage keeps coming from the linked `loans` row, so a repayment is counted
-- once — as a schedule — and never again as a transaction.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS match_terms       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS match_account_ids TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN properties.match_terms IS
  'Phase 4.3: text identifying this property''s transactions (agent, council, strata). Case-insensitive.';
COMMENT ON COLUMN properties.match_account_ids IS
  'Phase 4.3: accounts dedicated to this property — every transaction on them is its own.';
