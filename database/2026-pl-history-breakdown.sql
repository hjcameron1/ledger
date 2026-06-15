-- Per-investment breakdown for the portfolio P&L history line.
-- Each snapshot row now records what every individual holding contributed to that
-- point: { "<investment_id>": { "v": value, "c": cost } } in the user's preferred
-- currency. This lets a *deleted* investment be cleanly subtracted out of every
-- point recorded after this migration (forward-only) — while a *sold* holding stays
-- baked into history (the sale path skips the purge).
ALTER TABLE portfolio_pl_history
  ADD COLUMN IF NOT EXISTS breakdown JSONB NOT NULL DEFAULT '{}'::jsonb;
