-- Briefing delivery status — a briefing that doesn't arrive has to say why.
--
-- The scheduler claims the day (last_sent_date) BEFORE it sends, so two
-- overlapping runs can't both send. The cost was that a send which then failed
-- still left the day marked done: the briefing stopped arriving while the row
-- insisted it had gone out every morning, and nothing anywhere recorded the
-- refusal. That is the "worked for a week, then stopped" report.
--
-- The scheduler now hands the day back when a send fails, and writes what
-- happened here. GET /api/settings/briefing returns the row as-is, so these two
-- columns reach the Settings screen with no other change.
--
--   last_send_status  'sent 2026-09-01'
--                     'failed 2026-09-01: Bad Request: can't parse entities'
--                     'missed 2026-09-01: nothing was running between 08:00 and
--                      the 90-minute cut-off'
--   last_attempt_at   when that was written
--
-- Safe to re-run. The scheduler probes for these columns and keeps sending
-- briefings without them.

alter table telegram_briefing_settings
  add column if not exists last_send_status text,
  add column if not exists last_attempt_at  timestamptz;
