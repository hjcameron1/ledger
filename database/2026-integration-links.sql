-- Ecosystem integration links: pairing-code → durable token, binding another app
-- (e.g. PAssistant) to a Ledger user. Idempotent; safe to re-run.
--
-- Flow:
--   1. A logged-in Ledger user generates a one-time pairing CODE (status 'pending').
--   2. The consuming app redeems the code with its app key, receiving a durable
--      TOKEN (status 'active'). The code is single-use.
--   3. Summary requests carry the token; revoking sets status 'revoked'.

CREATE TABLE IF NOT EXISTS integration_links (
  id          UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id     UUID        REFERENCES users(id) ON DELETE CASCADE,
  app_id      TEXT,                          -- which app redeemed it (e.g. 'passistant')
  code        TEXT        UNIQUE,            -- one-time pairing code (cleared after redeem)
  token       TEXT        UNIQUE,            -- durable link token (set on redeem)
  status       TEXT        DEFAULT 'pending', -- pending | active | disconnected | revoked
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  expires_at   TIMESTAMPTZ,                   -- pairing-code expiry
  redeemed_at  TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,                    -- last summary read (drives sync-health display)
  disconnected_at TIMESTAMPTZ                  -- when the consuming app severed the link from its end
);

-- Added after initial ship — safe to re-run on an existing table.
ALTER TABLE integration_links ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
-- 'disconnected' = the consuming app (e.g. PAssistant) unlinked from ITS side and told
-- Ledger. Distinct from 'revoked' (the Ledger user disconnected here): a disconnected
-- row stays visible in Connected Apps so the user sees why sync stopped, until dismissed.
ALTER TABLE integration_links ADD COLUMN IF NOT EXISTS disconnected_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_integration_links_code  ON integration_links(code)  WHERE code  IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integration_links_token ON integration_links(token) WHERE token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_integration_links_user  ON integration_links(user_id);
