import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { z } from 'zod';
import { recordNetWorthSnapshot } from '../services/netWorthSnapshot';
import { enrichWithDisplayAmounts } from '../services/currencyService';
// ── Phase 7.1: households ────────────────────────────────────────────────────
// Reads answer with the rows the user OWNS plus the rows SHARED with a household
// they're in — one row each, never a copy. Writes are checked against the row
// itself: your own always, somebody else's only when it's shared and your role
// can edit shared money. Deleting stays owner-only (see refuseDelete).
import {
  loadScope, scopedQuery, refuseWrite, refuseDelete, revokeGrantsFor,
  applyHouseholdShare, attachHouseholds, attachHouseholdsToOne,
} from '../services/householdScope';

const router = Router();

// ── Transaction write allowlist (Phase 2A security) ───────────────────────────
// Explicit set of client-writable transaction columns. Ownership/identity fields
// (id, user_id, created_at, updated_at) are NEVER accepted from the request body.
// `is_duplicate_flagged` is LEGACY (Phase 2A) — retained here only so older
// clients don't break; it will be removed in a later migration.
const TRANSACTION_WRITABLE_FIELDS = [
  'account_id', 'account_type', 'date', 'merchant', 'amount', 'currency',
  'category', 'notes', 'is_subscription', 'basiq_tx_id',
  // Phase 2A foundation fields:
  'source', 'source_ref', 'raw_description', 'merchant_normalized',
  'is_transfer', 'transfer_pair_id', 'review_status', 'confidence',
  'category_source', 'content_hash', 'transaction_type', 'tags',
  'is_tax_deductible', 'deduction_category', 'entity',
  // Phase 2D.1: tax metadata (note + receipt/evidence reference)
  'tax_note', 'receipt_ref',
  // Phase 2B: resolved merchant link
  'merchant_id',
  // Phase 2C: recurring series link, refund link, review reason
  'recurring_series_id', 'refund_of', 'review_reason',
  // Phase 2D.3: AI-suggestion fallback metadata
  'ai_suggested_category', 'ai_suggested_merchant', 'ai_suggested_transaction_type',
  'ai_suggested_reason', 'ai_confidence', 'ai_classified_at',
  // Manual ↔ bank-sync reconciliation lifecycle:
  'reconcile_state', 'reconcile_match_id', 'reconcile_checked_at',
  // WHOSE SPENDING this is, when that differs from who owns the record. A
  // reporting attribution only: balances come from account rows, never from
  // adding transactions up, so it cannot move a dollar of anyone's net worth.
  // (Household sharing is NOT here — it lives in `record_households`.)
  'responsible_user_id',
  'is_duplicate_flagged', // legacy
] as const;

// UUID-typed columns: Postgres rejects an empty string ("") as `22P02 invalid
// input syntax for type uuid`. A transaction saved with no account selected (or a
// cleared transfer link) arrives as account_id:"" — coerce those to NULL so the
// insert/update succeeds instead of 500ing.
const TRANSACTION_UUID_FIELDS = new Set([
  'account_id', 'transfer_pair_id', 'reconcile_match_id',
  // '' into a UUID column is a 22P02, and this arrives empty from a form that
  // means "whoever owns it".
  'responsible_user_id',
]);

/** Keep only allowlisted, defined keys from an arbitrary request body. */
function pickTransactionFields(body: unknown): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of TRANSACTION_WRITABLE_FIELDS) {
    if (src[key] === undefined) continue;
    let value = src[key];
    // Empty string into a UUID column is invalid — treat "unset" as NULL.
    if (TRANSACTION_UUID_FIELDS.has(key) && value === '') value = null;
    out[key] = value;
  }
  return out;
}

async function getPreferredCurrency(userId: string): Promise<string> {
  const { data } = await supabase
    .from('users').select('currency_preference').eq('id', userId).single();
  return data?.currency_preference ?? 'AUD';
}

