import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { getRate } from '../services/currencyService';
import { enrichInvestment } from './investments';

const router = Router();
router.use(authenticate);

const VALID_FREQ = new Set(['weekly', 'fortnightly', 'monthly', 'quarterly', 'annually']);

// Advance a YYYY-MM-DD date by one period of the given frequency (UTC-anchored so
// the calendar date never drifts across DST).
function advance(iso: string, freq: string): string {
  const d = new Date(iso + 'T00:00:00Z');
  switch (freq) {
    case 'weekly':      d.setUTCDate(d.getUTCDate() + 7); break;
    case 'fortnightly': d.setUTCDate(d.getUTCDate() + 14); break;
    case 'monthly':     d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'quarterly':   d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'annually':    d.setUTCFullYear(d.getUTCFullYear() + 1); break;
    default:            d.setUTCMonth(d.getUTCMonth() + 1); break;
  }
  return d.toISOString().slice(0, 10);
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

// Create / update / delete the reminder bill that mirrors a plan, so contributions
// flow through the existing briefing + Telegram reminder pipeline.
async function upsertPlanBill(
  userId: string,
  plan: { id: string; name: string; amount: number; currency: string; frequency: string; next_date: string; bill_id: string | null },
): Promise<string | null> {
  const billPayload = {
    name: `Invest: ${plan.name}`,
    amount: plan.amount,
    due_date: plan.next_date,
    is_recurring: true,
    frequency: plan.frequency,
    kind: 'reminder' as const,
    category: 'Investing',
    colour: 'grey' as const,
  };
  if (plan.bill_id) {
    const { data } = await supabase
      .from('bills').update(billPayload).eq('id', plan.bill_id).eq('user_id', userId).select('id').maybeSingle();
    if (data?.id) return data.id;
    // Linked bill vanished (e.g. user deleted it) — fall through to recreate.
  }
  const { data, error } = await supabase
    .from('bills').insert({ ...billPayload, user_id: userId, is_paid: false }).select('id').single();
  if (error) { console.error('[PLAN BILL] create failed:', error.message); return null; }
  return data.id;
}

// ── GET /api/investment-plans ─────────────────────────────────────────────────
// List the user's plans, joined with the linked holding name and auto-payment name.
router.get('/', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('investment_plans')
    .select('*, investment:investments(id, name, ticker, native_currency), subscription:subscriptions(id, name)')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// Does a transaction's merchant look like the subscription? Lenient substring
// match either way (handles "VANGUARD INVST" vs "Vanguard"), case-insensitive.
function merchantMatches(merchant: string, ...names: (string | null | undefined)[]): boolean {
  const m = (merchant || '').toLowerCase().trim();
  if (!m) return false;
  return names.some(n => {
    const name = (n || '').toLowerCase().trim();
    if (name.length < 3) return false;
    return m.includes(name) || name.includes(m);
  });
}

// ── GET /api/investment-plans/due ─────────────────────────────────────────────
// Plans we should prompt the user about. Two triggers:
//   1. schedule  — the plan's next_date has arrived (and wasn't actioned yet)
//   2. transaction — a debit matching the linked auto-payment actually landed in
//      the user's accounts since the last confirmed contribution
// Transaction detection wins (it carries the real date + amount). Drives the
// "did you invest?" popup when the user opens the Investments tab.
router.get('/due', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const today = todayISO();
  const { data: plans, error } = await supabase
    .from('investment_plans')
    .select('*, investment:investments(id, name, ticker, native_currency, current_price), subscription:subscriptions(id, name, original_name, amount, currency)')
    .eq('user_id', userId)
    .eq('is_active', true);
  if (error) { res.status(500).json({ error: error.message }); return; }

  const due: Record<string, unknown>[] = [];
  for (const p of plans ?? []) {
    const actionedThrough = p.last_contributed_on || '1900-01-01';

    // ── Trigger 2: a real matching debit since the last confirmed contribution ──
    let detected: { date: string; amount: number } | null = null;
    if (p.subscription) {
      const sub = p.subscription as { name?: string; original_name?: string; amount?: number };
      const { data: txns } = await supabase
        .from('transactions')
        .select('date, merchant, amount')
        .eq('user_id', userId)
        .gt('date', actionedThrough)
        .lte('date', today)
        .order('date', { ascending: false })
        .limit(60);
      const subAmt = Math.abs(Number(sub.amount) || 0);
      const match = (txns ?? []).find(t => {
        if (!merchantMatches(t.merchant, sub.name, sub.original_name)) return false;
        if (!subAmt) return true;
        const amt = Math.abs(Number(t.amount) || 0);
        return Math.abs(amt - subAmt) <= Math.max(1, subAmt * 0.05); // within 5% or $1
      });
      if (match) detected = { date: match.date as string, amount: Math.abs(Number(match.amount) || 0) };
    }

    // ── Trigger 1: schedule due and not yet actioned for this cycle ──
    const scheduleDue = p.next_date <= today && (!p.last_contributed_on || p.last_contributed_on < p.next_date);

    if (detected) {
      due.push({ ...p, source: 'transaction', detected_date: detected.date, detected_amount: detected.amount });
    } else if (scheduleDue) {
      due.push({ ...p, source: 'schedule', detected_date: null, detected_amount: null });
    }
  }
  res.json(due);
});

// ── POST /api/investment-plans ────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const { name, amount, currency, frequency, next_date, investment_id, subscription_id } = req.body;
  if (!name || amount == null || !frequency || !next_date) {
    res.status(400).json({ error: 'name, amount, frequency and next_date are required.' }); return;
  }
  if (!VALID_FREQ.has(frequency)) { res.status(400).json({ error: 'Invalid frequency.' }); return; }

  const { data: prefUser } = await supabase
    .from('users').select('currency_preference').eq('id', userId).single();
  const planCurrency = currency || prefUser?.currency_preference || 'AUD';

  const { data: plan, error } = await supabase
    .from('investment_plans')
    .insert({
      user_id: userId,
      name,
      amount: Number(amount) || 0,
      currency: planCurrency,
      frequency,
      next_date,
      investment_id: investment_id || null,
      subscription_id: subscription_id || null,
    })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Spawn the recurring reminder bill and link it back to the plan.
  const billId = await upsertPlanBill(userId, { ...plan, bill_id: null });
  if (billId) {
    await supabase.from('investment_plans').update({ bill_id: billId }).eq('id', plan.id);
    plan.bill_id = billId;
  }
  res.status(201).json(plan);
});

