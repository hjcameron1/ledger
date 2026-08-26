import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { z } from 'zod';
import { money } from '../utils/moneySchema';
import { recordNetWorthSnapshot } from '../services/netWorthSnapshot';
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
const HELD_BY = ['personal', 'joint', 'smsf'] as const;
const RENT_FREQUENCIES = ['weekly', 'fortnightly', 'monthly', 'quarterly'] as const;
const EXPENSE_KINDS = ['strata', 'council', 'water', 'insurance', 'maintenance', 'utilities', 'other'] as const;
// Rates and insurance are yearly, and a plumber has no cycle at all — which is
// what 'irregular' is for, rather than pretending a maintenance bill is monthly.
const EXPENSE_FREQUENCIES = [...RENT_FREQUENCIES, 'annually', 'irregular'] as const;

/**
 * One expense rule. It holds no money: it names the transactions that are
 * already this property's, so the next one is recognised as it lands.
 *
 * Only `id`, `name` and `kind` are required — a user who knows the strata
 * manager's name and nothing else must be able to save that and stop.
 */
const expenseRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  kind: z.enum(EXPENSE_KINDS).default('other'),
  expected_amount: money.nonnegative().nullable().optional(),
  frequency: z.enum(EXPENSE_FREQUENCIES).nullable().optional(),
  account_id: z.string().nullable().optional(),
  whole_account: z.boolean().optional(),
  match_terms: z.array(z.string()).nullable().optional(),
});

const propertySchema = z.object({
  // The nickname is optional — the client labels a property by its address when
  // there isn't one. The ADDRESS is what a property can't do without.
  name: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  address_unit: z.string().nullable().optional(),
  address_street: z.string().min(1),
  address_suburb: z.string().min(1),
  address_state: z.string().min(1),
  address_postcode: z.string().min(1),
  address_country: z.string().min(1),
  property_type: z.enum(PROPERTY_TYPES).default('home'),
  held_by: z.enum(HELD_BY).default('personal'),
  smsf_fund_id: z.string().uuid().nullable().optional(),
  super_fund_id: z.string().uuid().nullable().optional(),
  counted_in_fund_balance: z.boolean().optional(),
  purchase_price: money.nonnegative().default(0),
  purchase_date: z.string().nullable().optional(),
  current_value: money.nonnegative().default(0),
  ownership_percent: z.number().min(0).max(100).default(100),
  loan_id: z.string().uuid().nullable().optional(),
  include_in_net_worth: z.boolean().optional(),
  notes: z.string().nullable().optional(),
  // Phase 4.3 — which existing transactions belong to this property. Rent and
  // expenses are never stored here; these only say how to recognise them.
  match_terms: z.array(z.string()).nullable().optional(),
  match_account_ids: z.array(z.string()).nullable().optional(),
  // …and, for a let property, which of them are the RENT. An owner-occupied
  // home sends these as empty/null: it has no income to recognise.
  rent_match_terms: z.array(z.string()).nullable().optional(),
  rent_account_id: z.string().nullable().optional(),
  expected_rent_amount: money.nonnegative().nullable().optional(),
  expected_rent_frequency: z.enum(RENT_FREQUENCIES).nullable().optional(),
  // One rule per cost the property has: the strata levy, the rate notice, the
  // water bill. Stored as JSON because a rule belongs to exactly one property
  // and is never queried on its own — a table would buy joins nobody makes.
  property_expenses: z.array(expenseRuleSchema).nullable().optional(),
  // Payments the user has taken back off this property. Ids only: the
  // transactions themselves are untouched and still count everywhere else.
  excluded_transaction_ids: z.array(z.string()).nullable().optional(),
});

/** Columns added by Phase 4.3, dropped on retry when the migration hasn't run. */
const PERFORMANCE_COLUMNS = [
  'match_terms', 'match_account_ids',
  'rent_match_terms', 'rent_account_id', 'expected_rent_amount', 'expected_rent_frequency',
  'property_expenses', 'excluded_transaction_ids',
] as const;