// Fire-and-forget snapshot after a structural change (add/remove of an account or
// card). Records the new composition immediately so the net-worth "since you started"
// headline treats the item as tracked-from-now, not as a sudden gain/loss.
function snapshotSoon(userId: string): void {
  recordNetWorthSnapshot(userId).catch(err => console.error('[nw] post-change snapshot failed:', err));
}
router.use(authenticate);

const accountSchema = z.object({
  name: z.string().min(1),
  institution: z.string().min(1),
  account_type: z.string(),
  balance: z.number(),
  bsb: z.string().optional(),
  account_number: z.string().optional(),
  currency: z.string().default('AUD'),
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const { data, error } = await scopedQuery(
    supabase.from('bank_accounts').select('*'), scope, 'bank_accounts',
  ).order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  const preferred = await getPreferredCurrency(req.user!.userId);
  const enriched = await enrichWithDisplayAmounts(data ?? [], ['balance'], preferred);
  res.json(await attachHouseholds('account', enriched));
});

router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const { data, error } = await supabase
    .from('bank_accounts')
    // Rows are born PERSONAL. Sharing is a separate act against the join table
    // (see applyHouseholdShare on PUT), never a column smuggled into a create.
    .insert({
      ...parsed.data,
      user_id: req.user!.userId,
      is_manual: true,
    })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.status(201).json(data);
});

// Only real bank_accounts columns may be written. Derived fields the API adds on
// read (display_balance / display_amount) are NOT columns — letting them through
// makes Postgres reject the whole update (500). Whitelist, don't spread req.body.
// NOTE: sharing writes NO column here. Which households a row sits in lives in
// `record_households` and is applied by applyHouseholdShare() from the request's
// `household_ids`, so sharing can never move a balance as a side effect.
const BANK_ACCOUNT_WRITABLE = new Set([
  'name', 'institution', 'account_type', 'balance', 'bsb', 'account_number',
  'currency', 'basiq_account_id', 'is_manual', 'hidden', 'shared_code', 'shared_password_hash',
]);

function pickWritable(body: unknown, allowed: Set<string>): Record<string, unknown> {
  const src = (body ?? {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of allowed) if (src[key] !== undefined) out[key] = src[key];
  return out;
}

router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('bank_accounts', id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  const shareRefusal = await applyHouseholdShare('bank_accounts', id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const fields = pickWritable(req.body, BANK_ACCOUNT_WRITABLE);
  const { data, error } = await supabase
    .from('bank_accounts')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) {
    console.error('[account update] supabase update failed:', {
      code: (error as { code?: string }).code, message: error.message,
      details: (error as { details?: string }).details, fields: Object.keys(fields),
    });
    res.status(500).json({ error: error.message, code: (error as { code?: string }).code }); return;
  }
  res.json(await attachHouseholdsToOne('account', data));
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  // Owner-only, deliberately stricter than editing: deleting a shared account
  // takes it out of its OWNER's finances too, which isn't a shared-view decision
  // to make for somebody else. The household lever is un-sharing.
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseDelete('bank_accounts', id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  await supabase.from('transactions').delete().eq('account_id', id).eq('user_id', req.user!.userId);
  // Anyone this was shared with loses it because it no longer exists; the grant
  // is ended so it stops appearing in the owner's sharing list as well.
  await revokeGrantsFor('bank_accounts', id);
  await supabase.from('bank_accounts').delete().eq('id', id);
  snapshotSoon(req.user!.userId);
  res.json({ success: true });
});

// Credit cards
router.get('/credit-cards', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const { data, error } = await scopedQuery(
    supabase.from('credit_cards').select('*'), scope, 'credit_cards',
  ).order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  const preferred = await getPreferredCurrency(req.user!.userId);
  const enriched = await enrichWithDisplayAmounts(
    data ?? [],
    ['balance_owing', 'credit_limit', 'minimum_payment', 'last_payment_amount'],
    preferred,
  );
  res.json(await attachHouseholds('card', enriched));
});

