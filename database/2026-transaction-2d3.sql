-- ══════════════════════════════════════════════════════════════════════════════
--  Phase 2D.3 — Smarter review + AI fallback
--  Run this in the Supabase SQL editor (idempotent; safe to re-run).
--
--  Builds on Phase 2A/2B/2C. The deterministic classifier (rules → merchant →
--  provider → keyword) runs first and unchanged. ONLY when it fails to produce a
--  confident category does the app ask Claude for a suggestion, as a fallback.
--
--  This migration adds per-transaction AI-SUGGESTION metadata. All columns are
--  nullable and advisory — every existing row and code path is unaffected. The AI
--  never overrides an explicit user rule: it only ever fills these fields (and, at
--  most, sets category_source='ai' on a row the deterministic engine left
--  'Uncategorised'). category_source='ai' is ALREADY permitted by the Phase 2A
--  check constraint (see schema.sql) — nothing to change there.
--
--    ai_suggested_category        TEXT         -- category Claude proposed
--    ai_suggested_merchant        TEXT         -- cleaned display merchant Claude proposed
--    ai_suggested_transaction_type TEXT        -- purchase|refund|income|... proposed
--    ai_suggested_reason          TEXT         -- short human note on why / what to check
--    ai_confidence                NUMERIC(4,3) -- Claude's own 0..1 confidence
--    ai_classified_at             TIMESTAMPTZ  -- set once Claude has answered; the
--                                                 guard that stops us re-asking (no
--                                                 repeated AI calls, cross-device).
-- ══════════════════════════════════════════════════════════════════════════════

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_category         TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_merchant         TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_transaction_type TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_suggested_reason           TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_confidence                 NUMERIC(4,3);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS ai_classified_at              TIMESTAMPTZ;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_ai_confidence_check;
ALTER TABLE transactions ADD  CONSTRAINT transactions_ai_confidence_check
  CHECK (ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1));

-- Verify (optional):
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'transactions' AND column_name LIKE 'ai_%' ORDER BY 1;
