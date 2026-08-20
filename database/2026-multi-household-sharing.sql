-- ═══════════════════════════════════════════════════════════════════════════
--  Multi-household sharing (2026-08-20)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Until now a shareable row (bank account, credit card, transaction, loan,
-- property, budget, goal) carried a SINGLE `household_id` column, so it could
-- live in exactly one household. This migration makes that many-to-many: one row
-- can be shared to any number of households, appearing once — and counting once —
-- in each household's view (households are always looked at one at a time, never
-- summed together, so "counted once" still holds per view).
--
-- The mechanism is a join table, `record_households`, structurally a sibling of
-- `record_shares` (direct grants). It is the SINGLE SOURCE OF TRUTH for which
-- households a row is shared to. The old per-row `household_id` columns are left
-- in place but no longer read or written by the application — kept only so that
-- nothing errors and so a still-deploying old backend keeps working during the
-- rollout. Nothing here copies a row, moves a balance, or touches ownership:
-- exactly like the single column it replaces, this only records who may LOOK.

-- ── The join table ──────────────────────────────────────────────────────────
--
-- `record_type` is a CHECK, not a foreign key: one table spans seven entity
-- tables, so a single FK is impossible — the same trade `record_shares` makes.
-- `owner_user_id` is stored alongside so "un-share everything this member put
-- into the household" (when they leave) is one indexed delete.

CREATE TABLE IF NOT EXISTS record_households (
  id            UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  record_type   TEXT        NOT NULL
                  CHECK (record_type IN ('account', 'card', 'transaction',
                                         'loan', 'property', 'budget', 'goal')),
  record_id     UUID        NOT NULL,
  household_id  UUID        NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_user_id UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ONE membership per row per household — the whole of duplicate prevention. A
-- row cannot be shared to the same household twice, so no amount of re-sharing
-- can make it appear on one household's screen more than once.
CREATE UNIQUE INDEX IF NOT EXISTS idx_record_households_unique
  ON record_households(record_type, record_id, household_id);

-- "What is shared with a household I'm in?" — the read every scoped query makes.
CREATE INDEX IF NOT EXISTS idx_record_households_by_household
  ON record_households(household_id);

-- "Which households is this row in?" — the read the Sharing panel and the
-- edit/visibility checks make.
CREATE INDEX IF NOT EXISTS idx_record_households_by_record
  ON record_households(record_type, record_id);

-- "What did this member share into this household?" — the read the leave /
-- remove-member cleanup makes.
CREATE INDEX IF NOT EXISTS idx_record_households_by_owner
  ON record_households(owner_user_id, household_id);

ALTER TABLE record_households ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_record_households_updated_at ON record_households;
CREATE TRIGGER trg_record_households_updated_at
  BEFORE UPDATE ON record_households
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Backfill from the single column ─────────────────────────────────────────
--
-- Every row that already sat in a household becomes one membership row. Idempotent
-- via ON CONFLICT, so re-running this migration is safe. After this, the join
-- table is complete and the application reads it alone; the old columns are inert.

INSERT INTO record_households (record_type, record_id, household_id, owner_user_id)
SELECT 'account', id, household_id, user_id FROM bank_accounts WHERE household_id IS NOT NULL
ON CONFLICT (record_type, record_id, household_id) DO NOTHING;

INSERT INTO record_households (record_type, record_id, household_id, owner_user_id)
SELECT 'card', id, household_id, user_id FROM credit_cards WHERE household_id IS NOT NULL
ON CONFLICT (record_type, record_id, household_id) DO NOTHING;

INSERT INTO record_households (record_type, record_id, household_id, owner_user_id)
SELECT 'transaction', id, household_id, user_id FROM transactions WHERE household_id IS NOT NULL
ON CONFLICT (record_type, record_id, household_id) DO NOTHING;

INSERT INTO record_households (record_type, record_id, household_id, owner_user_id)
SELECT 'loan', id, household_id, user_id FROM loans WHERE household_id IS NOT NULL
ON CONFLICT (record_type, record_id, household_id) DO NOTHING;

INSERT INTO record_households (record_type, record_id, household_id, owner_user_id)
SELECT 'property', id, household_id, user_id FROM properties WHERE household_id IS NOT NULL
ON CONFLICT (record_type, record_id, household_id) DO NOTHING;

INSERT INTO record_households (record_type, record_id, household_id, owner_user_id)
SELECT 'budget', id, household_id, user_id FROM budgets WHERE household_id IS NOT NULL
ON CONFLICT (record_type, record_id, household_id) DO NOTHING;

INSERT INTO record_households (record_type, record_id, household_id, owner_user_id)
SELECT 'goal', id, household_id, user_id FROM goals WHERE household_id IS NOT NULL
ON CONFLICT (record_type, record_id, household_id) DO NOTHING;
