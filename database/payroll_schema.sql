-- ============================================================================
-- Payroll: payslips + expected (pending) employer super contributions ledger
-- ============================================================================
-- Two user-scoped tables, mirroring the SMSF feature's conventions:
--   * user_id references users(id) (the app's custom-auth users table — NOT
--     auth.users; the app mints its own uuid via custom JWT, so a FK to
--     auth.users would break every backend insert).
--   * RLS enabled with an owner-only policy. The backend uses the service_role
--     key (which bypasses RLS) and filters by user_id manually, but the policies
--     are here so any future direct/mobile client is safe by default.
-- Run this in the Supabase SQL editor.

-- ── Payslips ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payslips (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employer            TEXT NOT NULL,
  abn                 TEXT,
  employee_name       TEXT,
  -- full_time | part_time | casual | contractor
  employment_type     TEXT NOT NULL DEFAULT 'full_time',
  pay_period_start    DATE,
  pay_period_end      DATE,
  payment_date        DATE,
  -- weekly | fortnightly | monthly
  pay_frequency       TEXT NOT NULL DEFAULT 'fortnightly',
  gross_pay           DECIMAL(15,2) NOT NULL DEFAULT 0,
  net_pay             DECIMAL(15,2) NOT NULL DEFAULT 0,
  tax_withheld        DECIMAL(15,2) NOT NULL DEFAULT 0,
  super_amount        DECIMAL(15,2) NOT NULL DEFAULT 0,
  super_rate          DECIMAL(6,3),                 -- e.g. 11.500 (percent)
  ytd_gross           DECIMAL(15,2),
  ytd_tax             DECIMAL(15,2),
  ytd_super           DECIMAL(15,2),
  leave_balance       DECIMAL(10,2),                -- annual / holiday leave hours
  sick_leave_balance  DECIMAL(10,2),
  hourly_rate         DECIMAL(10,2),
  allowances          JSONB DEFAULT '[]'::jsonb,    -- [{ "name": "...", "amount": 0 }]
  deductions          JSONB DEFAULT '[]'::jsonb,    -- [{ "name": "...", "amount": 0 }]
  -- For alternating pay cycles: 'A' or 'B' (null when not alternating).
  cycle_label         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payslips_user      ON payslips(user_id);
CREATE INDEX IF NOT EXISTS idx_payslips_user_paid ON payslips(user_id, payment_date DESC);

-- ── Expected (pending) employer super contributions ledger ──────────────────
-- One row per payslip's employer super amount. Super Guarantee is paid quarterly
-- in Australia, so each row carries the quarter it relates to and that quarter's
-- statutory due date. Rows start 'pending' and move to 'matched' once a super
-- fund statement reconciles them.
CREATE TABLE IF NOT EXISTS expected_super_contributions (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payslip_id            UUID REFERENCES payslips(id) ON DELETE CASCADE,
  employer              TEXT NOT NULL,
  amount                DECIMAL(15,2) NOT NULL DEFAULT 0,
  pay_period_start      DATE,
  pay_period_end        DATE,
  expected_payment_date DATE,                       -- quarterly SG due date
  quarter               TEXT,                       -- e.g. '2025-Q3'
  financial_year        TEXT,                       -- e.g. '2025-26'
  -- pending | matched
  status                TEXT NOT NULL DEFAULT 'pending',
  matched_on            DATE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_expected_super_user        ON expected_super_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_expected_super_user_status ON expected_super_contributions(user_id, status);

-- ── updated_at triggers (set_updated_at() is defined in schema.sql) ──────────
DROP TRIGGER IF EXISTS trg_payslips_updated ON payslips;
CREATE TRIGGER trg_payslips_updated BEFORE UPDATE ON payslips
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DROP TRIGGER IF EXISTS trg_expected_super_updated ON expected_super_contributions;
CREATE TRIGGER trg_expected_super_updated BEFORE UPDATE ON expected_super_contributions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Row Level Security: owner-only ──────────────────────────────────────────
ALTER TABLE payslips                     ENABLE ROW LEVEL SECURITY;
ALTER TABLE expected_super_contributions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS payslips_owner ON payslips;
CREATE POLICY payslips_owner ON payslips
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS expected_super_owner ON expected_super_contributions;
CREATE POLICY expected_super_owner ON expected_super_contributions
  FOR ALL USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
