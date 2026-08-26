-- Create-idempotency for every important record kind (extends the transactions
-- client_id pattern, applied 2026-08-27). The client sends its locally-minted
-- row uuid as client_id on every create; the backend returns the existing
-- (user_id, client_id) row instead of inserting a twin when the enqueue-first
-- sync queue replays a create whose response was lost mid-flight.
--
-- Safe to run repeatedly (IF NOT EXISTS throughout). Code degrades gracefully
-- before this runs — creates just aren't replay-deduped until then.

do $$
declare
  t text;
begin
  foreach t in array array[
    'bank_accounts',
    'credit_cards',
    'pending_payments',
    'credit_card_statements',
    'subscriptions',
    'bills',
    'goals',
    'goal_contributions',
    'loans',
    'loan_events',
    'investments',
    'investment_sales',
    'super_funds',
    'income_entries',
    'insurance_policies',
    'insurance_premium_history'
  ] loop
    execute format('alter table %I add column if not exists client_id uuid', t);
    execute format(
      'create unique index if not exists %I on %I (user_id, client_id) where client_id is not null',
      t || '_user_client_uidx', t
    );
  end loop;
end $$;
