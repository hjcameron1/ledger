-- Per-item net-worth history.
--
-- The Overview "what makes up your net worth" popup needs to show what has
-- CHANGED the most over a chosen timeframe (last day / 7d / month / 6m / year /
-- all). The existing net_worth_history table only stores the *total*, so it can't
-- attribute change to individual accounts/holdings. This table snapshots every
-- contributing item (bank account, investment, super fund, SMSF fund, credit
-- card) on the same forward-only cadence (hourly cron + on-demand on page load),
-- letting us diff each item's value across any window.
--
-- Forward-only: a freshly added item's first snapshot is its baseline, so adding
-- a long-held investment does NOT register as a sudden gain — only movement after
-- it starts being tracked counts (mirrors the net-worth % chart's philosophy).

CREATE TABLE IF NOT EXISTS net_worth_item_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  item_type   text NOT NULL,          -- bank | investment | super | smsf | credit_card
  item_id     text NOT NULL,          -- source row id (stringified)
  name        text NOT NULL,          -- display name at snapshot time
  value       numeric NOT NULL,       -- value in the user's preferred currency
  is_debt     boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_nwih_user_time ON net_worth_item_history (user_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_nwih_user_item ON net_worth_item_history (user_id, item_type, item_id, recorded_at);
