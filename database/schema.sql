-- ============================================================
-- Ledger – Full Database Schema
-- Safe to run multiple times (all statements use IF NOT EXISTS)
-- Run this in: Supabase Dashboard → SQL Editor → New query
-- ============================================================

-- ── Extensions ────────────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── auto-update updated_at helper ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── Users ──────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  id                          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email                       TEXT        UNIQUE NOT NULL,
  name                        TEXT        NOT NULL,
  password_hash               TEXT,
  email_verified              BOOLEAN     DEFAULT FALSE,
  currency_preference         TEXT        DEFAULT 'AUD',
  theme                       TEXT        DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  plan                        TEXT        DEFAULT 'free'  CHECK (plan  IN ('free', 'premium')),
  basiq_user_id               TEXT,
  telegram_chat_id            TEXT,
  telegram_bot_token          TEXT,
  onboarding_complete         BOOLEAN     DEFAULT FALSE,
  financial_year_start        TEXT        DEFAULT '07-01',
  hecs_enabled                BOOLEAN     DEFAULT FALSE,
  include_super_in_investments BOOLEAN    DEFAULT FALSE,
  include_super_in_net_worth  BOOLEAN     DEFAULT TRUE,
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_users_updated_at ON users;
CREATE TRIGGER trg_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Email verification codes ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_verification_codes (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  email      TEXT        NOT NULL,
  code       TEXT        NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_email_verify_email ON email_verification_codes(email, expires_at);

-- ── Bank accounts ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bank_accounts (
  id                  UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID        REFERENCES users(id) ON DELETE CASCADE,
  name                TEXT        NOT NULL,
  institution         TEXT        NOT NULL,
  account_type        TEXT        NOT NULL,
  balance             DECIMAL(15,2) DEFAULT 0,
  bsb                 TEXT,
  account_number      TEXT,
  currency            TEXT        DEFAULT 'AUD',
  basiq_account_id    TEXT,
  is_manual           BOOLEAN     DEFAULT TRUE,
  shared_code         TEXT        UNIQUE,
  shared_password_hash TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_bank_accounts_updated_at ON bank_accounts;
CREATE TRIGGER trg_bank_accounts_updated_at
  BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_bank_accounts_user ON bank_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_bank_accounts_basiq ON bank_accounts(basiq_account_id) WHERE basiq_account_id IS NOT NULL;

-- ── Shared account access ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shared_account_access (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID REFERENCES bank_accounts(id) ON DELETE CASCADE,
  owner_id         UUID REFERENCES users(id),
  accessor_id      UUID REFERENCES users(id),
  permission_level TEXT CHECK (permission_level IN ('view', 'full')),
  status           TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'revoked')),
  failed_attempts  INT  DEFAULT 0,
  created_at       TIMESTAMPTZ DEFAULT NOW()
);

-- ── Credit cards ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS credit_cards (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          REFERENCES users(id) ON DELETE CASCADE,
  name                 TEXT          NOT NULL,
  institution          TEXT          NOT NULL,
  balance_owing        DECIMAL(15,2) DEFAULT 0,
  credit_limit         DECIMAL(15,2) DEFAULT 0,
  minimum_payment      DECIMAL(15,2),
  due_date             DATE,
  currency             TEXT          DEFAULT 'AUD',
  basiq_account_id     TEXT,
  is_manual            BOOLEAN       DEFAULT TRUE,
  last_payment_amount  DECIMAL(15,2),
  last_payment_date    DATE,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);

-- Add payment columns to existing installs (safe no-op if already present)
ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS last_payment_amount DECIMAL(15,2);
ALTER TABLE credit_cards ADD COLUMN IF NOT EXISTS last_payment_date DATE;

DROP TRIGGER IF EXISTS trg_credit_cards_updated_at ON credit_cards;
CREATE TRIGGER trg_credit_cards_updated_at
  BEFORE UPDATE ON credit_cards
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_credit_cards_user ON credit_cards(user_id);

