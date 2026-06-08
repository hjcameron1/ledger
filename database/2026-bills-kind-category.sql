-- Bills & Reminders: distinguish bills from reminders, add categories, and support
-- per-occurrence ("just this once") edits on recurring items.
--
-- All additive — existing rows keep working (kind defaults to 'bill', the rest null).
ALTER TABLE bills ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'bill';
ALTER TABLE bills ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE bills ADD COLUMN IF NOT EXISTS recurring_template JSONB;
-- Per-item lead time (days before due_date the item surfaces on the overview).
ALTER TABLE bills ADD COLUMN IF NOT EXISTS lead_days INT;
