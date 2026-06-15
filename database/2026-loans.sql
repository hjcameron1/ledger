-- ── Loans / debt tracking ─────────────────────────────────────────────────────
-- Run this in the Supabase SQL editor.

CREATE TABLE IF NOT EXISTS loans (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT          NOT NULL,
  loan_type            TEXT          NOT NULL DEFAULT 'personal'
                         CHECK (loan_type IN ('mortgage', 'personal', 'car', 'hecs')),
  lender               TEXT,
  original_amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
  current_balance      DECIMAL(15,2) NOT NULL DEFAULT 0,
  interest_rate        DECIMAL(6,3),
  minimum_repayment    DECIMAL(15,2),
  repayment_frequency  TEXT          DEFAULT 'monthly'
                         CHECK (repayment_frequency IN ('weekly', 'fortnightly', 'monthly')),
  next_due_date        DATE,
  start_date           DATE,
  end_date             DATE,
  notes                TEXT,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);

-- Users may only see their own loans. The backend uses the service-role key
-- (which bypasses RLS) and scopes every query by user_id; enabling RLS denies
-- all direct anon/authenticated access. This mirrors every other table here.
ALTER TABLE loans ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_loans_updated_at ON loans;
CREATE TRIGGER trg_loans_updated_at
  BEFORE UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);

-- Stable link from an auto-created "<loan> repayment" bill back to its loan, so
-- editing/deleting a loan can find and update/remove the mirrored bill.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS loan_id UUID;
