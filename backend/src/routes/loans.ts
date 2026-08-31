import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { beginIdempotentCreate, recoverIdempotentRace } from '../utils/idempotentCreate';
import { z } from 'zod';
import { money } from '../utils/moneySchema';
import { recordNetWorthSnapshot } from '../services/netWorthSnapshot';
import { healOverdue } from '../utils/recurrence';
// ── Phase 7.1: households ────────────────────────────────────────────────────
// Reads answer with the rows the user OWNS plus the rows SHARED with a household
// they're in — one row each, never a copy. Writes are checked against the row
// itself: your own always, somebody else's only when it's shared and your role
// can edit shared money. Deleting stays owner-only (see refuseDelete).
import {
  loadScope, scopedQuery, refuseWrite, refuseDelete, revokeGrantsFor,
  applyHouseholdShare, attachHouseholds, attachHouseholdsToOne,
} from '../services/householdScope';
import { divertMemberEdit, divertMemberDelete } from '../services/householdChangeRequests';

const router = Router();
router.use(authenticate);

// Record a fresh net-worth snapshot after a structural loan change so the
// adjusted ("exclude structural") series treats the loan as tracked-from-now
// and the % change line doesn't spike. Fire-and-forget like accounts/investments.
function snapshotSoon(userId: string): void {
  recordNetWorthSnapshot(userId).catch(err => console.error('[nw] post-loan-change snapshot failed:', err));
}

const LOAN_TYPES = ['mortgage', 'personal', 'car', 'hecs'] as const;
const FREQUENCIES = ['weekly', 'fortnightly', 'monthly'] as const;
const RATE_TYPES = ['variable', 'fixed'] as const;
const EVENT_KINDS = ['repayment', 'extra_repayment', 'redraw', 'rate_change'] as const;

const loanSchema = z.object({
  name: z.string().min(1),
  loan_type: z.enum(LOAN_TYPES),
  lender: z.string().nullable().optional(),
  original_amount: money.nonnegative().default(0),
  current_balance: money.nonnegative().default(0),
  interest_rate: money.nullable().optional(),
  minimum_repayment: money.nullable().optional(),
  repayment_frequency: z.enum(FREQUENCIES).default('monthly'),
  next_due_date: z.string().nullable().optional(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  include_in_net_worth: z.boolean().optional(),
  add_to_bills: z.boolean().optional(),

  // ── Phase 4.2 — the mortgage/debt engine's inputs ─────────────────────────
  // Extensions of the SAME loan row a property links to: there is no separate
  // mortgage record, so a projection and a balance can never disagree.
  rate_type: z.enum(RATE_TYPES).nullable().optional(),
  fixed_until: z.string().nullable().optional(),
  revert_rate: money.nullable().optional(),
  interest_only_until: z.string().nullable().optional(),
  term_months: z.number().int().nonnegative().nullable().optional(),
  // Interest-reducing cash, never subtracted from the debt — it is already an
  // asset in the user's bank account.
  offset_balance: money.nonnegative().nullable().optional(),
  offset_account_id: z.string().uuid().nullable().optional(),
  extra_repayment: money.nonnegative().nullable().optional(),
  // Re-borrowing capacity, not cash: never counted toward net worth.
  redraw_available: money.nonnegative().nullable().optional(),
  // Set when the loan was imported from Basiq open banking; lets a re-sync update
  // the same row instead of inserting a duplicate. Null/absent for manual loans.
  basiq_account_id: z.string().nullable().optional(),
});

// Partial schema for updates — every field optional.
const loanUpdateSchema = loanSchema.partial();

/**
 * The columns 2026-loan-engine.sql adds, and a guard for the window in which the
 * frontend is deployed but the migration hasn't been applied.
 *
 * Postgres rejects a write naming a column it doesn't have, which would fail the
 * WHOLE loan write — a user editing a lender's name would be told their loan
 * couldn't be saved because of a projection field they never touched. So an
 * unknown-column failure is retried once with these keys removed: the loan still
 * saves, and the engine's inputs start persisting the moment the migration runs.
 */
const ENGINE_COLUMNS = [
  'rate_type', 'fixed_until', 'revert_rate', 'interest_only_until', 'term_months',
  'offset_balance', 'offset_account_id', 'extra_repayment', 'redraw_available',
] as const;

function withoutEngineColumns(fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  for (const key of ENGINE_COLUMNS) delete out[key];
  return out;
}

/** True when Postgres/PostgREST is complaining about a column that isn't there. */
function isUnknownColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  // 42703 = undefined_column (Postgres); PGRST204 = column not in schema cache.
  if (err.code === '42703' || err.code === 'PGRST204') return true;
  return /column .* does not exist|could not find the .* column/i.test(err.message ?? '');
}

