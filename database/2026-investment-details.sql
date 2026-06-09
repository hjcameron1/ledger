-- Flexible per-holding metadata for non-market asset types (bonds, art, wine,
-- jewellery, etc.). Market assets (stocks/ETFs/crypto/metals) leave this null and
-- keep using their dedicated columns. Collectibles reuse shares_owned×current_price
-- for valuation (so portfolio/net-worth math is unchanged) and stash their extra
-- fields here.
ALTER TABLE investments ADD COLUMN IF NOT EXISTS details JSONB;
