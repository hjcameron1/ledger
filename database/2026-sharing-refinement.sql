-- ── Phase 7.2: direct sharing, multiple households ───────────────────────────
-- Run this in the Supabase SQL editor AFTER 2026-household-foundation.sql.
-- Safe to run more than once.
--
-- ── The law, now in two halves ──────────────────────────────────────────────
-- 7.1 said: SHARING CHANGES WHO CAN SEE A ROW, NEVER HOW MANY ROWS THERE ARE.
-- 7.2 adds:                        AND IT NEVER CHANGES WHOSE ROW IT IS.
--
-- Those two sentences are the whole design. OWNERSHIP decides every total;
-- SHARING decides only sight. Which means there are two independent grants, and
-- keeping them independent is what stops the arithmetic going wrong:
--
--   HOUSEHOLD STAMP  (`household_id`, added in 7.1)
--     Puts a row into a shared VIEW that has totals of its own. Each shared row
--     is counted once there, however many members are looking.
--
--   DIRECT GRANT     (`record_shares`, added here)
--     Lets ONE named person see ONE row that stays entirely its owner's. It
--     appears on their screen with a Shared badge and it enters NOBODY's totals
--     but the owner's — because the money did not move, and two people looking
--     at one account has never meant two accounts' worth of money exists.
--
-- That is the answer to "does my net worth go up when my partner shares their
-- offset account with me?". No. You can see it. It is theirs.
--
-- Neither grant copies a row, and neither touches `user_id`. There is still
-- exactly one row per account, per transaction, per goal — in the table it has
-- always lived in.

-- ═══════════════════════════════════════════════════════════════════════════
--  Household join codes
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A household already had email invitations (7.1). This adds the other half a
-- group needs: a standing link anyone can join through, rotated or switched off
-- by an owner whenever they like.
--
-- Why a household gets a STANDING code and a shared account gets a single-use
-- one (see `share_codes` below): joining a household grants a role inside a
-- group you can be removed from, and everybody in it can see who arrived. A
-- link to one bank account grants sight of that account to whoever holds the
-- link, with nobody watching the door. The first is a front door; the second
-- would be a key under the mat.

ALTER TABLE households
  ADD COLUMN IF NOT EXISTS join_code TEXT,
  -- The role someone joining by link arrives at. Never 'owner', and never
  -- 'admin' by default: a link is the least-supervised way in, so it hands out
  -- the least power that is still useful.
  ADD COLUMN IF NOT EXISTS join_role TEXT NOT NULL DEFAULT 'member'
    CHECK (join_role IN ('admin', 'member', 'viewer')),
  -- NULL means the code never expires on its own. It is still revocable at any
  -- moment by clearing join_code, which is the lever people actually use.
  ADD COLUMN IF NOT EXISTS join_code_expires_at TIMESTAMPTZ;

-- Unique so a code can be resolved to exactly one household, and partial so the
-- overwhelmingly common NULL (no live link) doesn't collide with itself.
CREATE UNIQUE INDEX IF NOT EXISTS idx_households_join_code
  ON households(join_code) WHERE join_code IS NOT NULL;

-- ═══════════════════════════════════════════════════════════════════════════
--  Direct grants: one row, one named person
-- ═══════════════════════════════════════════════════════════════════════════
--
-- `record_type` is the product's word for the kind of thing ('account', 'card',
-- 'transaction', 'loan', 'property', 'budget', 'goal'), matching the vocabulary
-- both engines already use. It is deliberately not a foreign key: one grant
-- table across seven entity tables cannot have a referential constraint, and
-- inventing seven near-identical tables to get one would be a worse trade than
-- the API checking the row exists before it mints the grant — which it does.
--
-- `owner_user_id` is stored alongside the recipient so "who shared this with
-- me?" and "who have I shared this with?" are both one indexed read, and so a
-- grant can still be shown correctly on the screen of a person who can no
-- longer see the underlying row.

