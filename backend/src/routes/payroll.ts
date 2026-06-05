import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { financialYearFor } from './smsf';

const router = Router();
router.use(authenticate);

// ── Super Guarantee rate by financial year (percent) ──────────────────────────
// Kept here (not hardcoded inline) so the on-track check uses the correct rate for
// the period: 11% (2023-24), 11.5% (2024-25), then 12% from 2025-26 onward.
const SG_RATES: Record<string, number> = {
  '2023-24': 11,
  '2024-25': 11.5,
  '2025-26': 12,
  '2026-27': 12,
};
export function sgRateForFY(fy: string): number {
  return SG_RATES[fy] ?? 12;
}

/**
 * The Super Guarantee quarter + statutory payment due date for a given date.
 * SG is paid quarterly; the employer must pay by the 28th of the month after
 * each quarter ends.
 */
function sgQuarter(d: Date): { quarter: string; due: string } {
  const m = d.getMonth(); // 0 = Jan
  const y = d.getFullYear();
  if (m <= 2)  return { quarter: `Jan-Mar ${y}`, due: `${y}-04-28` };
  if (m <= 5)  return { quarter: `Apr-Jun ${y}`, due: `${y}-07-28` };
  if (m <= 8)  return { quarter: `Jul-Sep ${y}`, due: `${y}-10-28` };
  return { quarter: `Oct-Dec ${y}`, due: `${y + 1}-01-28` };
}

// ── Aggregate read: payslips + pending/matched super ledger + SG rate ─────────
router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const fy = financialYearFor();

  const [payslips, expected] = await Promise.all([
    supabase.from('payslips').select('*').eq('user_id', userId).order('payment_date', { ascending: false, nullsFirst: false }),
    supabase.from('expected_super_contributions').select('*').eq('user_id', userId).order('expected_payment_date', { ascending: true }),
  ]);

  res.json({
    financial_year: fy,
    sg_rate: sgRateForFY(fy),
    payslips: payslips.data ?? [],
    expected_super: expected.data ?? [],
  });
});

// ── Create payslip (+ pending employer-super ledger entry) ────────────────────
router.post('/payslips', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const b = req.body ?? {};

  const { data: payslip, error } = await supabase.from('payslips').insert({
    user_id: userId,
    employer: b.employer ?? 'Employer',
    abn: b.abn || null,
    employee_name: b.employee_name || null,
    employment_type: b.employment_type ?? 'full_time',
    pay_period_start: b.pay_period_start || null,
    pay_period_end: b.pay_period_end || null,
    payment_date: b.payment_date || null,
    pay_frequency: b.pay_frequency ?? 'fortnightly',
    gross_pay: b.gross_pay ?? 0,
    net_pay: b.net_pay ?? 0,
    tax_withheld: b.tax_withheld ?? 0,
    super_amount: b.super_amount ?? 0,
    super_rate: b.super_rate ?? null,
    ytd_gross: b.ytd_gross ?? null,
    ytd_tax: b.ytd_tax ?? null,
    ytd_super: b.ytd_super ?? null,
    leave_balance: b.leave_balance ?? null,
    sick_leave_balance: b.sick_leave_balance ?? null,
    hourly_rate: b.hourly_rate ?? null,
    allowances: Array.isArray(b.allowances) ? b.allowances : [],
    deductions: Array.isArray(b.deductions) ? b.deductions : [],
    cycle_label: b.cycle_label || null,
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Add the employer super amount to the pending contributions ledger, grouped by
  // the SG quarter it relates to (based on the pay period end, or payment date).
  const superAmt = Number(b.super_amount ?? 0);
  if (superAmt > 0) {
    const refDate = b.pay_period_end || b.payment_date || new Date().toISOString().slice(0, 10);
    const { quarter, due } = sgQuarter(new Date(refDate));
    await supabase.from('expected_super_contributions').insert({
      user_id: userId,
      payslip_id: payslip.id,
      employer: payslip.employer,
      amount: superAmt,
      pay_period_start: b.pay_period_start || null,
      pay_period_end: b.pay_period_end || null,
      expected_payment_date: due,
      quarter,
      financial_year: financialYearFor(new Date(refDate)),
      status: 'pending',
    });
  }

  res.status(201).json(payslip);
});

router.delete('/payslips/:id', async (req: AuthRequest, res: Response) => {
  // Pending ledger rows cascade-delete via payslip_id FK.
  const { error } = await supabase.from('payslips')
    .delete().eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── Reconcile a super fund statement against the pending ledger ────────────────
// Compares total EXPECTED employer super (sum of pending entries for the FY)
// against what the statement says actually landed. Within $50 → likely fees;
// a larger shortfall is flagged prominently (possible employer underpayment).
router.post('/reconcile-super', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const received = Number(req.body?.employer_contributions ?? 0);
  const fy = req.body?.financial_year || financialYearFor();
  const TOLERANCE = 50;

  const { data: pending } = await supabase
    .from('expected_super_contributions')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .eq('financial_year', fy);

  const rows = pending ?? [];
  const expected = rows.reduce((s, r) => s + Number(r.amount), 0);
  const difference = Number((received - expected).toFixed(2));
  const withinTolerance = Math.abs(difference) <= TOLERANCE;

  // Mark the reconciled pending entries as matched (cleared from the ledger).
  if (rows.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    await supabase
      .from('expected_super_contributions')
      .update({ status: 'matched', matched_on: today })
      .eq('user_id', userId)
      .eq('status', 'pending')
      .eq('financial_year', fy);
  }

  // flag: ok (matches/within tolerance) | minor (small diff) | shortfall (employer
  // appears to be underpaying — received materially less than expected).
  let flag: 'ok' | 'minor' | 'shortfall' = 'ok';
  if (!withinTolerance) flag = difference < 0 ? 'shortfall' : 'minor';

  res.json({
    financial_year: fy,
    expected: Number(expected.toFixed(2)),
    received: Number(received.toFixed(2)),
    difference,
    within_tolerance: withinTolerance,
    tolerance: TOLERANCE,
    matched_count: rows.length,
    flag,
  });
});

export default router;
