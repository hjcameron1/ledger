-- Link an in-depth precious-metal holding to the specific scraped dealer product
-- it represents. When set, the holding is valued from THAT product's dealer
-- buyback (sell_price ÷ weight_grams, native AUD) instead of the generic Yahoo
-- metal spot + FX — so Ledger's figure matches what the dealer's own site shows.
-- Nullable: generic metal holdings (no product picked) leave it NULL and keep
-- valuing at live spot.
ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS metal_product_id UUID REFERENCES metal_products(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_investments_metal_product ON investments(metal_product_id);
