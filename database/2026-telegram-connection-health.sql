-- Telegram connection health — the answer to "is the bot still connected?",
-- re-asked every fifteen minutes instead of assumed from the day it was set up.
--
-- "Bot connected ✅" was a claim about a button press. A token revoked in
-- BotFather, a webhook Telegram stopped delivering to, or another service that
-- took the webhook over all look identical to a working connection until a
-- briefing fails to arrive. The watchdog (checkTelegramConnections) asks
-- Telegram itself — getMe, getWebhookInfo — repairs a webhook that has gone
-- astray, and writes what it found here. It reads only: it never sends a
-- message to prove the point.
--
-- One row per user, overwritten each check.
--
-- Safe to re-run. The watchdog still checks and still repairs without this
-- table; it just has nowhere to write the answer down.

create table if not exists telegram_connection_health (
  user_id      uuid primary key references users(id) on delete cascade,
  ok           boolean     not null default false,
  bot_username text,
  has_chat     boolean     not null default false,
  webhook_ok   boolean     not null default false,
  detail       text,
  checked_at   timestamptz not null default now()
);
