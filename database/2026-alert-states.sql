-- Phase 4.4 — proactive alert state.
--
-- Alerts themselves are NOT stored. They are re-derived on every load from the
-- budget, goal and forecast engines, so the list can never drift from the
-- numbers it describes and nothing accumulates. What IS stored is the user's
-- response to an alert — dismissed, and read — because that is the only part
-- the engines cannot re-derive, and the only part that has to follow the user
-- from one device to the next.
--
-- `alert_key` is the alert's own stable identity, minted by the engine
-- (frontend/src/utils/alerts.ts) from what the alert is ABOUT — for example
-- `budget-limit:2026-08:groceries` or `goal-behind:<goal id>`. Month-scoped
-- keys mean a new month is genuinely new news; goal and cash keys are not, so a
-- dismissal there lasts until the situation changes.
--
-- `dismissed_stage` / `read_stage` hold the alert's STAGE at the time the user
-- acted, not a boolean. A stage rises as a situation gets materially worse
-- (nearing a cap → past it → well past it), and the alert reappears once its
-- stage exceeds the one recorded here. That is what lets "don't nag me" and
-- "but do tell me if it gets worse" both be true, without storing a separate
-- reminder schedule. NULL means the user has never dismissed / never read it.
--
-- UNIQUE (user_id, alert_key): one row per alert per user, written by upsert.
-- Two devices acting on the same alert converge on one row instead of racing to
-- create two that would then disagree.
CREATE TABLE IF NOT EXISTS alert_states (
  id              UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id         UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alert_key       TEXT        NOT NULL,
  dismissed_stage INTEGER,
  dismissed_at    TIMESTAMPTZ,
  read_stage      INTEGER,
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, alert_key)
);

CREATE INDEX IF NOT EXISTS idx_alert_states_user ON alert_states(user_id);

DROP TRIGGER IF EXISTS trg_alert_states_updated_at ON alert_states;
CREATE TRIGGER trg_alert_states_updated_at
  BEFORE UPDATE ON alert_states
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
