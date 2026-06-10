import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { syncDividends } from '../services/dividendService';
import { enrichWithDisplayAmounts } from '../services/currencyService';

const router = Router();
router.use(authenticate);

// On-demand dividend sync for the signed-in user. Checks each dividend-paying
// holding for dividends paid this financial year and creates pending income
// entries for any new ones (the same work the twice-daily cron does globally).
router.post('/dividends/sync', async (req: AuthRequest, res: Response) => {
  try {
    const result = await syncDividends(req.user!.userId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('income_entries')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('date', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }

  const { data: user } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  const preferred = user?.currency_preference ?? 'AUD';

  const enriched = await enrichWithDisplayAmounts(
    data ?? [],
    ['amount', 'tax_withheld', 'super_contribution'],
    preferred,
  );

  const recurring = enriched.filter(i => i.is_recurring);
  const projectedAnnual = recurring.reduce((sum, i) => {
    const multipliers: Record<string, number> = {
      weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, annually: 1,
    };
    return sum + (i.display_amount as number) * (multipliers[i.frequency as string] ?? 1);
  }, 0);

  res.json({ entries: enriched, projected_annual: projectedAnnual });
});

router.post('/', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('income_entries')
    .insert({ ...req.body, user_id: req.user!.userId, status: 'approved' })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('income_entries')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  await supabase.from('income_entries').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  res.json({ success: true });
});

router.post('/:id/approve', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('income_entries')
    .update({ status: 'approved' })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// Tax
router.get('/tax', async (req: AuthRequest, res: Response) => {
  const currentYear = new Date().getMonth() >= 6
    ? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`
    : `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`;

  const fy = (req.query.fy as string) ?? currentYear;

  const [{ data: taxRecord }, { data: deductions }, { data: brackets }] = await Promise.all([
    supabase.from('tax_records').select('*').eq('user_id', req.user!.userId).eq('financial_year', fy).single(),
    supabase.from('tax_deductions').select('*').eq('user_id', req.user!.userId).eq('financial_year', fy),
    supabase.from('tax_brackets').select('*').eq('financial_year', fy).order('min_income'),
  ]);

  res.json({ tax_record: taxRecord, deductions: deductions ?? [], brackets: brackets ?? [] });
});

router.post('/tax/deductions', async (req: AuthRequest, res: Response) => {
  const currentYear = new Date().getMonth() >= 6
    ? `${new Date().getFullYear()}-${new Date().getFullYear() + 1}`
    : `${new Date().getFullYear() - 1}-${new Date().getFullYear()}`;

  const { data, error } = await supabase
    .from('tax_deductions')
    .insert({ ...req.body, user_id: req.user!.userId, financial_year: currentYear })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

export default router;
