-- Per-account UI preferences that should follow the user across devices
-- (e.g. how many bills/reminders to show on the overview, the base lead time).
-- Stored as JSON so we can add more display prefs without further migrations.
ALTER TABLE users ADD COLUMN IF NOT EXISTS ui_preferences JSONB;
