-- Phase 4.1 — Budgeting foundation.
--
-- Extends the existing `budgets` table (category / limit_amount / period /
-- rollover_enabled) into the model the Phase 4 engine needs, rather than adding
-- a third parallel budget store beside `budgets` and `budget_lines`:
--
--   scope        'category' (a cap on one category) | 'overall' (a cap on ALL
--                spending). An overall row carries no category.
--   start_month  'YYYY-MM' — the first month the cap applies to. Rollover never
--                accumulates from before it.
--   active       retire a budget without destroying its history.
--
-- `budget_lines` / `budget_settings` (the Overview budget PLANNER) are left
-- completely untouched — this is the tracking layer, not the planner.
--
-- Idempotent: safe to run more than once.

-- The overall budget has no category, so the legacy NOT NULL has to go.
ALTER TABLE budgets ALTER COLUMN category DROP NOT NULL;

ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'category'
    CHECK (scope IN ('category', 'overall'));

ALTER TABLE budgets ADD COLUMN IF NOT EXISTS start_month TEXT;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- Backfill rows written before these columns existed.
UPDATE budgets SET scope  = 'category' WHERE scope IS NULL;
UPDATE budgets SET active = TRUE       WHERE active IS NULL;
UPDATE budgets SET rollover_enabled = FALSE WHERE rollover_enabled IS NULL;

-- ── One live budget per key ──────────────────────────────────────────────────
-- A user gets at most one ACTIVE overall budget and one ACTIVE budget per
-- category (case-insensitively — "Groceries" and "groceries" are one category).
-- Retired rows are exempt, so history and the de-duplication below coexist.
--
-- De-duplicate first: retire all but the newest row of each key, otherwise
-- creating the unique indexes would fail on legacy data. Nothing is deleted.
UPDATE budgets b SET active = FALSE
  WHERE b.active
    AND COALESCE(b.scope, 'category') = 'overall'
    AND EXISTS (
      SELECT 1 FROM budgets o
       WHERE o.user_id = b.user_id
         AND o.active
         AND COALESCE(o.scope, 'category') = 'overall'
         AND (o.created_at, o.id) > (b.created_at, b.id)
    );

UPDATE budgets b SET active = FALSE
  WHERE b.active
    AND COALESCE(b.scope, 'category') = 'category'
    AND b.category IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM budgets o
       WHERE o.user_id = b.user_id
         AND o.active
         AND COALESCE(o.scope, 'category') = 'category'
         AND lower(o.category) = lower(b.category)
         AND (o.created_at, o.id) > (b.created_at, b.id)
    );

CREATE UNIQUE INDEX IF NOT EXISTS uq_budgets_overall
  ON budgets (user_id) WHERE scope = 'overall' AND active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_budgets_category
  ON budgets (user_id, lower(category)) WHERE scope = 'category' AND active;

CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets (user_id);

ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;

-- Verify:
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'budgets' ORDER BY ordinal_position;
