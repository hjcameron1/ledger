-- ═══════════════════════════════════════════════════════════════════════════
--  Household change requests (2026-08-23)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A household member with an editing role can change — and now remove — shared
-- rows they don't own. Neither act may quietly rewrite the OWNER's finances:
--
--   EDIT    the member's change applies to the HOUSEHOLD VIEW immediately (it is
--           stored here as a patch and merged over the row at read time, per
--           household), and the owner is asked — in the app on next load, and on
--           Telegram — whether to apply it to their own record too. Yes applies
--           the patch to the real row and the overlay disappears (converged).
--           No leaves the row diverged: the household keeps seeing its version,
--           the owner keeps theirs.
--
--   DELETE  the member's delete un-shares the row from that household on the
--           spot (gone from the household view, still entirely the owner's),
--           and the owner is asked whether to delete it from their account too.
--
-- So one table serves two jobs: it is the owner's approval inbox AND the
-- household view's overlay store. A row here with kind='edit' and status
-- 'pending' or 'declined' IS the household's version of the record.
--
-- `record_type`/`record_id` follow `record_shares` and `record_households`: one
-- table spans nine entity tables, so a CHECK, not a foreign key.

CREATE TABLE IF NOT EXISTS household_change_requests (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  record_type    TEXT        NOT NULL
                   CHECK (record_type IN ('account', 'card', 'transaction',
                                          'loan', 'property', 'budget', 'goal',
                                          'investment', 'income')),
  record_id      UUID        NOT NULL,
  household_id   UUID        NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  owner_user_id  UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  requested_by   UUID        NOT NULL REFERENCES users(id)      ON DELETE CASCADE,
  kind           TEXT        NOT NULL CHECK (kind IN ('edit', 'delete')),
  -- The member's version of the changed columns (edit only). Merged over the
  -- real row at read time for the household view; applied to the real row on
  -- approval. Never contains id / user_id / sharing fields.
  patch          JSONB,
  -- The owner's values for those same columns at the time of the change, so the
  -- approval prompt can show a real before → after.
  previous       JSONB,
  -- What to call the thing in an alert ("Car loan"), captured at request time so
  -- a delete request can still be described after the row is un-shared.
  record_label   TEXT,
  -- pending  → waiting for the owner's answer
  -- declined → owner said no; an edit overlay stays live for the household view
  --            (a declined delete request is removed instead — nothing remains
  --            to show, the row was already un-shared).
  status         TEXT        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'declined')),
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW(),
  resolved_at    TIMESTAMPTZ
);

-- ONE live request per row, per household, per kind. A second member edit merges
-- into the existing request rather than stacking a queue of conflicting asks.
CREATE UNIQUE INDEX IF NOT EXISTS idx_hcr_unique
  ON household_change_requests(record_type, record_id, household_id, kind);

-- "What is waiting for me?" — the owner's approval inbox.
CREATE INDEX IF NOT EXISTS idx_hcr_by_owner
  ON household_change_requests(owner_user_id, status);

-- "Does this row have an overlay?" — the read every attach makes.
CREATE INDEX IF NOT EXISTS idx_hcr_by_record
  ON household_change_requests(record_type, record_id);

ALTER TABLE household_change_requests ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS trg_hcr_updated_at ON household_change_requests;
CREATE TRIGGER trg_hcr_updated_at
  BEFORE UPDATE ON household_change_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
