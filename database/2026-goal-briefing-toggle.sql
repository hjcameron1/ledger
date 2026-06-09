-- Per-goal opt-out from the daily briefing / Telegram message. Defaults to true
-- (included) so existing goals keep showing up.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS include_in_briefing BOOLEAN DEFAULT TRUE;