router.post('/credit-cards', async (req: AuthRequest, res: Response) => {
  // Born personal — sharing is a separate act against the join (see the PATCH).
  const { household_ids: _ignored, household_id: _legacy, ...body } =
    (req.body ?? {}) as Record<string, unknown>;
  const { data, error } = await supabase
    .from('credit_cards')
    .insert({ ...body, user_id: req.user!.userId, is_manual: true })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.status(201).json(data);
});

// Real credit_cards columns only — display_balance_owing is derived on read.
// Sharing writes no column here — see the note on BANK_ACCOUNT_WRITABLE.
const CREDIT_CARD_WRITABLE = new Set([
  'name', 'institution', 'balance_owing', 'credit_limit', 'minimum_payment',
  'due_date', 'currency', 'basiq_account_id', 'is_manual',
  'last_payment_amount', 'last_payment_date',
]);

router.patch('/credit-cards/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('credit_cards', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  const shareRefusal = await applyHouseholdShare('credit_cards', req.params.id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const fields = pickWritable(req.body, CREDIT_CARD_WRITABLE);
  const { data, error } = await supabase
    .from('credit_cards')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .single();
  if (error) {
    console.error('[card update] supabase update failed:', {
      code: (error as { code?: string }).code, message: error.message,
      details: (error as { details?: string }).details, fields: Object.keys(fields),
    });
    res.status(500).json({ error: error.message, code: (error as { code?: string }).code }); return;
  }
  res.json(await attachHouseholdsToOne('card', data));
});

router.delete('/credit-cards/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseDelete('credit_cards', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  await supabase.from('transactions').delete().eq('account_id', req.params.id).eq('user_id', req.user!.userId);
  await revokeGrantsFor('credit_cards', req.params.id);
  await supabase.from('credit_cards').delete().eq('id', req.params.id);
  snapshotSoon(req.user!.userId);
  res.json({ success: true });
});

// Pending payments for a credit card
router.get('/credit-cards/:id/payments', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('pending_payments')
    .select('*')
    .eq('credit_card_id', req.params.id)
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post('/credit-cards/:id/payments', async (req: AuthRequest, res: Response) => {
  const { amount, bank_account_id, status, reconciled_transaction_id } = req.body;
  if (!amount || amount <= 0) { res.status(400).json({ error: 'amount required' }); return; }

  // Verify the target card belongs to the requesting user — never let a payment
  // be attached to another user's credit card.
  const { data: ownCard } = await supabase
    .from('credit_cards')
    .select('id')
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .single();
  if (!ownCard) { res.status(404).json({ error: 'Credit card not found' }); return; }

  const { data: payment, error } = await supabase
    .from('pending_payments')
    .insert({
      credit_card_id: req.params.id,
      bank_account_id: bank_account_id ?? null,
      amount,
      status: status ?? 'pending',
      reconciled_transaction_id: reconciled_transaction_id ?? null,
      user_id: req.user!.userId,
    })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }

  // If creating as pending, do NOT yet touch credit card balance
  // Reconciliation happens via PATCH below
  res.status(201).json(payment);
});

router.patch('/credit-cards/:cardId/payments/:paymentId', async (req: AuthRequest, res: Response) => {
  const { cardId, paymentId } = req.params;

  // Verify ownership — the payment row itself must belong to the requesting user.
  const { data: existing } = await supabase
    .from('pending_payments')
    .select('*')
    .eq('id', paymentId)
    .eq('credit_card_id', cardId)
    .eq('user_id', req.user!.userId)
    .single();

  if (!existing) { res.status(404).json({ error: 'Payment not found' }); return; }

  const { data: updated, error } = await supabase
    .from('pending_payments')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', paymentId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // If reconciling, update credit card balance_owing + last payment fields
  if (req.body.status === 'reconciled') {
    const { data: card } = await supabase
      .from('credit_cards')
      .select('balance_owing')
      .eq('id', cardId)
      .eq('user_id', req.user!.userId)
      .single();

    if (card) {
      const newBalance = Math.max(0, (card.balance_owing ?? 0) - existing.amount);
      await supabase.from('credit_cards').update({
        balance_owing: newBalance,
        last_payment_amount: existing.amount,
        last_payment_date: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      }).eq('id', cardId).eq('user_id', req.user!.userId);
    }
  }

  // If a statement is linked (or we can infer the newest unpaid one), apply the
  // payment to it as well so per-month paid status stays in sync.
  if (req.body.status === 'reconciled') {
    await applyPaymentToStatement(req.user!.userId, cardId, existing.statement_id ?? null, existing.amount);
  }

  res.json(updated);
});

