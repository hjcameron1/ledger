-- ── Phase 4.1: property foundation ───────────────────────────────────────────
-- Run this in the Supabase SQL editor.
--
-- A property is an ASSET the user owns some share of. Its mortgage is NOT stored
-- here: it stays a normal row in `loans`, and the property merely POINTS at it.
-- That is the whole anti-double-counting design —
--
--   net worth  +=  current_value × ownership_percent/100   (this table)
--   net worth  −=  loans.current_balance                   (the loans table, once)
--
-- so a mortgage is subtracted exactly once no matter how many surfaces show it,
-- and "equity" is a DERIVED figure (owned value − linked loan balance), never a
-- second stored debt.

CREATE TABLE IF NOT EXISTS properties (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT          NOT NULL,
  address              TEXT,
  property_type        TEXT          NOT NULL DEFAULT 'home'
                         CHECK (property_type IN ('home', 'investment', 'holiday', 'land', 'commercial', 'other')),
  purchase_price       DECIMAL(15,2) NOT NULL DEFAULT 0,
  purchase_date        DATE,
  current_value        DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- The share the user owns (100 = sole owner, 50 = joint). Only this share of the
  -- value reaches net worth, so a half-owned house never inflates the total.
  ownership_percent    DECIMAL(6,3)  NOT NULL DEFAULT 100
                         CHECK (ownership_percent >= 0 AND ownership_percent <= 100),
  -- Optional link to the EXISTING loan that funds this property. ON DELETE SET NULL:
  -- deleting the mortgage leaves the property (unencumbered), never orphans it.
  loan_id              UUID          REFERENCES loans(id) ON DELETE SET NULL,
  include_in_net_worth BOOLEAN       NOT NULL DEFAULT TRUE,
  notes                TEXT,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);

-- A loan can back at most ONE property. Without this the same mortgage balance
-- could be netted against two properties' equity, and "total property debt" would
-- count it twice — the exact double-count this phase exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_loan_unique
  ON properties(loan_id) WHERE loan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_properties_user ON properties(user_id);

-- Same posture as every other table here: the backend uses the service-role key
-- and scopes every query by user_id; RLS denies direct anon/authenticated access.
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_properties_updated_at ON properties;
CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
