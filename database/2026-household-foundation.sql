-- ── Phase 7.1: household / shared finances foundation ────────────────────────
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- ── The one law this phase is built on ──────────────────────────────────────
-- SHARING CHANGES WHO CAN SEE A ROW. IT NEVER CHANGES HOW MANY ROWS THERE ARE.
--
-- A shared account is the SAME single row its owner already had, with a
-- household stamped on it. There is no copy in the partner's data, no mirrored
-- balance, no second transaction, no household-side ledger. That is why:
--
--   • household net worth sums each shared row EXACTLY ONCE, however many
--     members can see it;
--   • a member's personal net worth is the rows they OWN, so the members'
--     personal totals add up to the household total with nothing left over
--     and nothing counted twice;
--   • removing a member removes their ACCESS, never anybody's money.
--
-- Which is also why this migration adds no new money tables. Every shareable
-- entity keeps living in the table it already lives in and gains one nullable
-- pointer: `household_id`. NULL means personal. Non-NULL means shared with that
-- household. Two columns could contradict each other; one cannot.

-- ── Households ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS households (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  name       TEXT        NOT NULL,
  -- The user who created it. ON DELETE SET NULL, never CASCADE: deleting the
  -- founder's account must not delete the household their partner still uses.
  created_by UUID        REFERENCES users(id) ON DELETE SET NULL,
  currency   TEXT        DEFAULT 'AUD',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE households ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_households_updated_at ON households;
CREATE TRIGGER trg_households_updated_at
  BEFORE UPDATE ON households
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Members and roles ─────────────────────────────────────────────────────────
--
-- Roles, weakest first:
--   viewer  sees the shared picture and changes nothing.
--   member  sees it and edits the shared rows. The normal role for a partner.
--   admin   member + invites and removes people.
--   owner   admin + role changes, ownership transfer, deleting the household.
--
-- A removed member is kept as a row with status='removed' rather than deleted:
-- the household's history should still be able to say who was in it and when,
-- and re-inviting somebody should not resurrect old access by accident.

CREATE TABLE IF NOT EXISTS household_members (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id UUID        NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT        NOT NULL DEFAULT 'member'
                 CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  status       TEXT        NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active', 'removed')),
  joined_at    TIMESTAMPTZ DEFAULT NOW(),
  removed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- One membership row per person per household. A re-invitation updates this row
-- back to active instead of adding a second one, so "am I a member?" can never
-- have two contradictory answers.
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_members_unique
  ON household_members(household_id, user_id);

-- Exactly one ACTIVE owner per household, enforced by the database rather than
-- by hope. Ownership transfer therefore has to demote the old owner in the same
-- breath as promoting the new one, which is exactly the behaviour we want.
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_members_one_owner
  ON household_members(household_id)
  WHERE role = 'owner' AND status = 'active';

CREATE INDEX IF NOT EXISTS idx_household_members_user
  ON household_members(user_id) WHERE status = 'active';

ALTER TABLE household_members ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_household_members_updated_at ON household_members;
CREATE TRIGGER trg_household_members_updated_at
  BEFORE UPDATE ON household_members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Invitations ───────────────────────────────────────────────────────────────
--
-- An invitation is addressed to an EMAIL, because the person being invited may
-- not have an account yet. It carries a random code: that code, plus a matching
-- email on the accepting account, is what turns it into a membership. Nothing
-- about an invitation grants access on its own — only the membership row does.
--
-- `owner` is deliberately absent from the role CHECK. Ownership is transferred
-- between existing members, never handed to somebody who has not joined yet.

CREATE TABLE IF NOT EXISTS household_invitations (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  household_id UUID        NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  -- Stored lowercased/trimmed by the API so matching an account is exact.
  email        TEXT        NOT NULL,
  role         TEXT        NOT NULL DEFAULT 'member'
                 CHECK (role IN ('admin', 'member', 'viewer')),
  code         TEXT        NOT NULL UNIQUE,
  invited_by   UUID        REFERENCES users(id) ON DELETE SET NULL,
  status       TEXT        NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'accepted', 'declined', 'revoked', 'expired')),
  expires_at   TIMESTAMPTZ NOT NULL,
  accepted_by  UUID        REFERENCES users(id) ON DELETE SET NULL,
  accepted_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

-- At most one LIVE invitation per address per household. Declined, revoked and
-- accepted ones stay for the record and don't block a fresh invite.
CREATE UNIQUE INDEX IF NOT EXISTS idx_household_invitations_live
  ON household_invitations(household_id, email)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_household_invitations_email
  ON household_invitations(email) WHERE status = 'pending';

ALTER TABLE household_invitations ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_household_invitations_updated_at ON household_invitations;
CREATE TRIGGER trg_household_invitations_updated_at
  BEFORE UPDATE ON household_invitations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Making the EXISTING entities shareable ────────────────────────────────────
--
-- One nullable pointer per shareable table. No new tables, no parallel
-- "household_accounts", no duplicated balances — the row a user already had is
-- the row the household sees.
--
-- ON DELETE SET NULL is the whole safety story for deleting a household: every
-- shared row quietly reverts to personal, owned by exactly the user who owned it
-- all along. Deleting a household can never delete a member's money.

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'bank_accounts', 'credit_cards', 'transactions', 'loans',
    'properties', 'budgets', 'goals'
  ] LOOP
    EXECUTE format(
      'ALTER TABLE %I ADD COLUMN IF NOT EXISTS household_id UUID '
      'REFERENCES households(id) ON DELETE SET NULL', t);
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS idx_%s_household ON %I(household_id) '
      'WHERE household_id IS NOT NULL', t, t);
  END LOOP;
END $$;

-- ── Who a shared transaction actually belongs to ──────────────────────────────
--
-- `user_id` says who OWNS the record — whoever entered or imported it, and whose
-- personal net worth the underlying account sits in. That is not always who the
-- spend belongs to: on a joint account, everything imported by one partner
-- arrives under that partner's user_id even though half of it is the other's.
--
-- `responsible_user_id` carries that second, separate fact: whose spending this
-- is. It defaults to NULL, meaning "the owner" — so every transaction ever
-- imported keeps the answer it already had, and nothing has to be backfilled.
--
-- It is a REPORTING attribution and nothing else. Balances and net worth are
-- read from account rows, never by adding transactions up, so attributing a
-- transaction to a partner moves it between spending columns and cannot move a
-- single dollar of anybody's net worth. That is what keeps "who spent this"
-- answerable without ever duplicating the transaction itself.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS responsible_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_responsible
  ON transactions(responsible_user_id) WHERE responsible_user_id IS NOT NULL;
