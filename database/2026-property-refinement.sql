-- ── Phase 4.1 refinement: structured addresses + who holds the property ──────
-- Run this in the Supabase SQL editor. Safe to run more than once, and safe to
-- run WHETHER OR NOT 2026-property-foundation.sql has been applied — the CREATE
-- below builds the finished shape, and the ALTERs bring an older table up to it.
--
-- Two things change.
--
-- 1. THE ADDRESS IS STRUCTURED AND REQUIRED. One free-text line couldn't be
--    grouped, sorted or matched against anything, so street/suburb/state/
--    postcode/country each get a column. Unit/lot and the nickname (`name`) are
--    optional, which is why `name` loses its NOT NULL: a property with a real
--    address doesn't need a made-up label, and the app derives one from the
--    address when the user leaves it blank. The legacy `address` column stays as
--    a read-only fallback for rows entered before this migration.
--
-- 2. HELD-BY. A property can be held personally, jointly, or inside an SMSF, and
--    an SMSF-held property points at the fund that holds it (an smsf_funds row,
--    or a super_funds row for a fund tracked only as a balance).
--
--    `counted_in_fund_balance` is the anti-double-count switch for that case. An
--    SMSF's balance in this app is the sum of its own asset rows, and users
--    usually already list the property there. When this flag is TRUE the property
--    contributes NOTHING of its own to net worth — the fund already carries the
--    value — while equity, LVR and the gain still display normally. Set it FALSE
--    only when the fund's balance genuinely excludes the property, and then the
--    value is added here instead. Either way it is counted exactly once, which is
--    the same rule the mortgage already follows: the linked loan is subtracted by
--    the loans table, never a second time by the property.

CREATE TABLE IF NOT EXISTS properties (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          REFERENCES users(id) ON DELETE CASCADE,
  -- Optional nickname. Blank ⇒ the app labels the property by its address.
  name                 TEXT,
  -- Legacy single-line address, kept for rows written before this migration.
  address              TEXT,
  address_unit         TEXT,
  address_street       TEXT,
  address_suburb       TEXT,
  address_state        TEXT,
  address_postcode     TEXT,
  address_country      TEXT          DEFAULT 'Australia',
  property_type        TEXT          NOT NULL DEFAULT 'home'
                         CHECK (property_type IN ('home', 'investment', 'holiday', 'land', 'commercial', 'other')),
  held_by              TEXT          NOT NULL DEFAULT 'personal'
                         CHECK (held_by IN ('personal', 'joint', 'smsf')),
  -- The SMSF that holds this property. At most one of these is set, and only
  -- when held_by = 'smsf'. ON DELETE SET NULL: removing the fund leaves the
  -- property behind rather than deleting an asset the user still owns.
  smsf_fund_id         UUID          REFERENCES smsf_funds(id) ON DELETE SET NULL,
  super_fund_id        UUID          REFERENCES super_funds(id) ON DELETE SET NULL,
  -- TRUE ⇒ the linked fund's balance already includes this property's value, so
  -- the property adds nothing of its own to net worth (see the header note).
  counted_in_fund_balance BOOLEAN    NOT NULL DEFAULT TRUE,
  purchase_price       DECIMAL(15,2) NOT NULL DEFAULT 0,
  purchase_date        DATE,
  current_value        DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- The share the user owns (100 = sole owner, 50 = joint). Only this share of
  -- the value reaches net worth, so a half-owned house never inflates the total.
  ownership_percent    DECIMAL(6,3)  NOT NULL DEFAULT 100
                         CHECK (ownership_percent >= 0 AND ownership_percent <= 100),
  -- Optional link to the EXISTING loan that funds this property. ON DELETE SET
  -- NULL: deleting the mortgage leaves the property (unencumbered), never
  -- orphans it.
  loan_id              UUID          REFERENCES loans(id) ON DELETE SET NULL,
  include_in_net_worth BOOLEAN       NOT NULL DEFAULT TRUE,
  notes                TEXT,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);

-- ── Bring a foundation-era table up to the shape above ────────────────────────
ALTER TABLE properties ALTER COLUMN name DROP NOT NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_unit     TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_street   TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_suburb   TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_state    TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_postcode TEXT;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS address_country  TEXT DEFAULT 'Australia';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS held_by          TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE properties ADD COLUMN IF NOT EXISTS smsf_fund_id     UUID REFERENCES smsf_funds(id) ON DELETE SET NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS super_fund_id    UUID REFERENCES super_funds(id) ON DELETE SET NULL;
ALTER TABLE properties ADD COLUMN IF NOT EXISTS counted_in_fund_balance BOOLEAN NOT NULL DEFAULT TRUE;

DO $$ BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_held_by_check
    CHECK (held_by IN ('personal', 'joint', 'smsf'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A property is held by ONE fund at most. Without this a single property could
-- point at both an SMSF and a super fund and "already counted" would be
-- ambiguous — which fund is carrying the value?
DO $$ BEGIN
  ALTER TABLE properties ADD CONSTRAINT properties_one_fund_check
    CHECK (NOT (smsf_fund_id IS NOT NULL AND super_fund_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- A loan can back at most ONE property. Without this the same mortgage balance
-- could be netted against two properties' equity, and "total property debt"
-- would count it twice — the exact double-count this phase exists to prevent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_loan_unique
  ON properties(loan_id) WHERE loan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_properties_user ON properties(user_id);
CREATE INDEX IF NOT EXISTS idx_properties_smsf_fund ON properties(smsf_fund_id) WHERE smsf_fund_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_properties_super_fund ON properties(super_fund_id) WHERE super_fund_id IS NOT NULL;

-- Same posture as every other table here: the backend uses the service-role key
-- and scopes every query by user_id; RLS denies direct anon/authenticated access.
ALTER TABLE properties ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_properties_updated_at ON properties;
CREATE TRIGGER trg_properties_updated_at
  BEFORE UPDATE ON properties
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
