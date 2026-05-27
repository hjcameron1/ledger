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

router.delete('/credit-cards/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('credit_cards').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
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
