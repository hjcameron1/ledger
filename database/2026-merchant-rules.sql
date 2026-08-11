-- ══════════════════════════════════════════════════════════════════════════════
--  Phase 2B — Merchant Recognition + Transaction Rules
--  Run this in the Supabase SQL editor (idempotent; safe to re-run).
--
--  Builds on Phase 2A (2026-transaction-foundation.sql). NOTHING from 2A is
--  changed: raw_description, source/source_ref, content_hash, is_transfer,
--  transfer_pair_id, category_source and confidence all keep their meaning. This
--  migration only ADDS tables + one nullable column, all backwards-compatible.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. Canonical merchants ────────────────────────────────────────────────────
-- user_id NULL  → GLOBAL merchant (a shared default, visible to everyone)
-- user_id set   → a user-owned merchant, which overrides a global one for them
CREATE TABLE IF NOT EXISTS merchants (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              UUID REFERENCES users(id) ON DELETE CASCADE,
  display_name         TEXT NOT NULL,
  merchant_normalized  TEXT NOT NULL,
  default_category     TEXT,
  logo_url             TEXT,
  created_at           TIMESTAMPTZ DEFAULT now(),
  updated_at           TIMESTAMPTZ DEFAULT now()
);
-- One canonical merchant per (user, normalized-key). Plain composite unique so it
-- can serve as an ON CONFLICT target for the client's find-or-create upsert.
-- (Global rows have user_id NULL, treated as distinct — they are curated seed data,
-- not user-inserted through the API, so duplicates aren't a concern there.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchants_user_norm
  ON merchants(user_id, merchant_normalized);

-- ── 2. Merchant aliases ───────────────────────────────────────────────────────
-- Maps a raw/normalised description to a canonical merchant.
--   match_type 'normalized' → pattern = normaliseMerchant(raw) exactly
--   match_type 'contains'   → uppercased raw description contains pattern
-- user_id NULL = global mapping; user_id set = a user-specific override.
CREATE TABLE IF NOT EXISTS merchant_aliases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID REFERENCES users(id) ON DELETE CASCADE,
  merchant_id  UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
  pattern      TEXT NOT NULL,
  match_type   TEXT NOT NULL DEFAULT 'normalized',
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT merchant_aliases_match_type_check
    CHECK (match_type IN ('normalized', 'contains'))
);
-- One alias per (user, match_type, pattern) → newest merchant wins on upsert.
-- Plain composite unique so it can serve as the client upsert's ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS idx_merchant_aliases_user_pattern
  ON merchant_aliases(user_id, match_type, pattern);
CREATE INDEX IF NOT EXISTS idx_merchant_aliases_merchant ON merchant_aliases(merchant_id);

-- ── 3. Transaction rules ──────────────────────────────────────────────────────
-- User-owned. Higher priority wins; conditions/actions are JSON (see RuleCondition
-- / RuleAction in the frontend types). enabled=false is inert.
CREATE TABLE IF NOT EXISTS transaction_rules (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  priority    INTEGER NOT NULL DEFAULT 100,
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  conditions  JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  label       TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_transaction_rules_user
  ON transaction_rules(user_id, enabled, priority DESC);

-- ── 4. Link transactions → resolved merchant ──────────────────────────────────
-- Nullable. `merchant` stays the display string; raw_description stays untouched.
-- TEXT (not UUID) and NO FK on purpose: the client also stores synthetic seed ids
-- ("seed:woolworths") for built-in merchants that have no DB row, so merchant_id
-- is an advisory link that may hold either a merchants.id uuid or a seed id.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS merchant_id TEXT;
CREATE INDEX IF NOT EXISTS idx_transactions_merchant_id
  ON transactions(user_id, merchant_id) WHERE merchant_id IS NOT NULL;

-- ── 5. category_source now allows 'merchant' ──────────────────────────────────
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_category_source_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_category_source_check
  CHECK (category_source IS NULL OR category_source IN
    ('auto', 'basiq', 'user', 'rule', 'merchant', 'ai'));

-- Reload PostgREST's schema cache so the API sees the new tables/columns at once.
NOTIFY pgrst, 'reload schema';
