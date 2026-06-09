-- Realised disposals of investments (any asset type). One row per sale (partial or
-- full). Drives the financial-year capital-gains / CGT summary. Kept independent of
-- the investments row (no FK) so a sale survives even if the holding is later removed.
CREATE TABLE IF NOT EXISTS investment_sales (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID          REFERENCES users(id) ON DELETE CASCADE,
  investment_id     UUID,                          -- soft link; not enforced
  name              TEXT          NOT NULL,
  ticker            TEXT,
  asset_type        TEXT,
  market            TEXT,
  quantity          DECIMAL(18,8) NOT NULL,         -- units sold
  proceeds          DECIMAL(15,2) NOT NULL,         -- total sale proceeds (preferred currency)
  fees              DECIMAL(15,2) DEFAULT 0,         -- brokerage / selling costs
  cost_basis        DECIMAL(15,2) NOT NULL,         -- cost attributed to the sold units (preferred)
  acquired_date     DATE,
  sale_date         DATE          NOT NULL,
  gain              DECIMAL(15,2) NOT NULL,         -- proceeds - fees - cost_basis
  held_days         INTEGER,
  discount_eligible BOOLEAN       DEFAULT FALSE,    -- held > 12 months AND gain > 0
  currency          TEXT          DEFAULT 'AUD',
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_investment_sales_user ON investment_sales(user_id);
CREATE INDEX IF NOT EXISTS idx_investment_sales_date ON investment_sales(sale_date);
