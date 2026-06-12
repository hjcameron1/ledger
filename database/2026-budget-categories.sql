-- Budget v2 — category-centric model.
--
-- A budget is now organised as CATEGORIES (each with its own spending cap) that
-- contain ITEMS (bills, recurring expenses, or imported transactions showing
-- where the money actually went). Both are stored in `budget_lines`; this flag
-- distinguishes the two:
--   is_category_budget = TRUE  → a category with a budget cap (amount = the cap).
--   is_category_budget = FALSE → an item that lives under a category.
--
-- A category and the items beneath it are linked by the `category` column.

ALTER TABLE budget_lines
  ADD COLUMN IF NOT EXISTS is_category_budget BOOLEAN NOT NULL DEFAULT FALSE;
