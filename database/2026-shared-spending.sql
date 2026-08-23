-- ═══════════════════════════════════════════════════════════════════════════
--  Phase 7.2 — shared spending and responsibilities (2026-08-23)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- Households (7.1) answered WHO MAY SEE a row. This phase answers two questions
-- a couple actually argues about: WHO PAID for a shared transaction, and WHOSE
-- SPENDING it really was — possibly split between several members, by dollar
-- amounts or by percentages.
--
-- The law is unchanged and worth restating, because every column here obeys it:
-- SHARING CHANGES WHO CAN SEE A ROW, NEVER HOW MANY ROWS THERE ARE — and none
-- of this moves a dollar. Balances and net worth are read from account rows,
-- never by adding transactions up, so "Ada paid, but it's half Bo's spending"
-- is pure REPORTING metadata on the one transaction that already exists. No
-- mirrored rows, no IOU ledger, no second balance anywhere.
--
--   `responsible_user_id`  (already exists, 7.1) whose spending it is — one person.
--   `paid_by_user_id`      (new) who actually paid. NULL = the record's owner,
--                          so every existing transaction keeps the answer it
--                          already had and nothing needs backfilling.
--   `responsibility_split` (new) the many-person answer: a JSONB list of
--                          { user_id, amount } or { user_id, percent } lines.
--                          When present and valid it REPLACES the single
--                          responsible_user_id in reporting, exactly as
--                          category split lines replace a parent's category.
--                          NULL = no split (the overwhelmingly common case).
--
-- Bills join the sharing vocabulary as well: a shared household bill can name
-- the member responsible for it. Same shape — one nullable pointer, reporting
-- and reminders only, no money moved by it.

-- ── Transactions: who paid, and the responsibility split ────────────────────

ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS paid_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_transactions_paid_by
  ON transactions(paid_by_user_id) WHERE paid_by_user_id IS NOT NULL;

-- JSONB rather than a join table, deliberately: a split is 2–4 lines that live
-- and die with their one transaction, are always read with it, and ride the
-- existing transaction sync/offline queue unchanged. (Category splits predate
-- this and use a table; a second table would double the machinery for no query
-- we ever make — "all splits across transactions" is not a question.)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS responsibility_split JSONB;

-- ── Bills: the responsible member ───────────────────────────────────────────

ALTER TABLE bills
  ADD COLUMN IF NOT EXISTS responsible_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bills_responsible
  ON bills(responsible_user_id) WHERE responsible_user_id IS NOT NULL;

-- ── Bills become shareable ──────────────────────────────────────────────────
--
-- 'bill' joins the record_type vocabulary everywhere it is CHECKed, exactly as
-- 'investment'/'income' did (see 2026-investment-sharing.sql): the constraints
-- were created inline so their names are Postgres-generated — each is found by
-- what it constrains, dropped, and re-created with 'bill' added. Idempotent: a
-- re-run finds the new constraint, drops it, and puts back an identical one.

DO $$
DECLARE
  t TEXT;
  c RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'record_households', 'record_shares', 'share_codes', 'household_change_requests'
  ] LOOP
    FOR c IN
      SELECT conname FROM pg_constraint
      WHERE conrelid = t::regclass
        AND contype = 'c'
        AND pg_get_constraintdef(oid) LIKE '%record_type%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', t, c.conname);
    END LOOP;

    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (record_type IN '
      || '(''account'', ''card'', ''transaction'', ''loan'', '
      || '''property'', ''budget'', ''goal'', ''investment'', ''income'', ''bill''))',
      t, t || '_record_type_check'
    );
  END LOOP;
END $$;
