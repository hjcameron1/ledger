-- ─────────────────────────────────────────────────────────────────────────────
-- Account deletion: make "delete the user row wipes everything" a DB invariant.
--
-- Rather than hand-maintaining a list of tables to delete in the app (which rots
-- every time a table is added), we guarantee that every foreign key pointing at
-- users(id) is ON DELETE CASCADE, and that every per-user table (any column named
-- user_id) actually has such a foreign key. After this runs, a single
--   DELETE FROM users WHERE id = <id>
-- transitively removes all of that user's data, atomically, in FK-safe order.
--
-- Idempotent: safe to run repeatedly. Guarded so one problematic table (e.g.
-- pre-existing orphan rows) raises a NOTICE instead of aborting the whole run.
-- ─────────────────────────────────────────────────────────────────────────────

-- Part 1 ── Every FK that references public.users(id): force ON DELETE CASCADE.
--          This catches user_id columns AND owner_id/accessor_id on
--          shared_account_access, which previously had no cascade.
DO $$
DECLARE
  r            RECORD;
  local_col    TEXT;
BEGIN
  FOR r IN
    SELECT c.oid            AS conoid,
           c.conname        AS conname,
           c.confdeltype    AS deltype,
           c.conrelid::regclass::text AS local_table,
           c.conkey         AS local_cols,
           c.conrelid       AS local_relid
    FROM   pg_constraint c
    JOIN   pg_class      rt ON rt.oid = c.confrelid
    JOIN   pg_namespace  ns ON ns.oid = rt.relnamespace
    WHERE  c.contype = 'f'
      AND  rt.relname = 'users'
      AND  ns.nspname = 'public'
      AND  c.confdeltype <> 'c'          -- 'c' = cascade; anything else we fix
  LOOP
    -- resolve the local column name(s) for this FK (single-column in practice)
    SELECT string_agg(quote_ident(a.attname), ', ')
    INTO   local_col
    FROM   unnest(r.local_cols) WITH ORDINALITY AS k(attnum, ord)
    JOIN   pg_attribute a ON a.attrelid = r.local_relid AND a.attnum = k.attnum;

    BEGIN
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.local_table, r.conname);
      EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES users(id) ON DELETE CASCADE',
        r.local_table, r.conname, local_col
      );
      RAISE NOTICE 'Cascade enforced on %.% (%)', r.local_table, local_col, r.conname;
    EXCEPTION WHEN OTHERS THEN
      RAISE NOTICE 'SKIPPED % (%): %', r.local_table, r.conname, SQLERRM;
    END;
  END LOOP;
END $$;

-- Part 2 ── Every table with a `user_id` column but NO foreign key to users:
--           add one, ON DELETE CASCADE. Covers tables created out-of-band
--           (e.g. telegram_briefing_settings) that never had the constraint.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.table_name
    FROM   information_schema.columns t
    WHERE  t.table_schema = 'public'
      AND  t.column_name  = 'user_id'
      AND  NOT EXISTS (
        SELECT 1
        FROM   pg_constraint c
        JOIN   pg_class      rt ON rt.oid = c.confrelid
        JOIN   pg_attribute  a  ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
        WHERE  c.contype = 'f'
          AND  rt.relname = 'users'
          AND  c.conrelid = ('public.' || t.table_name)::regclass
          AND  a.attname = 'user_id'
      )
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
        r.table_name, r.table_name || '_user_id_fkey'
      );
      RAISE NOTICE 'Added cascading FK on %.user_id', r.table_name;
    EXCEPTION WHEN OTHERS THEN
      -- Most likely orphan rows or an odd column type; surface it, don't abort.
      RAISE NOTICE 'SKIPPED %.user_id: %', r.table_name, SQLERRM;
    END;
  END LOOP;
END $$;