CREATE TABLE IF NOT EXISTS record_shares (
  id                 UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  record_type        TEXT        NOT NULL
                       CHECK (record_type IN ('account', 'card', 'transaction',
                                              'loan', 'property', 'budget', 'goal')),
  record_id          UUID        NOT NULL,
  owner_user_id      UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shared_with_user_id UUID       NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- 'view' is the default and the one that matches what people mean by sharing
  -- an account. 'edit' additionally lets the recipient correct the row, exactly
  -- as a household member may — and never lets them delete it.
  permission         TEXT        NOT NULL DEFAULT 'view'
                       CHECK (permission IN ('view', 'edit')),
  -- Ended grants are KEPT, and the two ways of ending one are kept apart:
  -- 'revoked' is the owner taking access back, 'left' is the recipient handing
  -- it back. Both remove access completely; only the history can tell you which
  -- of the two people decided it was over.
  status             TEXT        NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'revoked', 'left')),
  -- The code redeemed to create this grant, when there was one. Null for a
  -- grant made directly.
  via_code           TEXT,
  -- What the row was called when it was shared. Cosmetic, and deliberately a
  -- COPY rather than a join: the recipient's device has a grant before it has
  -- the row, and "Shared with you" reading `Bank account` where it could read
  -- `Everyday offset` is a worse first impression than a name that may later go
  -- slightly stale. Nothing reads this to make a decision.
  record_label       TEXT,
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  ended_at           TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ONE live grant per person per record. This is the whole of duplicate
-- prevention for direct sharing: redeeming a second code for an account you can
-- already see updates nothing and adds nothing, so no amount of link-passing can
-- make a row appear on one screen twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_record_shares_live
  ON record_shares(record_type, record_id, shared_with_user_id)
  WHERE status = 'active';

-- "What can I see that isn't mine?" — the read every scoped query makes.
CREATE INDEX IF NOT EXISTS idx_record_shares_recipient
  ON record_shares(shared_with_user_id, record_type) WHERE status = 'active';

-- "Who can see my things?" — the read the Sharing screen makes.
CREATE INDEX IF NOT EXISTS idx_record_shares_owner
  ON record_shares(owner_user_id) WHERE status = 'active';

ALTER TABLE record_shares ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_record_shares_updated_at ON record_shares;
CREATE TRIGGER trg_record_shares_updated_at
  BEFORE UPDATE ON record_shares
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
--  Share codes: how a grant gets made without knowing an email address
-- ═══════════════════════════════════════════════════════════════════════════
--
-- The owner mints a code, sends it however they like, and the recipient pastes
-- it in. Redeeming it creates the grant above; the code itself grants nothing,
-- exactly as a household invitation grants nothing until it mints a membership.
--
-- Defaults are deliberately mean: ONE use, and an expiry. A code is a bearer
-- token for sight of a bank account, and the failure mode of a generous default
-- is somebody's transaction history in a group chat six months from now.

CREATE TABLE IF NOT EXISTS share_codes (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  code          TEXT        NOT NULL UNIQUE,
  record_type   TEXT        NOT NULL
                  CHECK (record_type IN ('account', 'card', 'transaction',
                                         'loan', 'property', 'budget', 'goal')),
  record_id     UUID        NOT NULL,
  owner_user_id UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission    TEXT        NOT NULL DEFAULT 'view'
                  CHECK (permission IN ('view', 'edit')),
  -- NULL means unlimited, which the API never sets by default.
  max_uses      INTEGER     DEFAULT 1,
  uses          INTEGER     NOT NULL DEFAULT 0,
  status        TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'revoked', 'used')),
  -- Carried onto the grant when the code is redeemed — see record_shares above.
  record_label  TEXT,
  expires_at    TIMESTAMPTZ NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_share_codes_owner
  ON share_codes(owner_user_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_share_codes_record
  ON share_codes(record_type, record_id) WHERE status = 'active';

ALTER TABLE share_codes ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_share_codes_updated_at ON share_codes;
CREATE TRIGGER trg_share_codes_updated_at
  BEFORE UPDATE ON share_codes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ═══════════════════════════════════════════════════════════════════════════
--  What this migration deliberately does NOT do
-- ═══════════════════════════════════════════════════════════════════════════
--
--   • It creates no money table, copies no row and backfills nothing. Every
--     account, transaction, loan, property, budget and goal is the same single
--     row it was before, owned by the same person.
--   • It does not touch `user_id` anywhere, or add a second owner column. A row
--     has one owner; that is what makes the members' totals add up to the
--     household's exactly, and what keeps a direct grant out of the recipient's
--     net worth by construction rather than by a rule someone has to remember.
--   • It does not widen 7.1's household model. Belonging to several households
--     needed no schema change at all — `household_members` was always one row
--     per person per household, so a second membership was always legal. What
--     was missing was only ever the screen to switch between them.
