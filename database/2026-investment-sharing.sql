-- ═══════════════════════════════════════════════════════════════════════════
--  Investments become shareable (2026-08-21)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds 'investment' to the vocabulary of shareable record types, so a holding
-- can be shared to households (`record_households`) and to named people
-- (`record_shares` / `share_codes`) exactly like an account or a loan.
--
-- No new table and no new column: investments plug into the SAME join tables
-- every other shareable entity uses, so nothing here can duplicate a holding
-- or a valuation. Ownership (`investments.user_id`) is untouched — net worth
-- and portfolio totals are computed from ownership, and sharing only ever
-- records who may LOOK.
--
-- The three CHECK constraints were created inline on the `record_type` columns,
-- so their names are whatever Postgres generated. Rather than guess, each one
-- is found in pg_constraint by what it constrains, dropped, and re-created with
-- 'investment' added. Idempotent: a re-run finds the new constraint, drops it,
-- and puts back an identical one.

DO $$
DECLARE
  t TEXT;
  c RECORD;
BEGIN
  FOREACH t IN ARRAY ARRAY['record_households', 'record_shares', 'share_codes'] LOOP
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
      || '''property'', ''budget'', ''goal'', ''investment''))',
      t, t || '_record_type_check'
    );
  END LOOP;
END $$;