// Delete a payment record. Used when a bank transaction that settled a card is
// deleted and the user opts to reverse the card payment too, so the card is not
// left falsely marked paid.
router.delete('/credit-cards/:cardId/payments/:paymentId', async (req: AuthRequest, res: Response) => {
  const { cardId, paymentId } = req.params;

  const { data: existing } = await supabase
    .from('pending_payments')
    .select('*')
    .eq('id', paymentId)
    .eq('credit_card_id', cardId)
    .eq('user_id', req.user!.userId)
    .single();
  // Idempotent: a missing row is already in the desired state.
  if (!existing) { res.json({ success: true }); return; }

  const { error } = await supabase
    .from('pending_payments').delete()
    .eq('id', paymentId).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Undo the reconciled payment's effect on the card.
  if (existing.status === 'reconciled') {
    if (existing.statement_id) {
      // The client also reverses the linked statement (statement.update, which
      // re-derives the balance). Re-derive here too as an order-independent safety
      // net — never touch the statement here, to avoid double-reversing it.
      await recomputeCardBalance(req.user!.userId, cardId);
    } else {
      // Direct-balance payment (no statement): add the amount back onto owing,
      // mirroring the reconcile PATCH that subtracted it.
      const { data: card } = await supabase
        .from('credit_cards').select('balance_owing')
        .eq('id', cardId).eq('user_id', req.user!.userId).single();
      if (card) {
        await supabase.from('credit_cards').update({
          balance_owing: Math.max(0, (card.balance_owing ?? 0) + existing.amount),
          updated_at: new Date().toISOString(),
        }).eq('id', cardId).eq('user_id', req.user!.userId);
      }
    }
  }

  res.json({ success: true });
});

// ─── Credit card statements ──────────────────────────────────────────────────

// Recompute a card's balance_owing from its remaining unpaid/partial statements,
// and stamp last-payment fields. Keeps the existing utilisation UI accurate.
async function recomputeCardBalance(userId: string, cardId: string, paymentAmount?: number): Promise<void> {
  const { data: stmts } = await supabase
    .from('credit_card_statements')
    .select('closing_balance, amount_paid, status')
    .eq('credit_card_id', cardId)
    .eq('user_id', userId);

  const owing = (stmts ?? []).reduce((sum, s) => {
    if (s.status === 'paid') return sum;
    return sum + Math.max(0, (s.closing_balance ?? 0) - (s.amount_paid ?? 0));
  }, 0);

  const update: Record<string, unknown> = {
    balance_owing: Math.max(0, owing),
    updated_at: new Date().toISOString(),
  };
  if (paymentAmount && paymentAmount > 0) {
    update.last_payment_amount = paymentAmount;
    update.last_payment_date = new Date().toISOString().split('T')[0];
  }
  await supabase.from('credit_cards').update(update)
    .eq('id', cardId).eq('user_id', userId);
}

// Apply a payment amount to a statement (explicit id, else newest unpaid one),
// updating amount_paid/status, then recompute the card balance.
async function applyPaymentToStatement(
  userId: string, cardId: string, statementId: string | null, amount: number,
): Promise<void> {
  let stmt;
  if (statementId) {
    const { data } = await supabase.from('credit_card_statements')
      .select('*').eq('id', statementId).eq('user_id', userId).single();
    stmt = data;
  } else {
    const { data } = await supabase.from('credit_card_statements')
      .select('*').eq('credit_card_id', cardId).eq('user_id', userId)
      .neq('status', 'paid').order('period_end', { ascending: false }).limit(1).maybeSingle();
    stmt = data;
  }
  if (!stmt) { await recomputeCardBalance(userId, cardId, amount); return; }

  const newPaid = (stmt.amount_paid ?? 0) + amount;
  const paid = newPaid >= (stmt.closing_balance ?? 0) - 0.01;
  await supabase.from('credit_card_statements').update({
    amount_paid: newPaid,
    status: paid ? 'paid' : 'partial',
    paid_at: paid ? new Date().toISOString() : stmt.paid_at,
    updated_at: new Date().toISOString(),
  }).eq('id', stmt.id).eq('user_id', userId);

  await recomputeCardBalance(userId, cardId, amount);
}