interface LoanRow {
  id: string;
  name: string;
  minimum_repayment: number | null;
  next_due_date: string | null;
  repayment_frequency: string | null;
  add_to_bills?: boolean | null;
}

const repaymentBillName = (loanName: string): string => `${loanName} repayment`;

/**
 * Mirror a loan's repayment schedule into the `bills` table so it shows up in
 * Bills & Reminders and the morning briefing. The bill is linked back to the loan
 * by bills.loan_id, so renames/edits update the same row instead of duplicating.
 *
 * - Mirroring only happens when the loan has add_to_bills enabled (the user's
 *   opt-in) AND it has BOTH a minimum_repayment and a next_due_date (otherwise
 *   there's no payable schedule to mirror).
 * - If mirroring is turned off or the schedule is removed, any existing mirrored
 *   bill is deleted (which also removes it from the Telegram briefing).
 *
 * Wrapped so a failure here (e.g. the bills.loan_id migration not yet run) never
 * blocks the loan write itself.
 */
async function syncLoanBill(userId: string, loan: LoanRow): Promise<void> {
  try {
    // Only the LIVE (unpaid) mirror is a candidate to update. Paid occurrences are
    // history sitting in "Recently completed" — resurrecting one (the old
    // maybeSingle could match a paid row) would un-pay a repayment the user already
    // ticked. Ordering by due_date lets us keep the earliest and treat the rest as
    // stray duplicates (which used to accumulate because tick-off copied loan_id).
    const { data: liveRows } = await supabase
      .from('bills')
      .select('id')
      .eq('user_id', userId)
      .eq('loan_id', loan.id)
      .eq('is_paid', false)
      .order('due_date', { ascending: true });
    const existing = liveRows?.[0] ?? null;
    const duplicates = (liveRows ?? []).slice(1);
    for (const dup of duplicates) {
      await supabase.from('bills').delete().eq('id', dup.id);
    }

    // Default-on for legacy rows saved before the flag existed (null → true).
    const wantsBill = loan.add_to_bills !== false;
    const hasSchedule =
      loan.minimum_repayment != null && loan.minimum_repayment > 0 && !!loan.next_due_date;

    if (!wantsBill || !hasSchedule) {
      if (existing) await supabase.from('bills').delete().eq('id', existing.id);
      return;
    }

    // Self-heal: if the loan's next_due_date has already drifted into the past,
    // roll it forward to the first non-overdue occurrence and persist it back to
    // the loan. Without this, mirroring would keep re-projecting an overdue date
    // and the repayment bill would never stop being overdue.
    const healedDue = healOverdue(loan.next_due_date!, loan.repayment_frequency) ?? loan.next_due_date!;
    if (healedDue !== loan.next_due_date) {
      await supabase.from('loans').update({ next_due_date: healedDue }).eq('id', loan.id);
    }

    const fields = {
      name: repaymentBillName(loan.name),
      amount: loan.minimum_repayment,
      due_date: healedDue,
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
  const scope = await loadScope(req.user!.userId);
  const { data, error } = await scopedQuery(
    supabase.from('loans').select('*'), scope, 'loans',
  ).order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(await attachHouseholds('loan', data ?? [], scope));
});

// ── POST /api/loans ───────────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = loanSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  // Born personal — sharing is a separate act against the join (see the PUT).
  const fields: Record<string, unknown> = {
    ...parsed.data,
    user_id: req.user!.userId,
  };
  const replay = await beginIdempotentCreate('loans', req.user!.userId, req.body, fields);
  if (replay) { res.status(200).json(replay); return; }

  let { data, error } = await supabase.from('loans').insert(fields).select().single();
  if (isUnknownColumn(error)) {
    ({ data, error } = await supabase
      .from('loans').insert(withoutEngineColumns(fields)).select().single());
  }

  if (error) {
    const raced = await recoverIdempotentRace('loans', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json(raced); return; }
    res.status(500).json({ error: error.message }); return;
  }
  await syncLoanBill(req.user!.userId, data as LoanRow);
  snapshotSoon(req.user!.userId);
  res.status(201).json(data);
});

