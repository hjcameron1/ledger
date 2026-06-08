-- Authentic per-product precious-metal prices scraped from Australian bullion
-- dealers. A daily cron crawls each dealer's catalogue and upserts a row per
-- product, so the in-depth metal holding form can pull a REAL product price
-- (with the dealer's premium over spot) instead of a manual guess.
--
-- Uniqueness is on (dealer, url) so a re-scrape updates the existing row in place.
CREATE TABLE IF NOT EXISTS metal_products (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  dealer        TEXT          NOT NULL,            -- e.g. "ABC Bullion"
  metal         TEXT          NOT NULL,            -- Gold | Silver | Platinum | Palladium
  form          TEXT,                              -- minted_bar | cast_bar | coin | round | bullion
  weight_grams  DECIMAL(18,6),                     -- normalised to grams for matching
  unit_label    TEXT,                              -- human label as listed, e.g. "5g", "1oz", "1kg"
  product_name  TEXT          NOT NULL,
  url           TEXT          NOT NULL,
  buy_price     DECIMAL(15,2),                     -- price to BUY one unit (incl. premium)
  sell_price    DECIMAL(15,2),                     -- dealer buyback price (NULL until captured)
  spot_value    DECIMAL(15,2),                     -- pure spot value of the metal content
  currency      TEXT          DEFAULT 'AUD',
  in_stock      BOOLEAN       DEFAULT TRUE,
  scraped_at    TIMESTAMPTZ   DEFAULT NOW(),
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (dealer, url)
);

CREATE INDEX IF NOT EXISTS idx_metal_products_lookup ON metal_products(metal, form);
CREATE INDEX IF NOT EXISTS idx_metal_products_dealer ON metal_products(dealer);
