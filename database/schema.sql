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
  theme                       TEXT        DEFAULT 'system' CHECK (theme IN ('light', 'dark', 'system')),
  plan                        TEXT        DEFAULT 'free'  CHECK (plan  IN ('free', 'premium')),
  basiq_user_id               TEXT,
  telegram_chat_id            TEXT,
  telegram_bot_token          TEXT,
  onboarding_complete         BOOLEAN     DEFAULT FALSE,
  financial_year_start        TEXT        DEFAULT '07-01',
  hecs_enabled                BOOLEAN     DEFAULT FALSE,
  include_super_in_investments BOOLEAN    DEFAULT FALSE,
  include_super_in_net_worth  BOOLEAN     DEFAULT TRUE,
  ui_preferences              JSONB,
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
  hidden              BOOLEAN     NOT NULL DEFAULT FALSE,
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
  is_duplicate_flagged BOOLEAN       DEFAULT FALSE,   -- LEGACY (Phase 2A): unused, kept for back-compat
  is_subscription      BOOLEAN       DEFAULT FALSE,
  basiq_tx_id          TEXT,           -- Basiq transaction ID for deduplication
  -- ── Phase 2A: Transaction Foundation (see 2026-transaction-foundation.sql) ──
  source               TEXT          CHECK (source IS NULL OR source IN ('basiq','statement','manual','unknown')),
  source_ref           TEXT,           -- source system's own id (generalises basiq_tx_id)
  raw_description      TEXT,           -- original untouched source description — never overwritten
  merchant_normalized  TEXT,           -- normaliseMerchant() key for grouping/matching
  is_transfer          BOOLEAN       DEFAULT FALSE,
  transfer_pair_id     UUID,           -- shared id linking the two legs of an internal transfer
  review_status        TEXT          DEFAULT 'clear' CHECK (review_status IS NULL OR review_status IN ('clear','needs_review','reviewed')),
  confidence           NUMERIC(4,3)  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  category_source      TEXT          CHECK (category_source IS NULL OR category_source IN ('auto','basiq','user','rule','merchant','ai')),
  content_hash         TEXT,           -- deterministic dedup identity
  transaction_type     TEXT          CHECK (transaction_type IS NULL OR transaction_type IN ('purchase','refund','income','transfer','fee','interest','other')),
  tags                 TEXT[],
  is_tax_deductible    BOOLEAN       DEFAULT FALSE,
  deduction_category   TEXT,
  entity               TEXT,
  -- ── Phase 2D.1: tax metadata (see 2026-transaction-2d.sql) ──
  tax_note             TEXT,           -- free-text explanation of the tax treatment
  receipt_ref          TEXT,           -- receipt / evidence reference (URL, file id or note)
  -- ── Phase 2B: resolved merchant link (see 2026-merchant-rules.sql) ──
  merchant_id          TEXT,           -- merchants.id uuid OR synthetic 'seed:*' id (TEXT, no FK)
  -- ── Phase 2C: refund link + review reason + recurring link (see 2026-transaction-2c.sql) ──
  refund_of            TEXT,           -- id of the purchase this refund reverses (TEXT, no FK: may be a temp local id pre-sync)
  review_reason        TEXT,           -- e.g. 'possible_refund' | 'ambiguous_duplicate' | 'uncertain_merchant'
  recurring_series_id  TEXT,           -- link to a persisted recurring_series (TEXT, no FK)
  -- ── Phase 2D.3: AI-suggestion fallback metadata (see 2026-transaction-2d3.sql) ──
  ai_suggested_category         TEXT,  -- category Claude proposed when deterministic rules failed
  ai_suggested_merchant         TEXT,  -- cleaned display merchant Claude proposed
  ai_suggested_transaction_type TEXT,  -- purchase|refund|income|... Claude proposed
  ai_suggested_reason           TEXT,  -- short human note on why / what to check
  ai_confidence        NUMERIC(4,3)  CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)),
  ai_classified_at     TIMESTAMPTZ,    -- set once Claude answered; guard against re-asking (no repeated AI calls)
  -- ── Manual ↔ bank-sync reconciliation (see 2026-transaction-reconcile.sql) ──
  reconcile_state      TEXT,           -- pending | kept | conflict | resolved (NULL = n/a)
  reconcile_match_id   UUID,           -- Basiq txn this manual one may duplicate (state=conflict)
  reconcile_checked_at TIMESTAMPTZ,    -- last time the user deferred ("check again next sync")
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

