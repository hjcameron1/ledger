-- ═══════════════════════════════════════════════════════════════════════════
--  Phase 8.2 — insurance management (2026-08-24)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Run this in the Supabase SQL editor. Safe to run more than once.
--
-- Two tables:
--
--   insurance_policies         what is covered, by whom, for how much, until when.
--   insurance_premium_history  what the premium has been, and when it changed.
--
-- ── Why a policy is not an 11th shareable record type ───────────────────────
-- The law of Phase 7 stands: SHARING CHANGES WHO CAN SEE A ROW, NEVER HOW MANY
-- ROWS THERE ARE. A policy has no sharing machinery of its own — like a Phase
-- 8.1 document, it FOLLOWS THE THING IT COVERS:
--
--   linked to nothing        personal, owner only.
--   linked to a household    every member of that household may see it.
--   linked to a property /   whoever may see that record may see the policy
--   account / card / loan /  covering it. Derived at READ time from the same
--   investment               household scope, so un-sharing the house takes its
--                            insurance back in the same instant, with nothing
--                            stamped on this table and nothing to clean up.
--
-- Writes stay OWNER-ONLY (see routes/insurance.ts): a policy shared into view is
-- still one person's contract with their insurer.
--
-- ── Why the premium has a history table ─────────────────────────────────────
-- "The premium went up $240 at renewal" is the single most useful thing an
-- insurance feature can say, and it cannot be said from one current figure. The
-- history is the audit trail of what the premium HAS BEEN — the same shape as
-- loan_events: rows that record what happened, never a second ledger the policy
-- is derived from. The policy's own premium_amount stays the authoritative
-- current price.
--
-- Nothing here computes money. Annual cost, renewal proximity, expiry and
-- premium changes are all derived by frontend/src/utils/insurance.ts from these
-- columns, so a figure can never be stored wrong.

-- ── Policies ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS insurance_policies (
  id                 UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the user calls it ("House — NRMA"), not the insurer's product name.
  name               TEXT          NOT NULL,
  policy_type        TEXT          NOT NULL DEFAULT 'other'
                       CHECK (policy_type IN (
                         'home', 'contents', 'landlord', 'car', 'health', 'life',
                         'income_protection', 'travel', 'pet', 'business', 'other')),
  insurer            TEXT,
  policy_number      TEXT,
  premium_amount     DECIMAL(15,2) NOT NULL DEFAULT 0,
  premium_frequency  TEXT          NOT NULL DEFAULT 'annually'
                       CHECK (premium_frequency IN (
                         'weekly', 'fortnightly', 'monthly', 'quarterly', 'annually')),
  start_date         DATE,
  -- The day cover lapses unless it is renewed. Everything the alerts say about a
  -- policy is measured from this one date.
  renewal_date       DATE,
  excess             DECIMAL(15,2),
  coverage_amount    DECIMAL(15,2),
  -- What this policy covers. TEXT rather than UUID for the same reason the
  -- document vault's link is: it holds record ids AND household ids, across five
  -- different tables, so no single foreign key could ever describe it.
  linked_type        TEXT          CHECK (linked_type IN (
                         'account', 'card', 'loan', 'property', 'investment', 'household')),
  linked_id          TEXT,
  -- The policy document itself, out of the Phase 8.1 vault. ON DELETE SET NULL:
  -- deleting the PDF leaves the policy, it does not delete the cover.
  document_id        UUID          REFERENCES documents(id) ON DELETE SET NULL,
  notes              TEXT,
  -- False once the user no longer holds this policy. Kept rather than deleted so
  -- last year's cover — and its premium history — is still answerable.
  active             BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ   DEFAULT NOW(),
  updated_at         TIMESTAMPTZ   DEFAULT NOW(),
  -- A link is both halves or neither. Half a link is a row that points nowhere
  -- and would quietly decide visibility on a null.
  CONSTRAINT insurance_link_complete CHECK ((linked_type IS NULL) = (linked_id IS NULL))
);

CREATE INDEX IF NOT EXISTS idx_insurance_user     ON insurance_policies(user_id);
CREATE INDEX IF NOT EXISTS idx_insurance_link     ON insurance_policies(linked_type, linked_id);
CREATE INDEX IF NOT EXISTS idx_insurance_renewal  ON insurance_policies(renewal_date);
CREATE INDEX IF NOT EXISTS idx_insurance_document ON insurance_policies(document_id);

-- ── Premium history ─────────────────────────────────────────────────────────
-- One row per price the policy has been sold at, oldest first. Written when the
-- policy is created and again whenever its premium changes; never updated.
CREATE TABLE IF NOT EXISTS insurance_premium_history (
  id                 UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  policy_id          UUID          NOT NULL REFERENCES insurance_policies(id) ON DELETE CASCADE,
  premium_amount     DECIMAL(15,2) NOT NULL DEFAULT 0,
  premium_frequency  TEXT          NOT NULL DEFAULT 'annually'
                       CHECK (premium_frequency IN (
                         'weekly', 'fortnightly', 'monthly', 'quarterly', 'annually')),
  -- The day this price started applying — usually a renewal date, which is why
  -- it is recorded rather than inferred from created_at.
  effective_date     DATE          NOT NULL,
  note               TEXT,
  created_at         TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_insurance_history_policy ON insurance_premium_history(policy_id, effective_date);
CREATE INDEX IF NOT EXISTS idx_insurance_history_user   ON insurance_premium_history(user_id);

-- Direct client access is denied for both, as everywhere else: every read and
-- write goes through the backend with the service-role key, which is the only
-- layer that knows the Phase 7 scope rules.
ALTER TABLE insurance_policies        ENABLE ROW LEVEL SECURITY;
ALTER TABLE insurance_premium_history ENABLE ROW LEVEL SECURITY;
