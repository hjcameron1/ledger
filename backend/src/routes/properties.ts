import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { z } from 'zod';
import { recordNetWorthSnapshot } from '../services/netWorthSnapshot';

/**
 * Phase 4.1 — properties.
 *
 * A property is an asset the user owns some share of. Its mortgage is NOT stored
 * here: it stays a row in `loans` and this table only points at it via loan_id.
 * So net worth gains `current_value × ownership_percent/100` from here and loses
 * the loan balance once via the loans table — the debt is never counted twice,
 * and equity stays a derived number rather than a second stored liability.
 */

const router = Router();
router.use(authenticate);

// Structural changes move net worth, so record a fresh snapshot afterwards — the
// adjusted series then treats the property as tracked-from-now and the % line
// doesn't spike. Fire-and-forget, exactly like loans/accounts/investments.
function snapshotSoon(userId: string): void {
  recordNetWorthSnapshot(userId).catch(err => console.error('[nw] post-property-change snapshot failed:', err));
}

const PROPERTY_TYPES = ['home', 'investment', 'holiday', 'land', 'commercial', 'other'] as const;

const propertySchema = z.object({
  name: z.string().min(1),
  address: z.string().nullable().optional(),
  property_type: z.enum(PROPERTY_TYPES).default('home'),
  purchase_price: z.number().nonnegative().default(0),
  purchase_date: z.string().nullable().optional(),
  current_value: z.number().nonnegative().default(0),
  ownership_percent: z.number().min(0).max(100).default(100),
  loan_id: z.string().uuid().nullable().optional(),
  include_in_net_worth: z.boolean().optional(),
  notes: z.string().nullable().optional(),
});

const propertyUpdateSchema = propertySchema.partial();

/**
 * Validate a mortgage link before it is written.
 *
 * Two things can go wrong and both are refused rather than silently accepted:
 *   • the loan belongs to someone else (or doesn't exist) — a link across users
 *     would leak a balance into this user's equity figure;
 *   • the loan already backs a DIFFERENT property — the same debt would then be
 *     netted twice, which is the double-count this phase exists to prevent.
 * Returns an error message, or null when the link is fine.
 */
async function loanLinkError(userId: string, loanId: string | null | undefined, propertyId?: string): Promise<string | null> {
  if (!loanId) return null;

  const { data: loan } = await supabase
    .from('loans').select('id').eq('id', loanId).eq('user_id', userId).maybeSingle();
  if (!loan) return 'Linked loan not found';

  const { data: taken } = await supabase
    .from('properties').select('id, name').eq('user_id', userId).eq('loan_id', loanId);
  const other = (taken ?? []).find(p => p.id !== propertyId);
  if (other) return `That loan is already linked to "${other.name}"`;

  return null;
}

// ── GET /api/properties ───────────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase
    .from('properties')
    .select('*')
    .eq('user_id', req.user!.userId)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

// ── POST /api/properties ──────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = propertySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const linkErr = await loanLinkError(req.user!.userId, parsed.data.loan_id);
  if (linkErr) { res.status(400).json({ error: linkErr }); return; }

  const { data, error } = await supabase
    .from('properties')
    .insert({ ...parsed.data, user_id: req.user!.userId })
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.status(201).json(data);
});

// ── PUT /api/properties/:id ───────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const parsed = propertyUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const { data: existing } = await supabase
    .from('properties').select('id').eq('id', req.params.id).eq('user_id', req.user!.userId).maybeSingle();
  if (!existing) { res.status(404).json({ error: 'Property not found' }); return; }

  if ('loan_id' in parsed.data) {
    const linkErr = await loanLinkError(req.user!.userId, parsed.data.loan_id, req.params.id);
    if (linkErr) { res.status(400).json({ error: linkErr }); return; }
  }

  const { data, error } = await supabase
    .from('properties')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('user_id', req.user!.userId)
    .select()
    .single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.json(data);
});

// ── DELETE /api/properties/:id ────────────────────────────────────────────────
// Deletes the ASSET only. The mortgage is a loan the user still owes, so it is
// deliberately left alone — removing a property must never quietly erase debt.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase.from('properties').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.json({ success: true });
});

export default router;
