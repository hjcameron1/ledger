-- Link a goal to a bank/savings account and allocate a share of that account's
-- balance toward the goal — either a percentage or a fixed dollar amount.
--   link_type  = 'percent' → link_value is a % (0–100) of the account balance
--   link_type  = 'amount'  → link_value is a fixed $ amount (capped at balance)
-- linked_account_id already exists on goals.
ALTER TABLE goals ADD COLUMN IF NOT EXISTS link_type  TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS link_value DECIMAL(15,2);
