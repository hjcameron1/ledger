import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';

const router = Router();
router.use(authenticate);

/** Australian financial year (starts 1 July) for a given date, e.g. "2025-26". */
export function financialYearFor(date = new Date()): string {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0 = Jan
  const startYear = m >= 6 ? y : y - 1; // July (6) onward → this year
  const endShort = String((startYear + 1) % 100).padStart(2, '0');
  return `${startYear}-${endShort}`;
}

// ── Aggregate read: funds + members (with cap usage) + assets + contributions ──
router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const fy = financialYearFor();

  const [funds, members, assets, contributions, caps] = await Promise.all([
    supabase.from('smsf_funds').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('smsf_members').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('smsf_assets').select('*').eq('user_id', userId).order('created_at'),
    supabase.from('smsf_contributions').select('*').eq('user_id', userId).order('contributed_on', { ascending: false }),
    supabase.from('super_contribution_caps').select('*'),
  ]);

  const capsRows = caps.data ?? [];
  const capFor = (type: string, year = fy) =>
    Number(capsRows.find(c => c.cap_type === type && c.financial_year === year)?.amount ?? 0);

  const concessionalCap = capFor('concessional');
  const nonConcessionalCap = capFor('non_concessional');

  // Per-member running totals for the CURRENT financial year, vs caps.
  const membersWithUsage = (members.data ?? []).map(m => {
    const mine = (contributions.data ?? []).filter(c => c.member_id === m.id && c.financial_year === fy);
    const concessional_used = mine
      .filter(c => c.contribution_type === 'concessional')
      .reduce((s, c) => s + Number(c.amount), 0);
    const non_concessional_used = mine
      .filter(c => c.contribution_type === 'non_concessional')
      .reduce((s, c) => s + Number(c.amount), 0);
    return {
      ...m,
      concessional_used,
      non_concessional_used,
      concessional_cap: concessionalCap,
      non_concessional_cap: nonConcessionalCap,
    };
  });

  res.json({
    financial_year: fy,
    funds: funds.data ?? [],
    members: membersWithUsage,
    assets: assets.data ?? [],
    contributions: contributions.data ?? [],
    caps: capsRows,
  });
});

// ── Funds ─────────────────────────────────────────────────────────────────────
router.post('/funds', async (req: AuthRequest, res: Response) => {
  const { name, abn, trustee_type, is_audited, last_audited_on, audit_due_on } = req.body;
  const { data, error } = await supabase.from('smsf_funds').insert({
    user_id: req.user!.userId,
    name,
    abn: abn || null,
    trustee_type: trustee_type ?? 'individual',
    is_audited: is_audited ?? false,
    last_audited_on: last_audited_on || null,
    audit_due_on: audit_due_on || null,
  }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/funds/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('smsf_funds')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('user_id', req.user!.userId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/funds/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('smsf_funds')
    .delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Members ───────────────────────────────────────────────────────────────────
router.post('/members', async (req: AuthRequest, res: Response) => {
  const { fund_id, full_name, balance, total_super_balance } = req.body;
  const { data, error } = await supabase.from('smsf_members').insert({
    user_id: req.user!.userId,
    fund_id,
    full_name,
    balance: balance ?? 0,
    total_super_balance: total_super_balance ?? null,
  }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/members/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('smsf_members')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('user_id', req.user!.userId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/members/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('smsf_members')
    .delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Assets ────────────────────────────────────────────────────────────────────
router.post('/assets', async (req: AuthRequest, res: Response) => {
  const { fund_id, asset_type, label, amount } = req.body;
  const { data, error } = await supabase.from('smsf_assets').insert({
    user_id: req.user!.userId,
    fund_id, asset_type, label, amount: amount ?? 0,
  }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.put('/assets/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('smsf_assets')
    .update({ ...req.body, updated_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('user_id', req.user!.userId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

router.delete('/assets/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('smsf_assets')
    .delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Contributions ─────────────────────────────────────────────────────────────
router.post('/contributions', async (req: AuthRequest, res: Response) => {
  const { member_id, contribution_type, amount, contributed_on } = req.body;
  const financial_year = req.body.financial_year || financialYearFor(
    contributed_on ? new Date(contributed_on) : new Date()
  );
  const { data, error } = await supabase.from('smsf_contributions').insert({
    user_id: req.user!.userId,
    member_id,
    contribution_type,
    amount: amount ?? 0,
    contributed_on: contributed_on || new Date().toISOString().slice(0, 10),
    financial_year,
  }).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

router.delete('/contributions/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('smsf_contributions')
    .delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
