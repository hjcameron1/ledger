-- Portfolio P&L % history.
-- Forward-only snapshots: one row each time the hourly price cron runs (and on
-- demand when the Investments page loads if the latest row is stale). Each row
-- stores the whole-portfolio totals in the user's preferred currency so the
-- percentage can be recomputed/displayed without re-deriving cost basis.
--
-- "Daily" view uses the intraday (hourly) rows; weekly/monthly/yearly/all-time
-- views down-sample to one point per day. History begins the first time a
-- snapshot is taken after the user adds holdings — there is no backfill.

CREATE TABLE IF NOT EXISTS portfolio_pl_history (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  pl_percent  numeric NOT NULL,
  pl_value    numeric NOT NULL,
  total_value numeric NOT NULL,
  total_cost  numeric NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pl_history_user_time
  ON portfolio_pl_history (user_id, recorded_at);
