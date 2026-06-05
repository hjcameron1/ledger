-- Adds fields parsed from uploaded superannuation statements so they can be
-- pre-filled, reviewed and saved. All amounts are AUD.
ALTER TABLE super_funds
  ADD COLUMN IF NOT EXISTS member_number     TEXT,
  ADD COLUMN IF NOT EXISTS insurance_details TEXT,
  ADD COLUMN IF NOT EXISTS fees              DECIMAL(15,2) DEFAULT 0;
