-- Precise precious-metal holdings.
--
-- Generic mode (metal_detailed = FALSE): value tracks the live spot price for the
-- metal, converted from USD/troy-oz into the holding's weight unit and the owner's
-- preferred currency on the hourly price cron — exactly like a listed holding.
--
-- In-depth mode (metal_detailed = TRUE): the user records a SPECIFIC physical
-- product (e.g. a Perth Mint 5g minted bar) whose price carries a product premium
-- over spot and differs by form/mint. There is no public feed for those, so the
-- buy/sell prices are entered manually and never auto-overwritten by the cron;
-- current_price (the per-unit valuation) tracks metal_sell_price (what you'd get).
ALTER TABLE investments
  ADD COLUMN IF NOT EXISTS metal_unit       TEXT,              -- grams | ounces | kg
  ADD COLUMN IF NOT EXISTS metal_form       TEXT,              -- generic | minted_bar | cast_bar | coin | bullion | round
  ADD COLUMN IF NOT EXISTS metal_mint       TEXT,              -- e.g. "Perth Mint", "ABC Bullion"
  ADD COLUMN IF NOT EXISTS metal_detailed   BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS metal_buy_price  DECIMAL(18,8),     -- per-unit buy price (informational)
  ADD COLUMN IF NOT EXISTS metal_sell_price DECIMAL(18,8);     -- per-unit sell price (drives valuation)