-- ── Phase 2A: Transaction Foundation — idempotent patch for EXISTING tables ────
-- The columns above are only created on a fresh install (CREATE TABLE IF NOT
-- EXISTS is a no-op on an existing table), so these ALTERs bring a live database
-- up to date. All are IF NOT EXISTS / harmless no-ops on a fresh install.
-- (Mirrors database/2026-transaction-foundation.sql.)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source               TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_ref           TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS raw_description      TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_normalized  TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_transfer          BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_pair_id     UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_status        TEXT DEFAULT 'clear';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confidence           NUMERIC(4,3);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_source      TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS content_hash         TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_type     TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tags                 TEXT[];
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_tax_deductible    BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deduction_category   TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS entity               TEXT;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_source_check
  CHECK (source IS NULL OR source IN ('basiq','statement','manual','unknown'));
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_review_status_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_review_status_check
  CHECK (review_status IS NULL OR review_status IN ('clear','needs_review','reviewed'));
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_confidence_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_confidence_check
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_category_source_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_category_source_check
  CHECK (category_source IS NULL OR category_source IN ('auto','basiq','user','rule','merchant','ai'));
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IS NULL OR transaction_type IN
    ('purchase','refund','income','transfer','fee','interest','other'));

-- Safe backfill: Basiq rows are unambiguous; everything else stays 'unknown'.
UPDATE transactions SET source = 'basiq', source_ref = COALESCE(source_ref, basiq_tx_id)
 WHERE basiq_tx_id IS NOT NULL AND (source IS NULL OR source <> 'basiq');
UPDATE transactions SET source = 'unknown'
 WHERE source IS NULL AND basiq_tx_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_content_hash   ON transactions(user_id, content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_transfer_pair  ON transactions(transfer_pair_id) WHERE transfer_pair_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_source_ref     ON transactions(user_id, source, source_ref) WHERE source_ref IS NOT NULL;

-- ── Phase 2B merchant link + Phase 2C refund/review + reconcile — idempotent patch
-- Brings a live database (created before these phases) up to date. All harmless
-- no-ops on a fresh install. Mirrors 2026-merchant-rules.sql, 2026-transaction-2c.sql
-- and 2026-transaction-reconcile.sql. Without refund_of / review_reason the refund
-- write is rejected (PGRST204) and parks in the offline sync queue.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_id          TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_of            TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_reason        TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurring_series_id  TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reconcile_state      TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reconcile_match_id   UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reconcile_checked_at TIMESTAMPTZ;
-- Phase 2D.1 tax metadata (mirrors 2026-transaction-2d.sql). is_tax_deductible /
-- deduction_category / entity were already added by the Phase 2A block above.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tax_note             TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS receipt_ref          TEXT;
-- Phase 2D.3 AI-suggestion fallback metadata (mirrors 2026-transaction-2d3.sql).
-- category_source='ai' is already permitted by the Phase 2A check above.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_category         TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_merchant         TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_transaction_type TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_reason           TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_confidence                 NUMERIC(4,3);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_classified_at              TIMESTAMPTZ;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_ai_confidence_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_ai_confidence_check
  CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1));
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_id       ON transactions(user_id, merchant_id) WHERE merchant_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_refund_of         ON transactions(user_id, refund_of) WHERE refund_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_recurring_series  ON transactions(user_id, recurring_series_id) WHERE recurring_series_id IS NOT NULL;

