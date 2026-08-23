-- ═══════════════════════════════════════════════════════════════════════════
--  Phase 8.1 — financial document vault (2026-08-23)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- One table of METADATA. The files themselves live in a PRIVATE Supabase
-- Storage bucket named 'documents' (created automatically by the backend on
-- first upload — nothing to do here), under {user_id}/{document_id}/{filename},
-- and are only ever read or written through the backend with the service-role
-- key. No public URLs exist, so possession of a path grants nothing.
--
-- Visibility follows the law of Phase 7: SHARING CHANGES WHO CAN SEE A ROW,
-- NEVER HOW MANY ROWS THERE ARE. A document has no sharing machinery of its
-- own — it FOLLOWS THE RECORD IT IS LINKED TO, the same way a transaction
-- follows its account:
--
--   linked to nothing        personal, owner only.
--   linked to a household    every member of that household may see it.
--   linked to an account /   whoever may see that record may see the document
--   card / loan / property /   (household share and direct grant alike),
--   investment                 derived at read time — un-sharing the record
--                              takes its documents back in the same instant.
--   linked to a tax year     personal, owner only — tax is ownership, never
--                              scope, and a payslip shared by accident is the
--                              exact leak this phase must not invent.
--
-- Writes never follow anybody: rename, re-file and delete are OWNER-ONLY.
-- A household member can look at the mortgage contract; only the person it
-- belongs to can rename or remove it.

CREATE TABLE IF NOT EXISTS documents (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- Display name (renameable) and the immutable facts of the file itself.
  name              TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  storage_path      TEXT NOT NULL,
  mime_type         TEXT NOT NULL DEFAULT 'application/octet-stream',
  size_bytes        BIGINT NOT NULL DEFAULT 0,

  -- What KIND of paper this is. 'other' is a real answer, not a failure.
  document_type     TEXT NOT NULL DEFAULT 'other' CHECK (document_type IN (
                      'statement', 'payslip', 'tax', 'loan', 'property',
                      'insurance', 'receipt', 'contract', 'other')),

  -- The document's own date (statement period end, payslip date…), never
  -- confused with created_at, which is merely when it was uploaded.
  document_date     DATE,
  provider          TEXT,
  notes             TEXT,

  -- The optional link that decides who else may see it. linked_id is TEXT, not
  -- UUID, because a tax year is named by its FY label ('2025-2026') and a
  -- household/record by its UUID — one column serves both spellings.
  linked_type       TEXT CHECK (linked_type IN (
                      'account', 'card', 'loan', 'property', 'investment',
                      'tax_year', 'household')),
  linked_id         TEXT,

  created_at        TIMESTAMPTZ DEFAULT NOW(),
  updated_at        TIMESTAMPTZ DEFAULT NOW(),

  -- A link is both halves or neither — a type pointing at nothing (or an id
  -- with no type) is a filing error the database refuses outright.
  CONSTRAINT documents_link_complete CHECK (
    (linked_type IS NULL) = (linked_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_documents_user     ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_link     ON documents(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_documents_type     ON documents(document_type);

-- Same posture as every other table: the service-role backend is the only
-- reader and writer; direct client access is denied.
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
