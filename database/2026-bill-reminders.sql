-- Per-bill Telegram reminders.
-- Each bill/reminder can carry an array of reminder entries:
--   { id: string, offset_days: number, time: "HH:MM", last_sent: string|null }
-- Each fires as a standalone Telegram message at (due_date − offset_days) @ time
-- in the user's timezone. Recurring bills carry the array forward with last_sent
-- reset, so the reminders repeat for every future occurrence.
ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS reminders JSONB NOT NULL DEFAULT '[]'::jsonb;