// List statements — newest first, default 3; `before` pages older ones.
router.get('/credit-cards/:id/statements', async (req: AuthRequest, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 3, 50);
  const before = req.query.before as string | undefined;
  let query = supabase
    .from('credit_card_statements')
    .select('*')
    .eq('credit_card_id', req.params.id)
    .eq('user_id', req.user!.userId)
    .order('period_end', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (before) query = query.lt('period_end', before);

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  const preferred = await getPreferredCurrency(req.user!.userId);
  res.json(await enrichWithDisplayAmounts(data ?? [], ['closing_balance', 'amount_paid'], preferred));
});

router.post('/credit-cards/:id/statements', async (req: AuthRequest, res: Response) => {
  const { data: ownCard } = await supabase
    .from('credit_cards').select('id, currency').eq('id', req.params.id)
    .eq('user_id', req.user!.userId).single();
  if (!ownCard) { res.status(404).json({ error: 'Credit card not found' }); return; }

  const { data, error } = await supabase
    .from('credit_card_statements')
    .insert({
      ...req.body,
      credit_card_id: req.params.id,
      user_id: req.user!.userId,
      currency: req.body.currency ?? ownCard.currency ?? null,
    })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  await recomputeCardBalance(req.user!.userId, req.params.id);
  res.status(201).json(data);
});

router.patch('/credit-cards/:id/statements/:statementId', async (req: AuthRequest, res: Response) => {
  const { id: cardId, statementId } = req.params;
  const { data: existing } = await supabase
    .from('credit_card_statements').select('*')
    .eq('id', statementId).eq('credit_card_id', cardId).eq('user_id', req.user!.userId).single();
  if (!existing) { res.status(404).json({ error: 'Statement not found' }); return; }

  const patch: Record<string, unknown> = { ...req.body, updated_at: new Date().toISOString() };
  if (req.body.status === 'paid' && !req.body.paid_at) patch.paid_at = new Date().toISOString();
  if (req.body.status === 'paid' && req.body.amount_paid == null) patch.amount_paid = existing.closing_balance;

  const { data, error } = await supabase
    .from('credit_card_statements').update(patch)
    .eq('id', statementId).eq('user_id', req.user!.userId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }

  await recomputeCardBalance(req.user!.userId, cardId);
  res.json(data);
});