// ── Loan events (Phase 4.2) ──────────────────────────────────────────────────
//
// The audit trail of what MOVED a loan: repayments (including partial ones),
// extra repayments, redraws and rate changes. The loan's own current_balance
// stays the authoritative debt — Basiq syncs it, banks report it — so these rows
// record what happened rather than being a second ledger the balance is derived
// from. The client applies the balance change and records the event together.
//
// Declared BEFORE the /:id routes below: Express matches in order, so a
// `/events` path registered afterwards would be swallowed by `/:id`.

const loanEventSchema = z.object({
  loan_id: z.string().uuid(),
  kind: z.enum(EVENT_KINDS),
  amount: money.nonnegative().default(0),
  rate: money.nullable().optional(),
  date: z.string().min(1),
  note: z.string().nullable().optional(),
});

router.get('/events', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('loan_events')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('date', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

router.post('/events', async (req: AuthRequest, res: Response) => {
  const parsed = loanEventSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  // The loan must be this user's. Without the check a crafted loan_id would
  // attach history to a stranger's mortgage.
  const { data: loan } = await supabase
    .from('loans').select('id').eq('id', parsed.data.loan_id).eq('user_id', req.user!.userId).maybeSingle();
  if (!loan) { res.status(404).json({ error: 'Loan not found' }); return; }

  const eventFields: Record<string, unknown> = { ...parsed.data, user_id: req.user!.userId };
  const replay = await beginIdempotentCreate('loan_events', req.user!.userId, req.body, eventFields);
  if (replay) { res.status(200).json(replay); return; }

  const { data, error } = await supabase
    .from('loan_events')
    .insert(eventFields)
    .select()
    .single();

  if (error) {
    const raced = await recoverIdempotentRace('loan_events', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json(raced); return; }
    res.status(500).json({ error: error.message }); return;
  }
  res.status(201).json(data);
});

// Deleting an event removes the RECORD of a movement, not its effect: the
// balance it changed is the loan's own and stays where the user left it.
router.delete('/events/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('loan_events').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── PUT /api/loans/:id ────────────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const parsed = loanUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('loans', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  const shareRefusal = await applyHouseholdShare('loans', req.params.id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const patch = {
    ...parsed.data,
    updated_at: new Date().toISOString(),
  };

  // A household member's edit never lands on the owner's row: it becomes a
  // change request whose patch the household view shows, and the owner is asked.
  const diverted = await divertMemberEdit('loans', req.params.id, scope, patch);
  if (diverted) {
    res.json(await attachHouseholdsToOne('loan', diverted as unknown as LoanRow, scope));
    return;
  }

  const applyPatch = (fields: Record<string, unknown>) => supabase
    .from('loans')
    .update(fields)
    .eq('id', req.params.id)
    .select()
    .single();

  let { data, error } = await applyPatch(patch);
  if (isUnknownColumn(error)) ({ data, error } = await applyPatch(withoutEngineColumns(patch)));

  if (error) { res.status(500).json({ error: error.message }); return; }
  await syncLoanBill(req.user!.userId, data as LoanRow);
  snapshotSoon(req.user!.userId);
  res.json(await attachHouseholdsToOne('loan', data as LoanRow, scope));
});

// ── DELETE /api/loans/:id ─────────────────────────────────────────────────────
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  // Owner-only: a shared mortgage is still one person's debt, and deleting it
  // would remove it from THEIR net worth, not just from the household view.
  const scope = await loadScope(req.user!.userId);
  // A household member's delete takes the loan out of the HOUSEHOLD only, and
  // asks its owner whether to delete it from their account as well.
  if (await divertMemberDelete('loans', req.params.id, scope)) {
    res.json({ success: true, diverted: true });
    return;
  }
  const refusal = await refuseDelete('loans', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  // Remove the mirrored repayment bill first, then the loan itself.
  await supabase.from('bills').delete()
    .eq('user_id', req.user!.userId).eq('loan_id', req.params.id);
  await revokeGrantsFor('loans', req.params.id);
  const { error } = await supabase.from('loans').delete().eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.json({ success: true });
});

export default router;
