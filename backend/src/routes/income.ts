import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { syncDividends } from '../services/dividendService';
import { enrichWithDisplayAmounts } from '../services/currencyService';
import {
  loadScope, scopedQuery, refuseWrite, refuseDelete, revokeGrantsFor,
  applyHouseholdShare, attachHouseholds, attachHouseholdsToOne,
} from '../services/householdScope';

const router = Router();
router.use(authenticate);

/** The `:id` route param — tiny helper so guards above the destructure read clean. */
const id_of = (req: AuthRequest): string => req.params.id as string;

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
  // The visible SUPERSET: own entries plus ones shared to this user's
  // households or granted directly. The client narrows to the active scope at
  // read time — the same contract every other shareable entity keeps.
  const scope = await loadScope(req.user!.userId);
  const { data, error } = await scopedQuery(
    supabase.from('income_entries').select('*'), scope, 'income_entries',
  ).order('date', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }

  const { data: user } = await supabase
    .from('users').select('currency_preference').eq('id', req.user!.userId).single();
  const preferred = user?.currency_preference ?? 'AUD';

  const enriched = await enrichWithDisplayAmounts(
    data ?? [],
    ['amount', 'tax_withheld', 'super_contribution'],
    preferred,
  );

  // The server's projection is the OWNER's: income somebody shared into view is
  // their money and never inflates this user's own annual figure. (The client
  // recomputes per-scope anyway; this keeps the API's number honest.)
  const recurring = enriched.filter(i =>
    i.is_recurring && (!i.user_id || i.user_id === req.user!.userId));
  const projectedAnnual = recurring.reduce((sum, i) => {
    const multipliers: Record<string, number> = {
      weekly: 52, fortnightly: 26, monthly: 12, quarterly: 4, annually: 1,
    };
    return sum + (i.display_amount as number) * (multipliers[i.frequency as string] ?? 1);
  }, 0);

  res.json({
    entries: await attachHouseholds('income', enriched),
    projected_annual: projectedAnnual,
  });
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
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('income_entries', id_of(req), scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  // Sharing writes NO column on the row. Which households the entry sits in
  // lives in `record_households` and is reconciled from the request's
  // `household_ids` — so a share can never move an amount as a side effect.
  const shareRefusal = await applyHouseholdShare('income_entries', id_of(req), scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const updates: Record<string, unknown> = { ...req.body, updated_at: new Date().toISOString() };
  delete updates.household_ids;   // join-table state, not a column
  delete updates.household_id;    // legacy column, never a real one here
  delete updates.user_id;         // ownership never moves through an update
  delete updates.display_amount;  // derived display shapes, not columns
  delete updates.display_tax_withheld;
  delete updates.display_super_contribution;
  delete updates.display_currency;

  // Ownership/permission was already settled by refuseWrite: an edit-granted
  // member may correct a shared entry, so the match is by id alone.
  const { data, error } = await supabase
    .from('income_entries')
    .update(updates)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(await attachHouseholdsToOne('income', data));
});

router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseDelete('income_entries', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }
  await revokeGrantsFor('income_entries', req.params.id);
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