function withoutPerformanceColumns(fields: Record<string, unknown>): Record<string, unknown> {
  const out = { ...fields };
  for (const key of PERFORMANCE_COLUMNS) delete out[key];
  return out;
}

/** True when Postgres/PostgREST is complaining about a column that isn't there. */
function isUnknownColumn(err: { code?: string; message?: string } | null): boolean {
  if (!err) return false;
  // 42703 = undefined_column (Postgres); PGRST204 = column not in schema cache.
  if (err.code === '42703' || err.code === 'PGRST204') return true;
  return /column .* does not exist|could not find the .* column/i.test(err.message ?? '');
}

// A PATCH is judged more leniently than a create: the address parts stay
// required, but a blank/null one arriving here is DROPPED rather than refused
// (see stripBlankAddress). Clients send the whole record so a queued write can
// be replayed safely, and a property stored before the address was structured
// has nothing to put in those columns — refusing the payload outright blocked
// every unrelated edit on such a row, a net-worth toggle included.
const ADDRESS_PARTS = [
  'address_street', 'address_suburb', 'address_state', 'address_postcode', 'address_country',
] as const;

const propertyUpdateSchema = propertySchema.partial().extend(
  Object.fromEntries(ADDRESS_PARTS.map(k => [k, z.string().nullable().optional()])) as {
    [K in (typeof ADDRESS_PARTS)[number]]: z.ZodOptional<z.ZodNullable<z.ZodString>>;
  },
);

/**
 * Remove blank required-address keys from a patch.
 *
 * These columns can't legitimately be cleared — an address is required — so a
 * blank value means "I have nothing for this", never "erase what's there".
 * Dropping the key preserves the stored value; a real change still carries a
 * real string.
 */
function stripBlankAddress(patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...patch };
  for (const key of ADDRESS_PARTS) {
    if (key in out && typeof out[key] !== 'string') delete out[key];
    else if (typeof out[key] === 'string' && !(out[key] as string).trim()) delete out[key];
  }
  return out;
}

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
  if (other) return `That loan is already linked to "${other.name || 'another property'}"`;

  return null;
}

/**
 * Validate the held-by / fund link before it is written.
 *
 * A fund link is what makes the `counted_in_fund_balance` rule meaningful, so it
 * has to be unambiguous:
 *   • two funds at once — which one is carrying the value? refused;
 *   • a fund on a personal/joint property — nothing to be counted inside, refused;
 *   • SMSF-held with no fund — the rule has no fund to point at, refused;
 *   • a fund belonging to someone else — that would net a stranger's balance
 *     against this user's property.
 * `fields` is the payload actually being written, so a PUT that doesn't mention
 * these columns is checked against what's already stored.
 */
async function fundLinkError(
  userId: string,
  fields: { held_by?: string | null; smsf_fund_id?: string | null; super_fund_id?: string | null },
): Promise<string | null> {
  const held = fields.held_by ?? 'personal';
  const smsfId = fields.smsf_fund_id ?? null;
  const superId = fields.super_fund_id ?? null;

  if (smsfId && superId) return 'A property can be held in only one fund';
  if (held === 'smsf' && !smsfId && !superId) return 'Choose the SMSF or super fund that holds this property';
  if (held !== 'smsf' && (smsfId || superId)) return `A ${held} property can't be held in a fund`;

  if (smsfId) {
    const { data } = await supabase
      .from('smsf_funds').select('id').eq('id', smsfId).eq('user_id', userId).maybeSingle();
    if (!data) return 'SMSF not found';
  }
  if (superId) {
    const { data } = await supabase
      .from('super_funds').select('id').eq('id', superId).eq('user_id', userId).maybeSingle();
    if (!data) return 'Super fund not found';
  }
  return null;
}

// ── GET /api/properties ───────────────────────────────────────────────────────
router.get('/', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const { data, error } = await scopedQuery(
    supabase.from('properties').select('*'), scope, 'properties',
  ).order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(await attachHouseholds('property', data ?? []));
});

