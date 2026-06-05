import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { z } from 'zod';

const router = Router();
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
  const { data, error } = await supabase
    .from('bank_accounts')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = accountSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const { data, error } = await supabase
    .from('bank_accounts')
    .insert({ ...parsed.data, user_id: req.user!.userId, is_manual: true })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { data: existing } = await supabase
    .from('bank_accounts').select('user_id').eq('id', id).single();
  if (!existing || existing.user_id !== req.user!.userId) {
    res.status(404).json({ error: 'Account not found' }); return;
  }

  const { data, error } = await supabase
    .from('bank_accounts')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { data: existing } = await supabase
    .from('bank_accounts').select('user_id').eq('id', id).single();
  if (!existing || existing.user_id !== req.user!.userId) {
    res.status(404).json({ error: 'Account not found' }); return;
  }

  await supabase.from('transactions').delete().eq('account_id', id).eq('user_id', req.user!.userId);
  await supabase.from('bank_accounts').delete().eq('id', id);
  res.json({ success: true });
});

// Credit cards
router.get('/credit-cards', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('credit_cards')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.post('/credit-cards', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('credit_cards')
    .insert({ ...req.body, user_id: req.user!.userId, is_manual: true })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.patch('/credit-cards/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('credit_cards')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/credit-cards/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('transactions').delete().eq('account_id', req.params.id).eq('user_id', req.user!.userId);
  await supabase.from('credit_cards').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
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

  res.json(updated);
});

// Transactions
router.get('/transactions', async (req: AuthRequest, res: Response) => {
  const { account_id, limit = 100, offset = 0, search, since, before } = req.query;

  let query = supabase
    .from('transactions')
    .select('*')
    .eq('user_id', req.user!.userId)
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
  res.json(data);
});

router.post('/transactions', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('transactions')
    .insert({ ...req.body, user_id: req.user!.userId })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.patch('/transactions/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('transactions')
    .update(req.body)
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .maybeSingle();

  if (error) { res.status(500).json({ error: error.message }); return; }
  // No row matched — the transaction isn't on the server yet (its create is still
  // in flight/queued). Return 404 so the client's idempotent-update layer treats
  // this as a no-op instead of retrying a doomed write forever.
  if (!data) { res.status(404).json({ error: 'Transaction not found' }); return; }
  res.json(data);
});

router.delete('/transactions/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('transactions').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
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
  res.json(data);
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
