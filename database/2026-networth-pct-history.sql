-- Net-worth % change chart + SMSF net-worth inclusion.
--
-- 1) Intraday net-worth snapshots. The existing net_worth_history table stored
--    one row per day (recorded_date). For the Overview % chart we want the same
--    Daily/Weekly/Monthly/Yearly/All-time behaviour as the Investments page, so
--    we add a full timestamp and snapshot hourly via cron (+ on demand on load).
ALTER TABLE net_worth_history
  ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS idx_nwh_user_time
  ON net_worth_history (user_id, recorded_at);

-- 2) Let each SMSF fund opt in/out of net worth, exactly like regular super_funds.
ALTER TABLE smsf_funds
  ADD COLUMN IF NOT EXISTS include_in_net_worth boolean NOT NULL DEFAULT true;
