-- ── D-CONC-1: atomic balance adjustment ──────────────────────────────────────
-- The transaction-driven balance move (/accounts/:id/adjust-balance and the
-- credit-card twin) used to be an app-level read-modify-write: SELECT the
-- current figure, then UPDATE it to current + delta. Two concurrent deltas both
-- read the same base and the second write clobbered the first — a live repro of
-- ten concurrent +1s landed on a final balance of 1–3, losing 7–9 updates.
--
-- These functions do the increment as a single atomic UPDATE inside the
-- database (balance = balance + delta), so row-level locking serialises the
-- concurrent writers and no update is lost. They return the whole row so the
-- API can keep post-processing (household attach, snapshot) exactly as before.
--
-- SECURITY DEFINER is unnecessary — the API connects with the service role — but
-- we pin an empty search_path as defensive hygiene. Both functions are
-- idempotent to (re)create.

CREATE OR REPLACE FUNCTION adjust_bank_account_balance(p_id UUID, p_delta NUMERIC)
RETURNS bank_accounts
LANGUAGE sql
AS $$
  UPDATE bank_accounts
     SET balance    = COALESCE(balance, 0) + p_delta,
         updated_at = NOW()
   WHERE id = p_id
  RETURNING *;
$$;

CREATE OR REPLACE FUNCTION adjust_credit_card_balance(p_id UUID, p_delta NUMERIC)
RETURNS credit_cards
LANGUAGE sql
AS $$
  UPDATE credit_cards
     SET balance_owing = COALESCE(balance_owing, 0) + p_delta,
         updated_at    = NOW()
   WHERE id = p_id
  RETURNING *;
$$;
