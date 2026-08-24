-- ═══════════════════════════════════════════════════════════════════════════
--  Phase 8.3 — facts read out of the documents already in the vault (2026-08-24)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- Phase 8.1 stored the FILE. This stores what was READ out of it — the renewal
-- date on an insurance schedule, the closing balance on a statement, the rate
-- on a loan contract — so Ask Ledger can answer from a document instead of
-- saying "Ledger stores your documents but does not read them".
--
-- Three rules are built into the shape of this table, not into the prompt that
-- fills it:
--
--   1. EVERY FACT CARRIES ITS PROVENANCE. `quote` is the words on the page the
--      value was taken from, verbatim, and `page` is where they were. A fact
--      that cannot say where it came from is not stored at all — which is what
--      makes "never infer a missing field" enforceable rather than requested.
--
--   2. EVERY FACT CARRIES ITS CONFIDENCE, and confidence decides how it may be
--      used. Below the trust floor (services/documentFacts.ts) a fact is shown
--      to the user flagged and must be CONFIRMED before any answer is built on
--      it. Confirming, correcting and rejecting are the user's, and are
--      recorded here — `source` says whether the value standing now is the
--      model's or the person's.
--
--   3. ONE ROW PER FIELD PER DOCUMENT. Re-reading a document replaces what it
--      said before rather than accumulating two answers to the same question.
--
-- Who may see a fact is not decided here: a fact belongs to its document, and
-- the document already follows the record it is linked to (Phase 8.1). The
-- routes read the document first and apply that same rule — there is no second
-- visibility system to disagree with the first.

CREATE TABLE IF NOT EXISTS document_facts (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- WHAT was found: a field name from the closed list in
  -- backend/src/services/documentFacts.ts. Anything else never reaches here.
  field         TEXT NOT NULL,
  value_kind    TEXT NOT NULL DEFAULT 'text'
                  CHECK (value_kind IN ('money', 'date', 'rate', 'text')),

  -- The value, as it reads and as it computes. `value_text` is always set;
  -- the typed column beside it is set only when the kind says so, so a figure
  -- is never re-parsed out of prose by whoever reads it next.
  value_text    TEXT NOT NULL,
  value_number  NUMERIC,
  value_date    DATE,

  -- WHERE it came from. Not decoration: an answer built on a document shows
  -- these words, so the user can check the claim against their own paperwork.
  quote         TEXT NOT NULL,
  page          INTEGER,

  -- HOW SURE the extractor was, 0–1, and who is speaking now.
  confidence    NUMERIC NOT NULL DEFAULT 0 CHECK (confidence >= 0 AND confidence <= 1),
  source        TEXT NOT NULL DEFAULT 'model' CHECK (source IN ('model', 'user')),
  model         TEXT,

  -- The user's verdict. 'unconfirmed' is the honest default: nobody has looked.
  status        TEXT NOT NULL DEFAULT 'unconfirmed'
                  CHECK (status IN ('unconfirmed', 'confirmed', 'rejected')),
  confirmed_at  TIMESTAMPTZ,

  extracted_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT document_facts_one_per_field UNIQUE (document_id, field)
);

CREATE INDEX IF NOT EXISTS idx_document_facts_document ON document_facts(document_id);
CREATE INDEX IF NOT EXISTS idx_document_facts_user     ON document_facts(user_id);

-- What happened the last time Ledger tried to read this file. Kept ON THE
-- DOCUMENT because "read, found nothing" and "never read" are different
-- answers to "what does this say?", and no row exists to tell them apart.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_status TEXT
  CHECK (extraction_status IN ('unread', 'read', 'nothing-found', 'unsupported', 'failed'));
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_at    TIMESTAMPTZ;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS extraction_error TEXT;

-- Same posture as every other table: the service-role backend is the only
-- reader and writer; direct client access is denied.
ALTER TABLE document_facts ENABLE ROW LEVEL SECURITY;