// ── PUT /api/investment-plans/:id ─────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const allowed = ['name', 'amount', 'currency', 'frequency', 'next_date', 'investment_id', 'subscription_id', 'is_active'];
  const updates: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];
  if ('frequency' in updates && !VALID_FREQ.has(updates.frequency as string)) {
    res.status(400).json({ error: 'Invalid frequency.' }); return;
  }
  if ('investment_id' in updates && !updates.investment_id) updates.investment_id = null;
  if ('subscription_id' in updates && !updates.subscription_id) updates.subscription_id = null;

  const { data: plan, error } = await supabase
    .from('investment_plans').update(updates).eq('id', req.params.id).eq('user_id', userId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }

  // Keep the reminder bill in sync with the plan's schedule/amount.
  const billId = await upsertPlanBill(userId, plan);
  if (billId && billId !== plan.bill_id) {
    await supabase.from('investment_plans').update({ bill_id: billId }).eq('id', plan.id);
    plan.bill_id = billId;
  }
  res.json(plan);
});

// ── DELETE /api/investment-plans/:id ──────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const { data: plan } = await supabase
    .from('investment_plans').select('bill_id').eq('id', req.params.id).eq('user_id', userId).single();
  if (plan?.bill_id) await supabase.from('bills').delete().eq('id', plan.bill_id).eq('user_id', userId);
  const { error } = await supabase
    .from('investment_plans').delete().eq('id', req.params.id).eq('user_id', userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── POST /api/investment-plans/:id/confirm ────────────────────────────────────
// The user answered the "did you invest?" popup. confirmed=true adds the
// contribution to the linked holding (correct FX both ways); either way we mark the
// current cycle as actioned and roll the schedule forward to the next contribution.
router.post('/:id/confirm', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const confirmed = req.body.confirmed !== false; // default true
  // Optional overrides if the user knows exact figures from their broker, or if a
  // matching debit was detected (its real amount/date supersede the plan estimate).
  const overrideAmount = req.body.amount != null ? Number(req.body.amount) : null;
  const overrideUnits = req.body.units != null ? Number(req.body.units) : null;
  const contributedOn: string | null = req.body.contributed_on || null;

  const { data: plan, error } = await supabase
    .from('investment_plans').select('*').eq('id', req.params.id).eq('user_id', userId).single();
  if (error || !plan) { res.status(404).json({ error: 'Plan not found.' }); return; }

  let updatedInvestment = null;

  if (confirmed && plan.investment_id) {
    const { data: inv } = await supabase
      .from('investments').select('*').eq('id', plan.investment_id).eq('user_id', userId).single();
    if (inv) {
      const { data: prefUser } = await supabase
        .from('users').select('currency_preference').eq('id', userId).single();
      const preferred = prefUser?.currency_preference || 'AUD';
      const native = inv.native_currency || preferred;
      const contribCcy = plan.currency || preferred;
      const contribAmount = overrideAmount != null ? overrideAmount : Number(plan.amount) || 0;

      // Cost is LOCKED in preferred currency (never re-converted by FX). Convert the
      // contribution into preferred ONCE and add it to the existing locked cost.
      const toPreferred = contribCcy === preferred ? 1 : await getRate(contribCcy, preferred);
      const addedCostPref = parseFloat((contribAmount * toPreferred).toFixed(2));

      // Units bought ≈ contribution (in the holding's native currency) ÷ current
      // native price. Use the broker figure if the user gave one.
      let addedUnits = overrideUnits ?? 0;
      if (addedUnits === 0 && Number(inv.current_price) > 0) {
        const toNative = contribCcy === native ? 1 : await getRate(contribCcy, native);
        const contribNative = contribAmount * toNative;
        addedUnits = parseFloat((contribNative / Number(inv.current_price)).toFixed(8));
      }

      const newShares = parseFloat(((Number(inv.shares_owned) || 0) + addedUnits).toFixed(8));
      // Existing cost is already in preferred (cost_basis_currency = preferred). For
      // legacy native-denominated rows, fold the new cost in at the native equivalent
      // so we don't mix currencies.
      const costCcy = inv.cost_basis_currency || preferred;
      const addedCost = costCcy === preferred
        ? addedCostPref
        : parseFloat((contribAmount * (contribCcy === costCcy ? 1 : await getRate(contribCcy, costCcy))).toFixed(2));
      const newCost = parseFloat(((Number(inv.cost_basis) || 0) + addedCost).toFixed(2));
      const newValue = parseFloat((newShares * (Number(inv.current_price) || 0)).toFixed(2));

      const { data: saved } = await supabase
        .from('investments')
        .update({ shares_owned: newShares, cost_basis: newCost, current_value: newValue })
        .eq('id', inv.id).select().single();
      if (saved) updatedInvestment = await enrichInvestment(saved, preferred);
    }
  }

  // Mark this cycle done as of the date the contribution actually happened (the
  // detected debit date when present, else the scheduled date), then roll the
  // schedule forward until it's strictly after that — so a transaction-triggered
  // confirm and a schedule-triggered one both converge and never re-prompt.
  const actionedOn = contributedOn || plan.next_date;
  let newNext = plan.next_date;
  let rolls = 0;
  while (newNext <= actionedOn && rolls++ < 400) newNext = advance(newNext, plan.frequency);
  await supabase
    .from('investment_plans')
    .update({ last_contributed_on: actionedOn, next_date: newNext })
    .eq('id', plan.id);

  // Keep the reminder bill pointed at the new contribution date.
  if (plan.bill_id) {
    await supabase.from('bills').update({ due_date: newNext, is_paid: false }).eq('id', plan.bill_id).eq('user_id', userId);
  }

  res.json({ success: true, confirmed, next_date: newNext, investment: updatedInvestment });
});

export default router;
