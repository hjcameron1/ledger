-- Adds the excluded_watchlist_ids column to telegram_briefing_settings.
-- The backend (settings.ts) and the briefing UI both write this field, but the
-- column was never added to the live table, so every briefing save that included
-- it failed with PGRST204 ("Could not find the 'excluded_watchlist_ids' column").
--
-- Matches the sibling exclusion columns (excluded_bank_ids, excluded_card_ids,
-- excluded_goal_ids): a JSON array of string ids, defaulting to empty.
-- Safe to run more than once.

ALTER TABLE telegram_briefing_settings
  ADD COLUMN IF NOT EXISTS excluded_watchlist_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
