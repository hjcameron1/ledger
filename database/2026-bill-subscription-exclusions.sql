-- ══════════════════════════════════════════════════════════════════════════════
--  Bill ↔ Subscription reconciliation — "Different bills" decisions (cross-device)
--  Run this in the Supabase SQL editor (idempotent; safe to re-run).
--
--  When the user says a manual Bill and an auto-detected Subscription that LOOK
--  alike are actually DIFFERENT payments, that rejection must persist so the pair
--  is never suggested again — on EVERY device. Previously this lived only in
--  localStorage (per-device). This table is the synced, user-scoped store.
--
--  A row is keyed by `decision_key`: the STABLE anchor-name pair
--  (normaliseMerchant(bill.original_name|name) "::" normaliseMerchant(sub.
--  original_name|name)) computed by frontend billReconciliation.differentDecisionKey.
--  Because it is anchored on the import/original name — not the bill/subscription
--  row id or the current display name — the decision survives recurring-occurrence
--  id churn AND renames on either side. Additive; nothing else changes.
-- ══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bill_subscription_exclusions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  decision_key TEXT NOT NULL,
  created_at   TIMESTAMPTZ DEFAULT now()
);

-- One decision per (user, anchor-key). The client upsert's ON CONFLICT target, so
-- re-marking the same pair is idempotent and can never duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_bill_sub_excl_user_key
  ON bill_subscription_exclusions(user_id, decision_key);