// ── POST /api/properties ──────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = propertySchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const linkErr = await loanLinkError(req.user!.userId, parsed.data.loan_id);
  if (linkErr) { res.status(400).json({ error: linkErr }); return; }

  const fundErr = await fundLinkError(req.user!.userId, parsed.data);
  if (fundErr) { res.status(400).json({ error: fundErr }); return; }

  // Retried without the Phase 4.3 columns when they aren't there yet, so adding a
  // property still works between deploying this and running the migration.
  // Born personal — sharing is a separate act against the join (see the PUT).
  const fields = {
    ...parsed.data,
    user_id: req.user!.userId,
  };
  let { data, error } = await supabase.from('properties').insert(fields).select().single();
  if (isUnknownColumn(error)) {
    ({ data, error } = await supabase
      .from('properties').insert(withoutPerformanceColumns(fields)).select().single());
  }

  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.status(201).json(data);
});

// ── PUT /api/properties/:id ───────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const parsed = propertyUpdateSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const scope = await loadScope(req.user!.userId);
  const refusal = await refuseWrite('properties', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  const shareRefusal = await applyHouseholdShare('properties', req.params.id, scope, req.body);
  if (shareRefusal) { res.status(shareRefusal.status).json({ error: shareRefusal.error }); return; }

  const { data: existing } = await supabase
    .from('properties')
    .select('id, held_by, smsf_fund_id, super_fund_id')
    .eq('id', req.params.id).maybeSingle();
  if (!existing) { res.status(404).json({ error: 'Property not found' }); return; }

  if ('loan_id' in parsed.data) {
    const linkErr = await loanLinkError(req.user!.userId, parsed.data.loan_id, req.params.id);
    if (linkErr) { res.status(400).json({ error: linkErr }); return; }
  }

  // A partial update must be judged against the row it lands on, not against the
  // patch alone: clearing `smsf_fund_id` on a row that stays held_by='smsf' would
  // otherwise slip through and leave the fund rule pointing at nothing.
  if ('held_by' in parsed.data || 'smsf_fund_id' in parsed.data || 'super_fund_id' in parsed.data) {
    const merged = {
      held_by: 'held_by' in parsed.data ? parsed.data.held_by : (existing.held_by as string | null),
      smsf_fund_id: 'smsf_fund_id' in parsed.data ? parsed.data.smsf_fund_id : (existing.smsf_fund_id as string | null),
      super_fund_id: 'super_fund_id' in parsed.data ? parsed.data.super_fund_id : (existing.super_fund_id as string | null),
    };
    const fundErr = await fundLinkError(req.user!.userId, merged);
    if (fundErr) { res.status(400).json({ error: fundErr }); return; }
  }

  const patch = {
    ...stripBlankAddress(parsed.data),
    updated_at: new Date().toISOString(),
  };

  // A household member's edit never lands on the owner's row: it becomes a
  // change request whose patch the household view shows, and the owner is asked.
  const diverted = await divertMemberEdit('properties', req.params.id, scope, patch);
  if (diverted) { res.json(await attachHouseholdsToOne('property', diverted)); return; }

  const applyPatch = (fields: Record<string, unknown>) => supabase
    .from('properties')
    .update(fields)
    .eq('id', req.params.id)
    .select()
    .single();

  let { data, error } = await applyPatch(patch);
  if (isUnknownColumn(error)) ({ data, error } = await applyPatch(withoutPerformanceColumns(patch)));

  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.json(await attachHouseholdsToOne('property', data as { id: string }));
});

// ── DELETE /api/properties/:id ────────────────────────────────────────────────
// Deletes the ASSET only. The mortgage is a loan the user still owes, so it is
// deliberately left alone — removing a property must never quietly erase debt.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  // A household member's delete takes the property out of the HOUSEHOLD only,
  // and asks its owner whether to delete it from their account as well.
  if (await divertMemberDelete('properties', req.params.id, scope)) {
    res.json({ success: true, diverted: true });
    return;
  }
  const refusal = await refuseDelete('properties', req.params.id, scope);
  if (refusal) { res.status(refusal.status).json({ error: refusal.error }); return; }

  await revokeGrantsFor('properties', req.params.id);
  const { error } = await supabase.from('properties').delete().eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  snapshotSoon(req.user!.userId);
  res.json({ success: true });
});

export default router;