-- Persisted recurring relationships (confirm/dismiss survive across devices).
CREATE TABLE IF NOT EXISTS recurring_series (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id            TEXT,
  merchant_normalized    TEXT NOT NULL,
  name                   TEXT NOT NULL,
  original_name          TEXT,
  kind                   TEXT NOT NULL DEFAULT 'other'    CHECK (kind IN ('subscription','bill','income','loan_repayment','investment_contribution','other')),
  frequency              TEXT NOT NULL DEFAULT 'monthly',
  expected_amount        NUMERIC,
  last_transaction_date  DATE,
  next_expected_date     DATE,
  account_id             UUID,
  status                 TEXT NOT NULL DEFAULT 'active'   CHECK (status IN ('active','dismissed','ended')),
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_series_user_key    ON recurring_series(user_id, merchant_normalized, frequency);
CREATE INDEX IF NOT EXISTS        idx_recurring_series_user_status ON recurring_series(user_id, status);

-- Splits ONE transaction across multiple categories (positive magnitudes summing
-- to ABS(parent amount)); reporting uses the split lines instead of the parent.
CREATE TABLE IF NOT EXISTS transaction_splits (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  amount          NUMERIC NOT NULL,
  notes           TEXT,
  tags            TEXT[],
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_transaction_splits_txn  ON transaction_splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_splits_user ON transaction_splits(user_id);

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
  -- Purchase date. Used to convert a foreign-currency cost at the FX rate that
  -- applied on that date (so the locked cost matches what was actually paid), and
  -- to drive CGT 12-month-discount eligibility on disposal.
  acquired_date      DATE,
  -- % price move since the previous market close (today's change), from Yahoo.
  day_change_percent NUMERIC,
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
  -- Flexible metadata for collectible/non-market types (bond, art, wine, jewellery).
  -- Market assets leave this NULL; collectibles reuse shares_owned×current_price for
  -- valuation and stash their extra fields (artist, region, maturity_date, …) here.
  details            JSONB,
  created_at         TIMESTAMPTZ   DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   DEFAULT NOW()
);

ALTER TABLE investments ADD COLUMN IF NOT EXISTS details JSONB;
ALTER TABLE investments ADD COLUMN IF NOT EXISTS acquired_date DATE;
ALTER TABLE investments ADD COLUMN IF NOT EXISTS day_change_percent NUMERIC;

-- Realised disposals (any asset type); drives the FY capital-gains / CGT summary.
CREATE TABLE IF NOT EXISTS investment_sales (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID          REFERENCES users(id) ON DELETE CASCADE,
  investment_id     UUID,
  name              TEXT          NOT NULL,
  ticker            TEXT,
  asset_type        TEXT,
  market            TEXT,
  quantity          DECIMAL(18,8) NOT NULL,
  proceeds          DECIMAL(15,2) NOT NULL,
  fees              DECIMAL(15,2) DEFAULT 0,
  cost_basis        DECIMAL(15,2) NOT NULL,
  acquired_date     DATE,
  sale_date         DATE          NOT NULL,
  gain              DECIMAL(15,2) NOT NULL,
  held_days         INTEGER,
  discount_eligible BOOLEAN       DEFAULT FALSE,
  currency          TEXT          DEFAULT 'AUD',
  created_at        TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_investment_sales_user ON investment_sales(user_id);
CREATE INDEX IF NOT EXISTS idx_investment_sales_date ON investment_sales(sale_date);

-- ── Regular investment plans ──────────────────────────────────────────────────
-- A recurring contribution the user makes (e.g. $100/week into VAS). Optionally
-- links to a holding (investment_id) and/or a detected auto-payment
-- (subscription_id). Creating a plan also spawns a recurring reminder in `bills`
-- (bill_id). next_date is the next expected contribution; last_contributed_on is
-- the cycle the user last confirmed/skipped, used to drive the "did you invest?"
-- confirmation popup so it never nags twice for the same cycle.
CREATE TABLE IF NOT EXISTS investment_plans (
  id                 UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID          REFERENCES users(id) ON DELETE CASCADE,
  name               TEXT          NOT NULL,
  amount             DECIMAL(15,2) NOT NULL,
  currency           TEXT          DEFAULT 'AUD',
  frequency          TEXT          NOT NULL, -- weekly|fortnightly|monthly|quarterly|annually
  next_date          DATE          NOT NULL,
  investment_id      UUID          REFERENCES investments(id)   ON DELETE SET NULL,
  subscription_id    UUID          REFERENCES subscriptions(id) ON DELETE SET NULL,
  bill_id            UUID          REFERENCES bills(id)         ON DELETE SET NULL,
  is_active          BOOLEAN       DEFAULT TRUE,
  last_contributed_on DATE,
  created_at         TIMESTAMPTZ   DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_investment_plans_user ON investment_plans(user_id);

DROP TRIGGER IF EXISTS trg_investment_plans_updated_at ON investment_plans;
CREATE TRIGGER trg_investment_plans_updated_at
  BEFORE UPDATE ON investment_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE investment_plans ENABLE ROW LEVEL SECURITY;

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
-- Per-item lead time: days before due_date the item surfaces on the overview.
-- Null → use the user's base lead-time setting.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS lead_days INT;
-- Per-bill Telegram reminders: array of { id, offset_days, time, last_sent }.
-- Each fires as a standalone Telegram message at (due_date − offset_days) @ time
-- in the user's timezone; recurring bills carry the array forward (last_sent reset).
ALTER TABLE bills ADD COLUMN IF NOT EXISTS reminders JSONB NOT NULL DEFAULT '[]'::jsonb;

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
  link_type         TEXT,
  link_value        DECIMAL(15,2),
  linked_sources    JSONB,
  include_in_briefing BOOLEAN     DEFAULT TRUE,
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);
ALTER TABLE goals ADD COLUMN IF NOT EXISTS link_type  TEXT;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS link_value DECIMAL(15,2);
ALTER TABLE goals ADD COLUMN IF NOT EXISTS linked_sources JSONB;
ALTER TABLE goals ADD COLUMN IF NOT EXISTS include_in_briefing BOOLEAN DEFAULT TRUE;

DROP TRIGGER IF EXISTS trg_goals_updated_at ON goals;
CREATE TRIGGER trg_goals_updated_at
  BEFORE UPDATE ON goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Phase 4.3 — the contribution ledger. `source_type`/`source_id` say where the
-- money moved so a deposit into an account the goal already LINKS to is counted
-- once (via the balance) instead of twice. See database/2026-goal-contributions.sql.
CREATE TABLE IF NOT EXISTS goal_contributions (
  id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID          REFERENCES users(id) ON DELETE CASCADE,
  goal_id     UUID          NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  amount      DECIMAL(15,2) NOT NULL,
  date        DATE          NOT NULL,
  source_type TEXT,
  source_id   UUID,
  note        TEXT,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_goal_contributions_user ON goal_contributions(user_id);
CREATE INDEX IF NOT EXISTS idx_goal_contributions_goal ON goal_contributions(goal_id);

DROP TRIGGER IF EXISTS trg_goal_contributions_updated_at ON goal_contributions;
CREATE TRIGGER trg_goal_contributions_updated_at
  BEFORE UPDATE ON goal_contributions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Budgets ───────────────────────────────────────────────────────────────────

-- Phase 4.1 budgeting foundation: a monthly spending cap, either on one
-- category (scope='category') or on ALL spending at once (scope='overall', no
-- category). See database/2026-budget-foundation.sql and utils/budgeting.ts.
CREATE TABLE IF NOT EXISTS budgets (
  id               UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id          UUID          REFERENCES users(id) ON DELETE CASCADE,
  scope            TEXT          NOT NULL DEFAULT 'category'
                                 CHECK (scope IN ('category', 'overall')),
  category         TEXT,
  limit_amount     DECIMAL(15,2) NOT NULL,
  period           TEXT          DEFAULT 'monthly' CHECK (period IN ('weekly', 'monthly', 'yearly')),
  rollover_enabled BOOLEAN       DEFAULT FALSE,
  -- First month the cap applies to, 'YYYY-MM'. Rollover never accumulates from
  -- before it.
  start_month      TEXT,
  active           BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ   DEFAULT NOW(),
  updated_at       TIMESTAMPTZ   DEFAULT NOW()
);

-- Idempotent patch for databases created before Phase 4.1.
ALTER TABLE budgets ALTER COLUMN category DROP NOT NULL;
ALTER TABLE budgets
  ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'category'
    CHECK (scope IN ('category', 'overall'));
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS start_month TEXT;
ALTER TABLE budgets ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

-- One ACTIVE overall budget per user, and one per category (case-insensitive).
CREATE UNIQUE INDEX IF NOT EXISTS uq_budgets_overall
  ON budgets (user_id) WHERE scope = 'overall' AND active;
CREATE UNIQUE INDEX IF NOT EXISTS uq_budgets_category
  ON budgets (user_id, lower(category)) WHERE scope = 'category' AND active;
CREATE INDEX IF NOT EXISTS idx_budgets_user ON budgets (user_id);

DROP TRIGGER IF EXISTS trg_budgets_updated_at ON budgets;
CREATE TRIGGER trg_budgets_updated_at
  BEFORE UPDATE ON budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Loans / debt ──────────────────────────────────────────────────────────────

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
  include_in_net_worth BOOLEAN       NOT NULL DEFAULT TRUE,
  add_to_bills         BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ   DEFAULT NOW(),
  updated_at           TIMESTAMPTZ   DEFAULT NOW()
);
ALTER TABLE loans ADD COLUMN IF NOT EXISTS include_in_net_worth BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS add_to_bills BOOLEAN NOT NULL DEFAULT TRUE;

DROP TRIGGER IF EXISTS trg_loans_updated_at ON loans;
CREATE TRIGGER trg_loans_updated_at
  BEFORE UPDATE ON loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);

-- Stable link from an auto-created "<loan> repayment" bill back to its loan.
ALTER TABLE bills ADD COLUMN IF NOT EXISTS loan_id UUID;

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
ALTER TABLE loans                  ENABLE ROW LEVEL SECURITY;

-- Service-role bypass (explicit, for clarity — service_role always bypasses RLS)
-- No policies needed for service_role; the backend handles all auth.

-- ── Reload PostgREST schema cache ─────────────────────────────────────────────
-- Supabase's API layer caches the table shape. After any DDL above (new columns,
-- new tables) it can keep serving the OLD schema and reject inserts that mention
-- the new columns with `PGRST204: Could not find the 'X' column ... in the schema
-- cache` → the backend turns that into a 500. This forces an immediate reload so a
-- fresh migrate.sh run never leaves the API out of sync with the database.
NOTIFY pgrst, 'reload schema';

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Tables created: users, email_verification_codes, bank_accounts,
--   shared_account_access, credit_cards, transactions, subscriptions,
--   investments, investment_price_history, dividends, super_funds,
--   income_entries, tax_records, tax_deductions, tax_brackets,
--   bills, goals, budgets, notifications, telegram_conversations,
--   exchange_rates, net_worth_history
-- Total: 22 tables
