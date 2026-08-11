-- ══════════════════════════════════════════════════════════════════════════════
--  Phase 2A — Transaction Foundation
--  Run this in the Supabase SQL editor (or via ./database/migrate.sh once merged
--  into schema.sql).
--
--  Adds nullable, backwards-compatible columns to `transactions` so every part of
--  Ledger can agree on transaction SOURCE, RAW DATA, DUPLICATE IDENTITY,
--  TRANSFERS, and WHAT COUNTS AS SPENDING.
--
--  NOTHING is removed. Existing rows keep working — every new column is nullable
--  or has a safe default. Old columns (is_duplicate_flagged, is_subscription)
--  are retained and treated as LEGACY; they will be migrated in a later phase.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Provenance ─────────────────────────────────────────────────────────────
-- Where the transaction came from, and the source system's own identifier for it.
--   'basiq'     — open-banking feed (Basiq)
--   'statement' — parsed from an uploaded PDF/CSV statement
--   'manual'    — hand-entered by the user
--   'unknown'   — legacy rows whose origin can't be inferred with confidence
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_check
  CHECK (source IS NULL OR source IN ('basiq', 'statement', 'manual', 'unknown'));

-- A stable per-source identifier (e.g. Basiq's tx id) used for idempotent import.
-- basiq_tx_id is kept as-is for backwards compatibility; source_ref generalises it.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source_ref TEXT;

-- ── 2. Raw data preservation ──────────────────────────────────────────────────
-- The original, untouched description from the source. `merchant` remains the
-- user-facing display name and may be edited/enriched; raw_description must NEVER
-- be overwritten once set.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS raw_description TEXT;

-- Normalised merchant key (output of normaliseMerchant) for grouping/matching.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_normalized TEXT;

-- ── 3. Transfers ──────────────────────────────────────────────────────────────
-- When a debit/credit pair is confidently identified as an internal transfer
-- (bank→bank, bank→savings, bank→credit-card repayment) both legs are flagged
-- with is_transfer=true and share a transfer_pair_id. Neither leg is spend/income.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_transfer BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transfer_pair_id UUID;

-- ── 4. Review / confidence ────────────────────────────────────────────────────
-- Review lifecycle for later stages (queue UI is Phase 2B). Default 'clear'
-- so existing behaviour (everything visible, nothing gated) is unchanged.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'clear';
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_review_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_review_status_check
  CHECK (review_status IS NULL OR review_status IN ('clear', 'needs_review', 'reviewed'));

-- 0..1 confidence in the automated classification/match. NULL = not scored.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3);
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_confidence_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_confidence_check
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

-- How the current category was chosen. (AI/rules engines land in Phase 2B.)
--   'auto'    — keyword autoCategory()
--   'basiq'   — Basiq ANZSIC enrichment
--   'user'    — user-set
--   'rule'    — user rules engine (future)
--   'ai'      — AI classifier (future)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_source TEXT;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_category_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_category_source_check
  CHECK (category_source IS NULL OR category_source IN ('auto', 'basiq', 'user', 'rule', 'ai'));

-- ── 5. Duplicate identity ─────────────────────────────────────────────────────
-- Deterministic content hash: user + account + date + signed-cents + normalised
-- merchant/raw. Lets the SAME imported transaction be recognised on re-import
-- while allowing two genuinely-distinct same-value purchases to coexist.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS content_hash TEXT;

-- ── 5b. Transaction type (financial-event class) ──────────────────────────────
-- Nullable classification so downstream code can distinguish a purchase from a
-- refund / fee / interest / income / transfer WITHOUT re-deriving it from the
-- (ambiguous) sign. Left NULL for existing rows — we do NOT guess history. In
-- Phase 2A only reliably-detected internal transfers are stamped ('transfer');
-- refund/fee/interest classification is deferred to Phase 2B (no guessing now).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_type TEXT;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IS NULL OR transaction_type IN
    ('purchase', 'refund', 'income', 'transfer', 'fee', 'interest', 'other'));

-- ── 6. Tax / metadata ─────────────────────────────────────────────────────────
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS tags TEXT[];
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_tax_deductible BOOLEAN DEFAULT FALSE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS deduction_category TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS entity TEXT;

-- ── 7. Indexes ────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_transactions_content_hash
  ON transactions(user_id, content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_transfer_pair
  ON transactions(transfer_pair_id) WHERE transfer_pair_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transactions_source_ref
  ON transactions(user_id, source, source_ref) WHERE source_ref IS NOT NULL;

-- ── 8. Safe backfill ──────────────────────────────────────────────────────────
-- Only infer what is KNOWN with confidence. Basiq rows are unambiguous; their id
-- doubles as the source_ref. Everything else is left NULL / 'unknown' — we do NOT
-- guess statement-vs-manual for historical rows.
UPDATE transactions
   SET source = 'basiq',
       source_ref = COALESCE(source_ref, basiq_tx_id)
 WHERE basiq_tx_id IS NOT NULL
   AND (source IS NULL OR source <> 'basiq');

UPDATE transactions
   SET source = 'unknown'
 WHERE source IS NULL
   AND basiq_tx_id IS NULL;

-- merchant_normalized / content_hash for historical rows are backfilled from the
-- client (which owns the canonical normaliseMerchant + hashing logic) on next
-- load, not here — keeping one source of truth for that logic.

-- Reload PostgREST's schema cache so the Supabase API immediately sees the new
-- columns. Without this the API can keep serving the pre-migration shape and
-- reject inserts with `PGRST204 ... column not found in the schema cache` (500).
NOTIFY pgrst, 'reload schema';
