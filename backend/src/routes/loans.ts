import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { z } from 'zod';

const router = Router();
router.use(authenticate);

const LOAN_TYPES = ['mortgage', 'personal', 'car', 'hecs'] as const;
const FREQUENCIES = ['weekly', 'fortnightly', 'monthly'] as const;

const loanSchema = z.object({
  name: z.string().min(1),
  loan_type: z.enum(LOAN_TYPES),
  lender: z.string().nullable().optional(),
  original_amount: z.number().nonnegative().default(0),
  current_balance: z.number().nonnegative().default(0),
  interest_rate: z.number().nullable().optional(),
  minimum_repayment: z.number().nullable().optional(),
  repayment_frequency: z.enum(FREQUENCIES).default('monthly'),
  next_due_date: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  include_in_net_worth: z.boolean().optional(),
});

// Partial schema for updates — every field optional.
const loanUpdateSchema = loanSchema.partial();

interface LoanRow {
  id: string;
  name: string;
  minimum_repayment: number | null;
  next_due_date: string | null;
  repayment_frequency: string | null;
}

const repaymentBillName = (loanName: string): string => `${loanName} repayment`;

/**
 * Mirror a loan's repayment schedule into the `bills` table so it shows up in
 * Bills & Reminders and the morning briefing. The bill is linked back to the loan
 * by bills.loan_id, so renames/edits update the same row instead of duplicating.
 *
 * - A bill is created/updated only when the loan has BOTH a minimum_repayment and
 *   a next_due_date (otherwise there's no payable schedule to mirror).
 * - If the schedule is removed, any existing mirrored bill is deleted.
 *
 * Wrapped so a failure here (e.g. the bills.loan_id migration not yet run) never
 * blocks the loan write itself.
 */
async function syncLoanBill(userId: string, loan: LoanRow): Promise<void> {
  try {
    const { data: existing } = await supabase
      .from('bills')
      .select('id')
      .eq('user_id', userId)
      .eq('loan_id', loan.id)
      .maybeSingle();

    const hasSchedule =
      loan.minimum_repayment != null && loan.minimum_repayment > 0 && !!loan.next_due_date;

    if (!hasSchedule) {
      if (existing) await supabase.from('bills').delete().eq('id', existing.id);
      return;
    }

    const fields = {
      name: repaymentBillName(loan.name),
      amount: loan.minimum_repayment,
      due_date: loan.next_due_date,
      frequency: loan.repayment_frequency ?? 'monthly',
      is_recurring: true,
      category: 'loan',
      auto_pay: false,
      kind: 'bill',
    };

    if (existing) {
      await supabase
        .from('bills')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await supabase
        .from('bills')
        .insert({ ...fields, user_id: userId, loan_id: loan.id, is_paid: false });
    }
  } catch (err) {
    console.error('[loans] syncLoanBill failed:', err instanceof Error ? err.message : err);
  }
}

// ── GET /api/loans ────────────────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('loans')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

// ── POST /api/loans ───────────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = loanSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const { data, error } = await supabase
    .from('loans')
    .insert({ ...parsed.data, user_id: req.user!.userId })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  await syncLoanBill(req.user!.userId, data as LoanRow);
  res.status(201).json(data);
});

// ── PUT /api/loans/:id ────────────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const parsed = loanUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const { data: existing } = await supabase
    .from('loans').select('id').eq('id', req.params.id).eq('user_id', req.user!.userId).single();
  if (!existing) { res.status(404).json({ error: 'Loan not found' }); return; }

  const { data, error } = await supabase
    .from('loans')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  await syncLoanBill(req.user!.userId, data as LoanRow);
  res.json(data);
});

// ── DELETE /api/loans/:id ─────────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  // Remove the mirrored repayment bill first, then the loan itself.
  await supabase.from('bills').delete()
    .eq('user_id', req.user!.userId).eq('loan_id', req.params.id);
  const { error } = await supabase.from('loans').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