-- ── Transactions ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS transactions (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          REFERENCES users(id) ON DELETE CASCADE,
  account_id           UUID,
  account_type         TEXT          CHECK (account_type IN ('bank', 'credit_card')),
  date                 DATE          NOT NULL,
  merchant             TEXT          NOT NULL,
  amount               DECIMAL(15,2) NOT NULL,
  currency             TEXT          DEFAULT 'AUD',
  category             TEXT,
  notes                TEXT,
  is_duplicate_flagged BOOLEAN       DEFAULT FALSE,
  is_subscription      BOOLEAN       DEFAULT FALSE,
  basiq_tx_id          TEXT,           -- Basiq transaction ID for deduplication
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_transactions_updated_at ON transactions;
CREATE TRIGGER trg_transactions_updated_at
  BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_transactions_user_date   ON transactions(user_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_account      ON transactions(account_id) WHERE account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_basiq_tx_id  ON transactions(basiq_tx_id) WHERE basiq_tx_id IS NOT NULL;

-- ── Subscriptions ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS subscriptions (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID          REFERENCES users(id) ON DELETE CASCADE,
  name             TEXT          NOT NULL,
  original_name    TEXT,
  amount           DECIMAL(15,2) NOT NULL,
  currency         TEXT          DEFAULT 'AUD',
  frequency        TEXT          NOT NULL,
  next_charge_date DATE,
  account_id       UUID,
  category         TEXT,
  is_auto_detected BOOLEAN       DEFAULT FALSE,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

-- Migration: add original_name if upgrading an existing database
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS original_name TEXT;

DROP TRIGGER IF EXISTS trg_subscriptions_updated_at ON subscriptions;
CREATE TRIGGER trg_subscriptions_updated_at
  BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Investments ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investments (
  id                 UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID          REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT          NOT NULL,
  ticker             TEXT,
  market             TEXT          NOT NULL,
  asset_type         TEXT          NOT NULL,
  shares_owned       DECIMAL(18,8) DEFAULT 0,
  cost_basis         DECIMAL(15,2) DEFAULT 0,
  -- Currency the cost_basis is stored in. The user picks this per holding via the
  -- Add/Edit form's AUD↔native toggle. NULL means "same as native_currency"
  -- (legacy rows, where cost was always treated as native). When it equals the
  -- preferred currency the AUD cost stays fixed (true historical cost); when it's
  -- the native currency the displayed cost floats with FX (currency exposure).
  cost_basis_currency TEXT,
  current_price      DECIMAL(18,8) DEFAULT 0,
  current_value      DECIMAL(15,2) DEFAULT 0,
  currency           TEXT          DEFAULT 'AUD',
  native_currency    TEXT          DEFAULT 'AUD',
  -- FX rate (native_currency → display_currency) snapshotted at the last
  -- in-session price refresh, so converted values stay frozen while the
  -- holding's market is closed instead of drifting with live forex.
  conversion_rate    DECIMAL(18,8) DEFAULT 1,
  display_currency   TEXT          DEFAULT 'AUD',
  last_price_update  TIMESTAMPTZ,
  is_dividend_paying BOOLEAN       DEFAULT FALSE,
  created_at         TIMESTAMPTZ   DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_investments_updated_at ON investments;
CREATE TRIGGER trg_investments_updated_at
  BEFORE UPDATE ON investments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_investments_user   ON investments(user_id);
CREATE INDEX IF NOT EXISTS idx_investments_ticker ON investments(ticker) WHERE ticker IS NOT NULL;

-- ── Investment price history ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS investment_price_history (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  investment_id UUID          REFERENCES investments(id) ON DELETE CASCADE,
  price         DECIMAL(18,8) NOT NULL,
  currency      TEXT          NOT NULL,
  recorded_at   TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_price_history_inv ON investment_price_history(investment_id, recorded_at DESC);

-- ── Dividends ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dividends (
  id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  investment_id  UUID          REFERENCES investments(id) ON DELETE CASCADE,
  user_id        UUID          REFERENCES users(id) ON DELETE CASCADE,
  amount         DECIMAL(15,2) NOT NULL,
  currency       TEXT          DEFAULT 'AUD',
  per_share_amount DECIMAL(18,8),
  shares_at_time DECIMAL(18,8),
  franking_credit DECIMAL(15,2) DEFAULT 0,
  payment_date   DATE,
  status         TEXT          DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dividends_user ON dividends(user_id, payment_date DESC);

-- ── Super funds ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS super_funds (
  id                     UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID          REFERENCES users(id) ON DELETE CASCADE,
  fund_name              TEXT          NOT NULL,
  member_number          TEXT,
  balance                DECIMAL(15,2) DEFAULT 0,
  employer_contributions DECIMAL(15,2) DEFAULT 0,
  personal_contributions DECIMAL(15,2) DEFAULT 0,
  investment_option      TEXT,
  insurance_details      TEXT,
  fees                   DECIMAL(15,2) DEFAULT 0,
  performance_data       JSONB,
  include_in_investments BOOLEAN       DEFAULT FALSE,
  include_in_net_worth   BOOLEAN       DEFAULT TRUE,
  last_updated           DATE,
  created_at             TIMESTAMPTZ   DEFAULT NOW(),
  updated_at             TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_super_funds_updated_at ON super_funds;
CREATE TRIGGER trg_super_funds_updated_at
  BEFORE UPDATE ON super_funds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Income entries ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS income_entries (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID          REFERENCES users(id) ON DELETE CASCADE,
  source           TEXT          NOT NULL,
  amount           DECIMAL(15,2) NOT NULL,
  currency         TEXT          DEFAULT 'AUD',
  category         TEXT          NOT NULL,
  frequency        TEXT,
  is_recurring     BOOLEAN       DEFAULT FALSE,
  reference_number TEXT,
  date             DATE          NOT NULL,
  status           TEXT          DEFAULT 'approved' CHECK (status IN ('approved', 'pending')),
  tax_withheld     DECIMAL(15,2) DEFAULT 0,
  super_contribution DECIMAL(15,2) DEFAULT 0,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_income_entries_updated_at ON income_entries;
CREATE TRIGGER trg_income_entries_updated_at
  BEFORE UPDATE ON income_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_income_user_date ON income_entries(user_id, date DESC);

-- ── Tax records ───────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tax_records (
  id                   UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id              UUID          REFERENCES users(id) ON DELETE CASCADE,
  financial_year       TEXT          NOT NULL,
  total_income         DECIMAL(15,2) DEFAULT 0,
  tax_withheld         DECIMAL(15,2) DEFAULT 0,
  estimated_tax_owing  DECIMAL(15,2) DEFAULT 0,
  medicare_levy        DECIMAL(15,2) DEFAULT 0,
  hecs_repayment       DECIMAL(15,2) DEFAULT 0,
  total_deductions     DECIMAL(15,2) DEFAULT 0,
  franking_credits     DECIMAL(15,2) DEFAULT 0,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(user_id, financial_year)
);

DROP TRIGGER IF EXISTS trg_tax_records_updated_at ON tax_records;
CREATE TRIGGER trg_tax_records_updated_at
  BEFORE UPDATE ON tax_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Tax deductions ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tax_deductions (
  id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID          REFERENCES users(id) ON DELETE CASCADE,
  financial_year TEXT          NOT NULL,
  name           TEXT          NOT NULL,
  amount         DECIMAL(15,2) NOT NULL,
  category       TEXT          NOT NULL,
  date           DATE          NOT NULL,
  receipt_url    TEXT,
  created_at     TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tax_deductions_user_year ON tax_deductions(user_id, financial_year);

-- ── Tax brackets ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tax_brackets (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  financial_year   TEXT          NOT NULL,
  min_income       DECIMAL(15,2) NOT NULL,
  max_income       DECIMAL(15,2),
  base_tax         DECIMAL(15,2) DEFAULT 0,
  rate             DECIMAL(6,4)  NOT NULL,
  updated_by_admin TEXT,
  updated_at       TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(financial_year, min_income)
);

-- Seed Australian tax brackets — 2024-25
INSERT INTO tax_brackets (financial_year, min_income, max_income, base_tax, rate) VALUES
  ('2024-25',      0,  18200,      0, 0.0000),
  ('2024-25',  18201,  45000,      0, 0.1900),
  ('2024-25',  45001, 120000,   5092, 0.3250),
  ('2024-25', 120001, 180000,  29467, 0.3700),
  ('2024-25', 180001,   NULL,  51667, 0.4500)
ON CONFLICT (financial_year, min_income) DO NOTHING;

-- Seed Australian tax brackets — 2025-26 (Stage 3 cuts extended)
INSERT INTO tax_brackets (financial_year, min_income, max_income, base_tax, rate) VALUES
  ('2025-26',      0,  18200,      0, 0.0000),
  ('2025-26',  18201,  45000,      0, 0.1900),
  ('2025-26',  45001, 135000,   5092, 0.3000),
  ('2025-26', 135001, 190000,  31892, 0.3700),
  ('2025-26', 190001,   NULL,  52392, 0.4500)
ON CONFLICT (financial_year, min_income) DO NOTHING;

-- ── Bills ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS bills (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID          REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT          NOT NULL,
  amount          DECIMAL(15,2) NOT NULL,
  due_date        DATE          NOT NULL,
  is_recurring    BOOLEAN       DEFAULT FALSE,
  frequency       TEXT,
  colour          TEXT          DEFAULT 'grey' CHECK (colour IN ('grey', 'yellow', 'red')),
  is_paid         BOOLEAN       DEFAULT FALSE,
  paid_at         DATE,
  subscription_id UUID,
  calendar_synced BOOLEAN       DEFAULT FALSE,
  created_at      TIMESTAMPTZ   DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   DEFAULT NOW()
);

ALTER TABLE bills ADD COLUMN IF NOT EXISTS paid_at DATE;
-- Stable link from a bill to the subscription whose "Also in bills & reminders"
-- toggle created it. Identity-based so renames / re-adds never break the link.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS subscription_id UUID;
-- The bill's first/import name, preserved the first time the user renames it.
-- Lets us recognise a re-imported original-named bill as a duplicate of one the
-- user already renamed (e.g. "Direct Debit 507156 GLOFOXPAYMENT" → "Gym").
ALTER TABLE bills ADD COLUMN IF NOT EXISTS original_name TEXT;
-- Bill vs reminder: a 'bill' is payable (amount + tick-to-pay); a 'reminder' is a
-- date nudge where the amount is optional. Older rows default to 'bill'.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS kind TEXT DEFAULT 'bill';
-- Spending category for recurring items (Bills, Credit Card, Transfers, …),
-- prefilled from a linked bank subscription's category when one exists.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS category TEXT;
-- Canonical series values for a recurring item, snapshotted when a single
-- occurrence is edited "just this once" so the next occurrence reverts to them.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS recurring_template JSONB;

DROP TRIGGER IF EXISTS trg_bills_updated_at ON bills;
CREATE TRIGGER trg_bills_updated_at
  BEFORE UPDATE ON bills
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_bills_user_due ON bills(user_id, due_date) WHERE is_paid = FALSE;

-- ── Goals ─────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS goals (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID          REFERENCES users(id) ON DELETE CASCADE,
  name              TEXT          NOT NULL,
  target_amount     DECIMAL(15,2) NOT NULL,
  current_amount    DECIMAL(15,2) DEFAULT 0,
  target_date       DATE,
  linked_account_id UUID,
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_goals_updated_at ON goals;
CREATE TRIGGER trg_goals_updated_at
  BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Budgets ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budgets (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID          REFERENCES users(id) ON DELETE CASCADE,
  category         TEXT          NOT NULL,
  limit_amount     DECIMAL(15,2) NOT NULL,
  period           TEXT          DEFAULT 'monthly' CHECK (period IN ('weekly', 'monthly', 'yearly')),
  rollover_enabled BOOLEAN       DEFAULT FALSE,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_budgets_updated_at ON budgets;
CREATE TRIGGER trg_budgets_updated_at
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Notifications ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT        NOT NULL,
  message    TEXT        NOT NULL,
  is_read    BOOLEAN     DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

-- ── Telegram conversations ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS telegram_conversations (
  id         UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID        REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT        CHECK (role IN ('user', 'assistant')),
  message    TEXT        NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telegram_user ON telegram_conversations(user_id, created_at DESC);

-- ── Exchange rates ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS exchange_rates (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  from_currency TEXT          NOT NULL,
  to_currency   TEXT          NOT NULL,
  rate          DECIMAL(18,8) NOT NULL,
  date          DATE          NOT NULL,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(from_currency, to_currency, date)
);

CREATE INDEX IF NOT EXISTS idx_exchange_rates ON exchange_rates(from_currency, to_currency, date DESC);

-- ── Pending payments ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pending_payments (
  id                        UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                   UUID          REFERENCES users(id) ON DELETE CASCADE,
  credit_card_id            UUID          REFERENCES credit_cards(id) ON DELETE CASCADE,
  bank_account_id           UUID          REFERENCES bank_accounts(id),
  amount                    DECIMAL(15,2) NOT NULL,
  status                    TEXT          DEFAULT 'pending' CHECK (status IN ('pending', 'reconciled')),
  reconciled_transaction_id UUID,
  created_at                TIMESTAMPTZ   DEFAULT NOW(),
  updated_at                TIMESTAMPTZ   DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_pending_payments_updated_at ON pending_payments;
CREATE TRIGGER trg_pending_payments_updated_at
  BEFORE UPDATE ON pending_payments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_pending_payments_card ON pending_payments(credit_card_id, status);

ALTER TABLE pending_payments ENABLE ROW LEVEL SECURITY;

-- ── Net worth history ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS net_worth_history (
  id            UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id       UUID          REFERENCES users(id) ON DELETE CASCADE,
  total_value   DECIMAL(15,2) NOT NULL,
  recorded_date DATE          NOT NULL,
  created_at    TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE(user_id, recorded_date)
);

CREATE INDEX IF NOT EXISTS idx_net_worth_user ON net_worth_history(user_id, recorded_date DESC);

-- ── Row Level Security ────────────────────────────────────────────────────────
-- The backend uses the service_role key which bypasses RLS entirely.
-- These policies allow direct Supabase client access in future (e.g. mobile app).

ALTER TABLE users                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE bank_accounts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_cards           ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions           ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE investments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE super_funds            ENABLE ROW LEVEL SECURITY;
ALTER TABLE income_entries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_records            ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_deductions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE bills                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE goals                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications          ENABLE ROW LEVEL SECURITY;
ALTER TABLE dividends              ENABLE ROW LEVEL SECURITY;
ALTER TABLE net_worth_history      ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_conversations ENABLE ROW LEVEL SECURITY;

-- Service-role bypass (explicit, for clarity — service_role always bypasses RLS)
-- No policies needed for service_role; the backend handles all auth.

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Tables created: users, email_verification_codes, bank_accounts,
--   shared_account_access, credit_cards, transactions, subscriptions,
--   investments, investment_price_history, dividends, super_funds,
--   income_entries, tax_records, tax_deductions, tax_brackets,
--   bills, goals, budgets, notifications, telegram_conversations,
--   exchange_rates, net_worth_history
-- Total: 22 tables
