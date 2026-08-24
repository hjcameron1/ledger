-- ═══════════════════════════════════════════════════════════════════════════
--  Documents become shareable in their own right (2026-08-24)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Until now a document could only reach another person by FOLLOWING SOMETHING:
-- filed against a household, or against an account/loan/property/investment
-- that was already shared (Phase 8.1). That leaves no way to put one statement
-- in front of one household — and, worse, no way to say WHICH household a
-- document belongs to when its owner is in several. Every member of every
-- household the owner belonged to saw the same pile.
--
-- So a document joins the vocabulary of shareable record types. No new table
-- and no new column: it plugs into `record_households`, the SAME many-to-many
-- join an account or a loan uses.
--
--   ONE DOCUMENT ROW. ONE STORED FILE. As many households as its owner puts it
--   in, shown once in each of them — never a copy, and never a second file.
--
-- Un-sharing is one deleted join row, and it takes effect at the next read,
-- because visibility is DERIVED (backend/src/services/documentVault.ts) rather
-- than stamped on the document. Ownership is untouched: `documents.user_id`
-- never moves, and rename, re-file, read, share and delete all stay owner-only.
--
-- The CHECK constraints were created inline, so their names are whatever
-- Postgres generated. Rather than guess, each is found in pg_constraint by what
-- it constrains, dropped, and re-created with 'document' added — exactly the
-- pattern 2026-investment-sharing.sql and 2026-shared-spending.sql use.
-- Idempotent: a re-run finds the new constraint, drops it, and puts back an
-- identical one.

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
      || '''property'', ''budget'', ''goal'', ''investment'', ''income'', '
      || '''bill'', ''document''))',
      t, t || '_record_type_check'
    );
  END LOOP;
END $$;

-- Nothing is backfilled. A document that reached a household by its LINK still
-- reaches it by its link — that rule is unchanged and is still derived at read
-- time. This migration only makes a second, explicit route possible, and no
-- document takes it until its owner says so.
