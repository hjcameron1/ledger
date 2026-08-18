-- ── Phase 4.3 (refined again): one setup per cost, and one match per payment ─
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- SUPERSEDES 2026-property-rent-rules.sql (and, through it,
-- 2026-property-performance.sql) — every column those add is added here too, so
-- running this one alone is enough whether or not either of them ever ran.
--
-- Still no property ledger. Rent is money that already arrived in a bank account
-- and an expense is money that already left one: both are rows in
-- `transactions`, in the categories the rest of Ledger uses. A property stores
-- only how to RECOGNISE its own transactions, and every figure it shows — rent,
-- cost by type, yield, cash flow, vacancy — is derived from them at read time.
--
-- ── What changed, and why ───────────────────────────────────────────────────
-- A property never had "some costs". It had a strata levy, a council rate
-- notice, a water bill, an insurance premium and whatever the plumber charged —
-- each with its own biller, its own amount and its own cycle. One free-text
-- "match text" box could not tell them apart, so it could not say a levy had
-- gone up, or that the rates notice due in July never arrived.
--
--   property_expenses  a JSON array, one entry per cost:
--                        id              stable id, generated in the browser
--                        name            what the user calls it
--                        kind            strata | council | water | insurance
--                                        | maintenance | utilities | other
--                        expected_amount what one bill should be
--                        frequency       weekly | fortnightly | monthly
--                                        | quarterly | annually | irregular
--                        account_id      the account it is paid from
--                        whole_account   TRUE ⇒ that account is used for nothing
--                                        else, so everything on it is this
--                                        property's. This is what the old
--                                        `match_account_ids` became.
--                        match_terms     the biller as the statement writes it
--
-- JSON rather than a table because an expense rule belongs to exactly one
-- property and is never queried on its own — a table would buy joins nobody
-- makes, and a rule would then be able to outlive the property it describes.
--
--   excluded_transaction_ids  payments the user has taken back off this
--                             property. A rule that catches the wrong money is
--                             corrected by pointing at the payment, not by
--                             rewriting the rule until it stops. The transaction
--                             itself is untouched — it goes on being an ordinary
--                             transaction everywhere else in Ledger.
--
-- The older `match_terms` / `match_account_ids` are KEPT and still matched, so a
-- property set up before this goes on working untouched. The app converts them
-- into the rules above the next time that property is edited.
--
-- ── The columns the earlier migrations added (included here) ────────────────
--   match_terms / match_account_ids                 the legacy expense rules
--   rent_match_terms                                who pays the rent
--   rent_account_id                                 where it lands
--   expected_rent_amount / expected_rent_frequency  what one payment should be
--
-- Rent belongs to a LET property only. An owner-occupied home earns nothing, so
-- the app hides the whole idea from it and the engine refuses to read any credit
-- against a home as rental income.

ALTER TABLE properties ADD COLUMN IF NOT EXISTS match_terms       TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS match_account_ids TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_match_terms        TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_account_id         TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS expected_rent_amount    NUMERIC;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS expected_rent_frequency TEXT;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS property_expenses        JSONB  NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS excluded_transaction_ids TEXT[] NOT NULL DEFAULT '{}';

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

-- An array, not an object: the app reads `property_expenses` with a loop and a
-- stray object there would be silently skipped rather than reported.
DO $$
BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_property_expenses_is_array
    CHECK (jsonb_typeof(property_expenses) = 'array');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN properties.match_terms IS
  'LEGACY expense rules — free text identifying this property''s costs. Superseded by property_expenses; still matched.';
COMMENT ON COLUMN properties.match_account_ids IS
  'LEGACY — accounts dedicated to this property. Superseded by a property_expenses rule with whole_account.';
COMMENT ON COLUMN properties.rent_match_terms IS
  'Who pays the rent, as it appears on the statement. Investment property only.';
COMMENT ON COLUMN properties.rent_account_id IS
  'Account the rent lands in. Shared accounts need the payer or the amount to agree.';
COMMENT ON COLUMN properties.expected_rent_amount IS
  'What one rent payment should be — used to recognise rent, never as stored income.';
COMMENT ON COLUMN properties.expected_rent_frequency IS
  'weekly | fortnightly | monthly | quarterly.';
COMMENT ON COLUMN properties.property_expenses IS
  'One rule per cost: {id, name, kind, expected_amount, frequency, account_id, whole_account, match_terms}. Holds no money.';
COMMENT ON COLUMN properties.excluded_transaction_ids IS
  'Payments the user removed from this property. The transactions themselves are untouched.';
