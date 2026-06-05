-- ============================================================
-- Ledger – Self-Managed Super Fund (SMSF) schema
-- Safe to run multiple times (IF NOT EXISTS / idempotent seed).
-- Run in: Supabase Dashboard → SQL Editor → New query
--
-- NOTE ON IDENTITY: this app's primary identity is the custom `users`
-- table (the backend uses the service_role key and filters by user_id).
-- user_id therefore references users(id), matching every other table.
-- RLS + owner-only policies are still enabled so a future direct/anon
-- client (e.g. mobile) is owner-scoped; the service_role bypasses RLS.
-- ============================================================

-- ── SMSF funds ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smsf_funds (
  id             UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id        UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name           TEXT        NOT NULL,
  abn            TEXT,
  trustee_type   TEXT        NOT NULL DEFAULT 'individual'
                             CHECK (trustee_type IN ('individual', 'corporate')),
  is_audited     BOOLEAN     NOT NULL DEFAULT FALSE,
  last_audited_on DATE,
  audit_due_on   DATE,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_smsf_funds_user ON smsf_funds(user_id);

-- ── SMSF members ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smsf_members (
  id                  UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id             UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fund_id             UUID          NOT NULL REFERENCES smsf_funds(id) ON DELETE CASCADE,
  full_name           TEXT          NOT NULL,
  balance             DECIMAL(15,2) NOT NULL DEFAULT 0,
  total_super_balance DECIMAL(15,2),
  created_at          TIMESTAMPTZ   DEFAULT NOW(),
  updated_at          TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_smsf_members_fund ON smsf_members(fund_id);
CREATE INDEX IF NOT EXISTS idx_smsf_members_user ON smsf_members(user_id);

-- ── SMSF assets ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smsf_assets (
  id          UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fund_id     UUID          NOT NULL REFERENCES smsf_funds(id) ON DELETE CASCADE,
  asset_type  TEXT          NOT NULL,
  label       TEXT          NOT NULL,
  amount      DECIMAL(15,2) NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ   DEFAULT NOW(),
  updated_at  TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_smsf_assets_fund ON smsf_assets(fund_id);
CREATE INDEX IF NOT EXISTS idx_smsf_assets_user ON smsf_assets(user_id);

-- ── SMSF contributions ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS smsf_contributions (
  id                UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id           UUID          NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_id         UUID          NOT NULL REFERENCES smsf_members(id) ON DELETE CASCADE,
  contribution_type TEXT          NOT NULL
                                  CHECK (contribution_type IN ('concessional', 'non_concessional')),
  amount            DECIMAL(15,2) NOT NULL DEFAULT 0,
  contributed_on    DATE          NOT NULL,
  financial_year    TEXT          NOT NULL,   -- e.g. '2025-26'
  created_at        TIMESTAMPTZ   DEFAULT NOW(),
  updated_at        TIMESTAMPTZ   DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_smsf_contrib_member ON smsf_contributions(member_id, financial_year);
CREATE INDEX IF NOT EXISTS idx_smsf_contrib_user ON smsf_contributions(user_id);

-- ── Contribution caps (reference data; not user-owned) ─────────────────────────
-- Figures verified against ato.gov.au (June 2026):
--   2025-26: concessional $30,000 · non-concessional $120,000 · bring-forward $360,000
--   2026-27: concessional $32,500 · non-concessional $130,000 · bring-forward $390,000
CREATE TABLE IF NOT EXISTS super_contribution_caps (
  id             UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  financial_year TEXT          NOT NULL,
  cap_type       TEXT          NOT NULL
                               CHECK (cap_type IN ('concessional', 'non_concessional', 'non_concessional_bring_forward')),
  amount         DECIMAL(15,2) NOT NULL,
  created_at     TIMESTAMPTZ   DEFAULT NOW(),
  UNIQUE (financial_year, cap_type)
);

INSERT INTO super_contribution_caps (financial_year, cap_type, amount) VALUES
  ('2025-26', 'concessional',                    30000),
  ('2025-26', 'non_concessional',               120000),
  ('2025-26', 'non_concessional_bring_forward', 360000),
  ('2026-27', 'concessional',                    32500),
  ('2026-27', 'non_concessional',               130000),
  ('2026-27', 'non_concessional_bring_forward', 390000)
ON CONFLICT (financial_year, cap_type) DO UPDATE SET amount = EXCLUDED.amount;

-- ── updated_at triggers ───────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_smsf_funds_updated         ON smsf_funds;
DROP TRIGGER IF EXISTS trg_smsf_members_updated        ON smsf_members;
DROP TRIGGER IF EXISTS trg_smsf_assets_updated         ON smsf_assets;
DROP TRIGGER IF EXISTS trg_smsf_contributions_updated  ON smsf_contributions;
CREATE TRIGGER trg_smsf_funds_updated        BEFORE UPDATE ON smsf_funds        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_smsf_members_updated       BEFORE UPDATE ON smsf_members       FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_smsf_assets_updated        BEFORE UPDATE ON smsf_assets        FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_smsf_contributions_updated BEFORE UPDATE ON smsf_contributions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Row Level Security ────────────────────────────────────────────────────────
-- Owner-only on all four user-owned tables; required so direct (non
-- service_role) inserts are scoped to the owner instead of silently failing.
ALTER TABLE smsf_funds            ENABLE ROW LEVEL SECURITY;
ALTER TABLE smsf_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE smsf_assets           ENABLE ROW LEVEL SECURITY;
ALTER TABLE smsf_contributions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE super_contribution_caps ENABLE ROW LEVEL SECURITY;

-- Owner-only policy: one FOR ALL policy covers select/insert/update/delete.
DROP POLICY IF EXISTS smsf_funds_owner         ON smsf_funds;
DROP POLICY IF EXISTS smsf_members_owner        ON smsf_members;
DROP POLICY IF EXISTS smsf_assets_owner         ON smsf_assets;
DROP POLICY IF EXISTS smsf_contributions_owner  ON smsf_contributions;

CREATE POLICY smsf_funds_owner        ON smsf_funds        FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY smsf_members_owner       ON smsf_members       FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY smsf_assets_owner        ON smsf_assets        FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY smsf_contributions_owner ON smsf_contributions FOR ALL
  USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

-- Caps are reference data: read-only to all authenticated users, no writes.
DROP POLICY IF EXISTS super_caps_read ON super_contribution_caps;
CREATE POLICY super_caps_read ON super_contribution_caps FOR SELECT
  TO authenticated USING (true);

-- ── Done ──────────────────────────────────────────────────────────────────────
-- Tables: smsf_funds, smsf_members, smsf_assets, smsf_contributions,
--         super_contribution_caps
