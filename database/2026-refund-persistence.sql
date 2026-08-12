-- ══════════════════════════════════════════════════════════════════════════════
--  Refund persistence — guarantee the Phase 2C refund flow can be SAVED
--  Run this once in the Supabase SQL editor. Idempotent: safe to re-run.
--
--  Why this exists: a matched refund stamps a transaction with
--    transaction_type='refund', refund_of=<purchase id>, review_status,
--    review_reason, category (inherited) and confidence.
--  If any of those columns/constraints are missing on the server, PostgREST
--  rejects the write (`PGRST204 column ... not found` or a CHECK violation) and
--  the client parks it in the offline sync queue — you see the persistent
--  "Some data is waiting to sync — retry now" banner and the refund never
--  persists (transaction_type / refund_of come back empty on reload).
--
--  These columns are already introduced by 2026-transaction-foundation.sql (2A),
--  2026-merchant-rules.sql (2B) and 2026-transaction-2c.sql (2C). This script
--  re-asserts ONLY what the refund WRITE path needs, in one place, so a single
--  paste guarantees the feature can be saved regardless of which prior
--  migrations were applied. Nothing is dropped; every column is nullable.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── Columns the refund/review write path sets ─────────────────────────────────
-- The event class. Must permit 'refund' (and the other 2A classes).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_type TEXT;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_transaction_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_transaction_type_check
  CHECK (transaction_type IS NULL OR transaction_type IN
    ('purchase', 'refund', 'income', 'transfer', 'fee', 'interest', 'other'));

-- Link from a refund to the original purchase. TEXT + NO FK on purpose: it may
-- hold a temp local id before the purchase's create-sync resolves to its server
-- id (the client re-points it on sync — see registerSyncSuccess in dataService).
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS refund_of TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_refund_of
  ON transactions(user_id, refund_of) WHERE refund_of IS NOT NULL;

-- Review lifecycle: an ambiguous / over-refund inflow is parked as 'needs_review'.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_status TEXT DEFAULT 'clear';
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_review_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_review_status_check
  CHECK (review_status IS NULL OR review_status IN ('clear', 'needs_review', 'reviewed'));

-- Free-text reason (e.g. 'possible_refund'). No CHECK — do not constrain it.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS review_reason TEXT;

-- 0..1 confidence in the automated match.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS confidence NUMERIC(4,3);
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_confidence_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_confidence_check
  CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1));

-- A refund INHERITS the purchase's category, and that category may have been set
-- by merchant recognition (category_source='merchant'). The original 2A CHECK did
-- not permit 'merchant', which would reject the refund's update — ensure it does.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS category_source TEXT;
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_category_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_category_source_check
  CHECK (category_source IS NULL OR category_source IN
    ('auto', 'basiq', 'user', 'rule', 'merchant', 'ai'));

-- Matching also relies on these 2A identity/grouping columns being present on the
-- server (the refund is matched client-side, but the purchase must round-trip
-- with them intact). Re-assert them so a partially-migrated DB is made whole.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_normalized TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS content_hash        TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS source              TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_id         TEXT;

-- ── Reload PostgREST's schema cache so the API sees the columns immediately ────
-- Without this the API can keep serving the pre-migration shape and reject writes
-- with PGRST204 even though the column now exists.
NOTIFY pgrst, 'reload schema';

-- ── Verify (optional) ─────────────────────────────────────────────────────────
-- Run this SELECT after the migration — every refund-write column should list.
-- Expect rows for: category_source, confidence, merchant_id, merchant_normalized,
-- refund_of, review_reason, review_status, transaction_type, content_hash, source.
SELECT column_name, data_type, is_nullable
  FROM information_schema.columns
 WHERE table_name = 'transactions'
   AND column_name IN (
     'transaction_type','refund_of','review_status','review_reason',
     'confidence','category_source','merchant_normalized','content_hash',
     'source','merchant_id')
 ORDER BY column_name;
