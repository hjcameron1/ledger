-- ── Phase 4.2 — mortgage / debt engine ───────────────────────────────────────
-- Run this in the Supabase SQL editor. Idempotent: safe to re-run.
--
-- There is NO mortgage table here, and deliberately so. Phase 4.1 made a
-- property point at a row in `loans` instead of storing a mortgage of its own,
-- and this phase keeps that promise by EXTENDING the same row. A property-linked
-- mortgage and the loan it links to are one record, so a projection can never
-- disagree with a balance and a debt can never be counted twice.
--
-- Three balances, kept apart on purpose:
--   current_balance   what is OWED — the only figure net worth reads
--   offset_balance    cash reducing the INTEREST CHARGED, never the debt (that
--                     money is already an asset in the user's bank account)
--   redraw_available  extra repayments that could be pulled back — re-borrowing
--                     capacity, not cash, so it never reaches net worth either

ALTER TABLE loans
  -- Rate story. A fixed loan reverts to `revert_rate` when `fixed_until` passes,
  -- which is what stops a five-year fixed projection quietly running for thirty.
  ADD COLUMN IF NOT EXISTS rate_type           TEXT          DEFAULT 'variable',
  ADD COLUMN IF NOT EXISTS fixed_until         DATE,
  ADD COLUMN IF NOT EXISTS revert_rate         DECIMAL(6,3),
  -- Interest-only: nothing comes off the principal until this date.
  ADD COLUMN IF NOT EXISTS interest_only_until DATE,
  -- Contracted term, used with start_date when there is no end_date on file.
  ADD COLUMN IF NOT EXISTS term_months         INTEGER,
  ADD COLUMN IF NOT EXISTS offset_balance      DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- When set, the linked account's LIVE balance is the offset, so the interest
  -- figure moves when the account does. ON DELETE SET NULL: closing the account
  -- must not delete the mortgage.
  ADD COLUMN IF NOT EXISTS offset_account_id   UUID REFERENCES bank_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS extra_repayment     DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS redraw_available    DECIMAL(15,2) NOT NULL DEFAULT 0;

-- Only 'variable' or 'fixed'. Added separately (and dropped first) so re-running
-- this file can't fail on an already-present constraint.
ALTER TABLE loans DROP CONSTRAINT IF EXISTS loans_rate_type_check;
ALTER TABLE loans ADD CONSTRAINT loans_rate_type_check
  CHECK (rate_type IS NULL OR rate_type IN ('variable', 'fixed'));

-- ── loan_events ──────────────────────────────────────────────────────────────
-- The audit trail of what MOVED a loan: repayments (including partial ones),
-- extra repayments, redraws and rate changes.
--
-- The loan's `current_balance` stays the authoritative debt — banks report it
-- and Basiq syncs it — so these rows record what happened rather than being the
-- ledger the balance is derived from. That is what keeps a Basiq-synced balance
-- and a manually recorded repayment from fighting over the same number.
--
-- ON DELETE CASCADE: deleting a loan takes its history with it. The rows have no
-- meaning without the loan, and an orphan would be invisible but still stored.
CREATE TABLE IF NOT EXISTS loan_events (
  id         UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID          REFERENCES users(id) ON DELETE CASCADE,
  loan_id    UUID          NOT NULL REFERENCES loans(id) ON DELETE CASCADE,
  kind       TEXT          NOT NULL
               CHECK (kind IN ('repayment', 'extra_repayment', 'redraw', 'rate_change')),
  -- Always positive; `kind` says which way the money went. 0 for a rate change.
  amount     DECIMAL(15,2) NOT NULL DEFAULT 0,
  -- The new annual rate, for rate_change only.
  rate       DECIMAL(6,3),
  -- May be in the FUTURE for a rate change the user already knows is coming.
  date       DATE          NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ   DEFAULT NOW(),
  updated_at TIMESTAMPTZ   DEFAULT NOW()
);

-- The backend uses the service-role key and scopes every query by user_id;
-- enabling RLS denies direct anon/authenticated access. Mirrors every table here.
ALTER TABLE loan_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_loan_events_user ON loan_events(user_id);
CREATE INDEX IF NOT EXISTS idx_loan_events_loan ON loan_events(loan_id);

DROP TRIGGER IF EXISTS trg_loan_events_updated_at ON loan_events;
CREATE TRIGGER trg_loan_events_updated_at
  BEFORE UPDATE ON loan_events
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
