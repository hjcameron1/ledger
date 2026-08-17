-- Phase 4.3 — savings-goal contributions.
--
-- A ledger of money moved toward (or out of) a goal. One row per movement:
--   amount > 0  → paid in
--   amount < 0  → withdrawn
--
-- `source_type` + `source_id` record WHERE the money moved, and exist for one
-- reason: a deposit into an account the goal is already LINKED to is visible in
-- that account's balance, so counting the ledger row as well would double-count
-- it. The engine (frontend/src/utils/savingsGoals.ts) compares this pair against
-- the goal's current `linked_sources` and only counts the rows that aren't
-- already reflected there. A NULL source is cash the app cannot see, which is
-- always counted.
--
-- ON DELETE CASCADE: deleting a goal takes its ledger with it. The history has
-- no meaning without the goal, and an orphaned row would be invisible but still
-- billable against the user's data.
CREATE TABLE IF NOT EXISTS goal_contributions (
  id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID          REFERENCES users(id) ON DELETE CASCADE,
  goal_id     UUID          NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  amount      DECIMAL(15,2) NOT NULL,
  date        DATE          NOT NULL,
  -- 'account' | 'investment' | 'super', or NULL for untracked cash.
  source_type TEXT,
  source_id   UUID,
  note        TEXT,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goal_contributions_user ON goal_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_goal_contributions_goal ON goal_contributions(goal_id);

DROP TRIGGER IF EXISTS trg_goal_contributions_updated_at ON goal_contributions;
CREATE TRIGGER trg_goal_contributions_updated_at
  BEFORE UPDATE ON goal_contributions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
