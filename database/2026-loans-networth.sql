-- Loans: per-loan toggle for whether the balance counts toward net worth.
-- Defaults to TRUE (a loan is debt and should reduce net worth by default);
-- the user can turn it off per loan to keep it out of the net-worth total while
-- it still shows in the Loans list.
ALTER TABLE loans
  ADD COLUMN IF NOT EXISTS include_in_net_worth BOOLEAN NOT NULL DEFAULT TRUE;
