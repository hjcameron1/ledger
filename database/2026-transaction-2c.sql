-- ══════════════════════════════════════════════════════════════════════════════
--  Phase 2C — Recurring Series + Review Queue + Refunds + Splits
--  Run this in the Supabase SQL editor (idempotent; safe to re-run).
--
--  Builds on Phase 2A (2026-transaction-foundation.sql) and Phase 2B
--  (2026-merchant-rules.sql). NOTHING from 2A/2B is changed: dedup, transfers,
--  merchant recognition, rules, spend and offline-sync all keep their meaning.
--  This migration only ADDS two tables + three nullable columns, all
--  backwards-compatible.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Recurring series ────────────────────────────────────────────────────────
-- A PERSISTED recurring relationship (subscription / bill / income / loan
-- repayment / investment contribution / other). Replaces render-time-only
-- detection: a confirmed series is stored so its occurrences can be linked and a
-- dismissed suggestion stays dismissed across devices.
--
--   status 'active'    → a confirmed, tracked series
--   status 'dismissed' → the user said "this is NOT recurring"; suppresses the
--                        matching suggestion on every device (cross-device memory)
--   status 'ended'     → previously active, no longer expected
--
-- merchant_id is TEXT + NO FK (mirrors transactions.merchant_id — it may hold a
-- merchants.id uuid OR a synthetic "seed:*" id). merchant_normalized is the
-- grouping key detection uses to match occurrences and suppress suggestions.
CREATE TABLE IF NOT EXISTS recurring_series (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  merchant_id            TEXT,
  merchant_normalized    TEXT NOT NULL,
  name                   TEXT NOT NULL,
  original_name          TEXT,
  kind                   TEXT NOT NULL DEFAULT 'other',
  frequency              TEXT NOT NULL DEFAULT 'monthly',
  expected_amount        NUMERIC,
  last_transaction_date  DATE,
  next_expected_date     DATE,
  account_id             UUID,
  status                 TEXT NOT NULL DEFAULT 'active',
  created_at             TIMESTAMPTZ DEFAULT now(),
  updated_at             TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT recurring_series_kind_check CHECK (kind IN
    ('subscription','bill','income','loan_repayment','investment_contribution','other')),
  CONSTRAINT recurring_series_status_check CHECK (status IN
    ('active','dismissed','ended'))
);
-- One series per (user, normalized-merchant, frequency). Serves as the client
-- upsert's ON CONFLICT target so confirm/dismiss are idempotent and a dismissed
-- key can't coexist with an active one for the same pattern.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recurring_series_user_key
  ON recurring_series(user_id, merchant_normalized, frequency);
CREATE INDEX IF NOT EXISTS idx_recurring_series_user_status
  ON recurring_series(user_id, status);

-- ── 2. Transaction splits ──────────────────────────────────────────────────────
-- Splits ONE bank transaction across multiple categories. The original bank
-- transaction row stays intact; reporting/budgets use the split lines instead of
-- the parent's single category (no double-counting — see transactionCore). Split
-- amounts are stored as POSITIVE magnitudes that must sum to ABS(parent amount).
CREATE TABLE IF NOT EXISTS transaction_splits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  category        TEXT NOT NULL,
  amount          NUMERIC NOT NULL,
  notes           TEXT,
  tags            TEXT[],
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transaction_splits_txn
  ON transaction_splits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_splits_user
  ON transaction_splits(user_id);

-- ── 3. Link transactions → series / refund original / review reason ────────────
-- All nullable, all TEXT-advisory where they mirror an existing local-first id
-- pattern (recurring_series_id / refund_of may hold a temp local id before sync,
-- so they are TEXT with NO FK, exactly like merchant_id).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS recurring_series_id TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_of           TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_reason       TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_recurring_series
  ON transactions(user_id, recurring_series_id) WHERE recurring_series_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_refund_of
  ON transactions(user_id, refund_of) WHERE refund_of IS NOT NULL;

-- transaction_type already permits 'refund' (Phase 2A) — no constraint change
-- needed. review_status already permits 'needs_review'/'reviewed' (Phase 2A).

-- Reload PostgREST's schema cache so the API sees the new tables/columns at once.
NOTIFY pgrst, 'reload schema';
