-- ── Phase 4.3 (refined): property income & expense rules ────────────────────
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- SUPERSEDES 2026-property-performance.sql — it contains those two columns as
-- well, so running this one alone is enough whether or not that one ever ran.
--
-- Still no property ledger, and that is still the point. Rent is money that
-- already arrived in a bank account and an expense is money that already left
-- one: both are rows in `transactions`, in the categories the rest of Ledger
-- uses. A second ledger would mean the same dollar recorded twice, drifting
-- apart the moment one copy was edited, and it would leave property spending
-- out of budgets and spend-by-category. So a property stores only how to
-- RECOGNISE its own transactions.
--
-- ── Expenses — every property has them ──────────────────────────────────────
--   match_terms        text the property answers to — a strata manager, a
--                      council, an insurer, a plumber — matched
--                      case-insensitively against the merchant, the raw
--                      description and the notes.
--   match_account_ids  accounts wholly dedicated to the property; everything on
--                      them is its own, whatever the description says.
--
-- ── Rent — only a let property has it ───────────────────────────────────────
-- An owner-occupied home earns nothing, so it has no rent payer, no expected
-- rent and no receiving account: the app hides the whole idea from it and the
-- engine refuses to read any credit against a home as rental income.
--
--   rent_match_terms         who pays the rent, as they appear on the
--                            statement. Normally captured by pointing at a real
--                            rent transaction rather than typed from memory.
--   rent_account_id          the account rent lands in. It may be the everyday
--                            account, so a credit here is only rent when the
--                            payer matches or the amount fits the expectation
--                            below — otherwise a salary would be rental income.
--   expected_rent_amount     what one payment should be.
--   expected_rent_frequency  how often it is due: weekly, fortnightly, monthly
--                            or quarterly.
--
-- The expected rent is NOT stored income and nothing is derived from it alone.
-- It vouches for a credit in a shared account, caps what a single payment can
-- plausibly be (no bond or settlement is a rent payment), and lets the app say
-- whether the rent actually banked is running behind the rent that was agreed.
--
-- Every figure the app shows — rent, expenses by cost type, gross/net yield,
-- monthly and annual cash flow, vacancy — is derived from those transactions at
-- read time and is stored nowhere, so correcting a transaction corrects the
-- yield. The mortgage keeps coming from the linked `loans` row, so a repayment
-- is counted once, as a schedule, and never again as a transaction.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS match_terms       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS match_account_ids TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_match_terms        TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_account_id         TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS expected_rent_amount    NUMERIC;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS expected_rent_frequency TEXT;

-- Only the four cycles the app can turn into a yearly figure. Added separately
-- so re-running this file doesn't fail on a constraint that already exists.
DO $$
BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_expected_rent_frequency_check
    CHECK (expected_rent_frequency IS NULL
           OR expected_rent_frequency IN ('weekly', 'fortnightly', 'monthly', 'quarterly'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN properties.match_terms IS
  'Text identifying this property''s EXPENSES (strata, council, water, insurer, trades). Case-insensitive.';
COMMENT ON COLUMN properties.match_account_ids IS
  'Accounts dedicated to this property — every transaction on them is its own.';
COMMENT ON COLUMN properties.rent_match_terms IS
  'Who pays the rent, as it appears on the statement. Investment property only.';
COMMENT ON COLUMN properties.rent_account_id IS
  'Account the rent lands in. Shared accounts need the payer or the amount to agree.';
COMMENT ON COLUMN properties.expected_rent_amount IS
  'What one rent payment should be — used to recognise rent, never as stored income.';
COMMENT ON COLUMN properties.expected_rent_frequency IS
  'weekly | fortnightly | monthly | quarterly.';
