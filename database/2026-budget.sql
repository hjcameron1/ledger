-- Budget feature (Overview "Budget" section).
--
-- Three new tables:
--   budget_settings  — one row per user: the plan-level config (period + how the
--                      per-period income figure is derived).
--   budget_lines     — the individual budgeted items (categories, bills, pays,
--                      expenses, recurring) that make up the plan.
--   custom_categories — user-created spending categories that merge into the
--                      built-in list so they also show up on transactions.
--
-- The legacy `budgets` table (simple category/limit rows) is left untouched.

-- ── Plan-level settings (one per user) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_settings (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID          UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  period        TEXT          NOT NULL DEFAULT 'monthly'
                              CHECK (period IN ('weekly', 'fortnightly', 'monthly')),
  income_basis  TEXT          NOT NULL DEFAULT 'projected'
                              CHECK (income_basis IN ('projected', 'manual', 'average')),
  -- Per-period income. For 'manual' this is the user's figure; for the other
  -- bases it's a cached snapshot of the derived amount (recomputed client-side).
  income_amount DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_budget_settings_updated_at ON budget_settings;
CREATE TRIGGER trg_budget_settings_updated_at
  BEFORE UPDATE ON budget_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Budget line items ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS budget_lines (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID          REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT          NOT NULL DEFAULT 'expense'
                              CHECK (type IN ('expense', 'bill', 'recurring', 'pay', 'income', 'saving')),
  name          TEXT          NOT NULL,
  -- Transaction category this line is tracked against (actual spend = sum of
  -- transactions in this category for the current period). NULL = untracked.
  category      TEXT,
  -- Budgeted amount per the plan's period.
  amount        DECIMAL(15,2) NOT NULL DEFAULT 0,
  source        TEXT          NOT NULL DEFAULT 'manual'
                              CHECK (source IN ('manual', 'bill', 'recurring', 'bank')),
  -- Origin id when imported from a bill / subscription, so we don't double-import.
  source_ref_id UUID,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_budget_lines_user ON budget_lines(user_id);

DROP TRIGGER IF EXISTS trg_budget_lines_updated_at ON budget_lines;
CREATE TRIGGER trg_budget_lines_updated_at
  BEFORE UPDATE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── User-defined categories ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS custom_categories (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, name)
);

DROP TRIGGER IF EXISTS trg_custom_categories_updated_at ON custom_categories;
CREATE TRIGGER trg_custom_categories_updated_at
  BEFORE UPDATE ON custom_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE budget_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_categories ENABLE ROW LEVEL SECURITY;
