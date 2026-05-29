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

  // Verify ownership
  const { data: existing } = await supabase
    .from('pending_payments')
    .select('*, credit_cards!inner(user_id)')
    .eq('id', paymentId)
    .eq('credit_card_id', cardId)
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
      .single();

    if (card) {
      const newBalance = Math.max(0, (card.balance_owing ?? 0) - existing.amount);
      await supabase.from('credit_cards').update({
        balance_owing: newBalance,
        last_payment_amount: existing.amount,
        last_payment_date: new Date().toISOString().split('T')[0],
        updated_at: new Date().toISOString(),
      }).eq('id', cardId);
    }
  }

  res.json(updated);
});

// Transactions
router.get('/transactions', async (req: AuthRequest, res: Response) => {
  const { account_id, limit = 100, offset = 0, search } = req.query;

  let query = supabase
    .from('transactions')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('date', { ascending: false })
    .range(Number(offset), Number(offset) + Number(limit) - 1);

  if (account_id) query = query.eq('account_id', account_id as string);
  if (search) query = query.ilike('merchant', `%${search}%`);

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
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
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

router.delete('/subscriptions/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('subscriptions').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

export default router;