// Transactions
router.get('/transactions', async (req: AuthRequest, res: Response) => {
  const { account_id, limit = 100, offset = 0, search, since, before } = req.query;

  const scope = await loadScope(req.user!.userId);
  let query = scopedQuery(supabase.from('transactions').select('*'), scope, 'transactions')
    .order('date', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (account_id) query = query.eq('account_id', account_id as string);
  if (search) query = query.ilike('merchant', `%${search}%`);
  // `since` = inclusive lower bound on date (e.g. last-3-months window).
  // `before` = exclusive upper bound, used to page through OLDER history.
  if (since) query = query.gte('date', since as string);
  if (before) query = query.lt('date', before as string);

  const { data, error } = await query;
  if (error) { res.status(500).json({ error: error.message }); return; }
  const preferred = await getPreferredCurrency(req.user!.userId);
  const enriched = await enrichWithDisplayAmounts(data ?? [], ['amount'], preferred);
  res.json(await attachHouseholds('transaction', enriched));
});

router.post('/transactions', async (req: AuthRequest, res: Response) => {
  // Allowlist client-supplied fields, then force server-owned user_id. Born
  // personal — sharing is a separate act against the join (see the PATCH).
  const fields = pickTransactionFields(req.body);
  const { data, error } = await supabase
    .from('transactions')
    .insert({ ...fields, user_id: req.user!.userId })
    .select()
    .single();

  if (error) {
    // Surface the real Postgres/PostgREST cause in Render logs. A recurring 500
    // here is almost always a schema mismatch (missing column / stale PostgREST
    // schema cache) or a type/constraint violation — otherwise invisible because
    // the message previously went only into the response body.
    console.error('[tx create] supabase insert failed:', {
      code: (error as { code?: string }).code,
      message: error.message,
      details: (error as { details?: string }).details,
      hint: (error as { hint?: string }).hint,
      fields: Object.keys(fields),
    });
    res.status(500).json({ error: error.message, code: (error as { code?: string }).code }); return;
  }
  res.status(201).json(data);
});

router.patch('/transactions/:id', async (req: AuthRequest, res: Response) => {
  // Only allowlisted columns are writable — never id/user_id/created_at/updated_at.
  const updates = pickTransactionFields(req.body);
  // A sharing-only request carries no writable column, and is still a real edit.
  const sharesOnly = Array.isArray((req.body as { household_ids?: unknown })?.household_ids);
  if (Object.keys(updates).length === 0 && !sharesOnly) {
    res.status(400).json({ error: 'No writable fields in request body' }); return;
  }
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('transactions', req.params.id, scope);
  // 404 rather than 403 for a row that isn't theirs to know about: the client's
  // idempotent-update layer already treats a 404 as a no-op, so a queued write
  // for a transaction on somebody else's private account is dropped, not retried.
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  const shareRefusal = await applyHouseholdShare('transactions', req.params.id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const { data, error } = await supabase
    .from('transactions')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select()
    .maybeSingle();

  if (error) {
    console.error('[tx update] supabase update failed:', {
      code: (error as { code?: string }).code,
      message: error.message,
      details: (error as { details?: string }).details,
      hint: (error as { hint?: string }).hint,
      fields: Object.keys(updates),
    });
    res.status(500).json({ error: error.message, code: (error as { code?: string }).code }); return;
  }
  // No row matched — the transaction isn't on the server yet (its create is still
  // in flight/queued). Return 404 so the client's idempotent-update layer treats
  // this as a no-op instead of retrying a doomed write forever.
  if (!data) { res.status(404).json({ error: 'Transaction not found' }); return; }
  res.json(await attachHouseholdsToOne('transaction', data));
});

router.delete('/transactions/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseDelete('transactions', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  await revokeGrantsFor('transactions', req.params.id);
  await supabase.from('transactions').delete().eq('id', req.params.id);
  res.json({ success: true });
});

// Subscriptions
router.get('/subscriptions', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  const preferred = await getPreferredCurrency(req.user!.userId);
  res.json(await enrichWithDisplayAmounts(data ?? [], ['amount'], preferred));
});

router.post('/subscriptions', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('subscriptions')
    .insert({ ...req.body, user_id: req.user!.userId, is_auto_detected: false })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.patch('/subscriptions/:id', async (req: AuthRequest, res: Response) => {
  // Allowlisted fields that may be patched via this endpoint
  const { name, account_id, amount, frequency, next_charge_date, category } = req.body as {
    name?: string;
    account_id?: string | null;
    amount?: number;
    frequency?: string;
    next_charge_date?: string;
    category?: string;
  };
  const updates: Record<string, unknown> = {};
  if (name             !== undefined) updates.name             = name;
  if (account_id       !== undefined) updates.account_id       = account_id;  // null = unlink
  if (amount           !== undefined) updates.amount           = amount;
  if (frequency        !== undefined) updates.frequency        = frequency;
  if (next_charge_date !== undefined) updates.next_charge_date = next_charge_date;
  if (category         !== undefined) updates.category         = category;

  const { data, error } = await supabase
    .from('subscriptions')
    .update(updates)
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/subscriptions/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('subscriptions').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

export default router;
