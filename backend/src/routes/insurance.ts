/**
 * Phase 8.2 — insurance policies.
 *
 * Home, contents, landlord, car, health, life, income protection and the rest:
 * who insures what, for how much, until when. Rows only — no money is computed
 * here (the pure engine in frontend/src/utils/insurance.ts derives annual cost,
 * renewal proximity, expiry and premium movement from these columns).
 *
 * Who sees what is decided entirely by services/insurancePolicies.ts (pure,
 * tested), which shares its rule with the document vault: A POLICY FOLLOWS THE
 * THING IT COVERS. Editing, re-pricing and deleting are owner-only, always —
 * a policy shared into view is still one person's contract with their insurer.
 *
 * The response carries `household_ids` taken from the LINKED RECORD, so the
 * client's existing scope machinery puts a policy in exactly the household views
 * its property (or account, or loan) is already in, with no special case.
 */
import { Router, Response } from 'express';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import { beginIdempotentCreate, recoverIdempotentRace } from '../utils/idempotentCreate';
import { loadScope, HouseholdScope } from '../services/householdScope';
import { householdsOfLinks } from '../services/linkedVisibility';
import {
  TABLE_OF_LINK, pickPolicyFields, pickHistoryFields, policyVisibilityFilter,
  canSeePolicy, linkTargetRefusal, documentRefusal,
  PolicyFields, LinkedType,
} from '../services/insurancePolicies';

const router = Router();
router.use(authenticate);

/** True when Postgres is telling us the migration hasn't run yet. */
const isMissingTable = (err: { code?: string; message?: string } | null): boolean =>
  !!err && (err.code === '42P01' || err.code === 'PGRST205'
    || /relation .* does not exist|could not find the table/i.test(err.message ?? ''));

const MIGRATION_HINT =
  'Insurance is not set up yet — run database/2026-insurance.sql in Supabase.';

interface PolicyRow {
  id: string;
  user_id: string;
  linked_type?: string | null;
  linked_id?: string | null;
}

/**
 * Attach each policy's `household_ids`.
 *
 * They are the households of the thing the policy COVERS, never of the policy
 * itself — that is the whole visibility model in one line, and it is why
 * un-sharing a property removes its insurance from the household view without a
 * single write against this table. Fails soft: no ids reads as "personal".
 */
async function withHouseholds<T extends PolicyRow>(rows: T[]): Promise<(T & { household_ids: string[] })[]> {
  const byRow = await householdsOfLinks(rows);
  return rows.map(r => ({ ...r, household_ids: byRow.get(r.id) ?? [] }));
}

/**
 * Validate a requested link before it is written: the target must exist and be
 * visible to the caller. One row read for record links; none for households
 * (answered from the scope already in hand).
 */
async function refuseLink(
  fields: PolicyFields, scope: HouseholdScope,
): Promise<{ status: number; error: string } | null> {
  if (!fields.linked_type || !fields.linked_id) return null;
  const type = fields.linked_type as LinkedType;

  let targetOwnerId: string | null = null;
  const table = TABLE_OF_LINK[type];
  if (table) {
    const { data } = await supabase
      .from(table).select('user_id').eq('id', fields.linked_id).maybeSingle();
    targetOwnerId = (data as { user_id?: string } | null)?.user_id ?? null;
  }
  return linkTargetRefusal(type, fields.linked_id, targetOwnerId, scope);
}

/** The attached policy document must be one the caller OWNS — see documentRefusal. */
async function refuseDocument(
  fields: PolicyFields, scope: HouseholdScope,
): Promise<{ status: number; error: string } | null> {
  if (!fields.document_id) return null;
  const { data, error } = await supabase
    .from('documents').select('user_id').eq('id', fields.document_id).maybeSingle();
  // Before the vault migration (or with the vault unreachable) an attachment is
  // simply refused rather than silently written as a dangling id.
  if (error && !isMissingTable(error)) return { status: 500, error: error.message };
  return documentRefusal((data as { user_id?: string } | null)?.user_id ?? null, scope);
}

/** Owner-only gate for one policy: 403 when it is visible but not theirs, 404
 *  when it is not theirs to know about at all. */
async function loadOwned(
  id: string, scope: HouseholdScope,
): Promise<{ row: PolicyRow } | { status: number; error: string }> {
  const { data, error } = await supabase
    .from('insurance_policies').select('id, user_id, linked_type, linked_id, premium_amount, premium_frequency')
    .eq('id', id).maybeSingle();
  if (error && isMissingTable(error)) return { status: 503, error: MIGRATION_HINT };
  if (error || !data) return { status: 404, error: 'Not found' };

  const row = data as PolicyRow;
  if (row.user_id === scope.userId) return { row };
  return canSeePolicy(row, scope)
    ? { status: 403, error: 'Only the person this belongs to can change it.' }
    : { status: 404, error: 'Not found' };
}

// ── GET /api/insurance ───────────────────────────────────────────────────────
// Every policy the caller may see, plus the premium history of their OWN
// policies. History is deliberately owner-scoped: what a shared house is insured
// for is household business, what its owner has paid over the years is theirs.
router.get('/', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const filter = policyVisibilityFilter(scope);
  let query = supabase.from('insurance_policies').select('*');
  query = filter ? query.or(filter) : query.eq('user_id', scope.userId);
  const { data, error } = await query.order('renewal_date', { ascending: true });

  if (error) {
    // Fail soft before the migration: no policies, not a broken app.
    if (isMissingTable(error)) {
      console.warn('[insurance] table missing — run 2026-insurance.sql');
      res.json({ policies: [], history: [] });
      return;
    }
    res.status(500).json({ error: error.message });
    return;
  }

  const policies = await withHouseholds((data ?? []) as PolicyRow[]);

  const history = await supabase
    .from('insurance_premium_history').select('*')
    .eq('user_id', scope.userId)
    .order('effective_date', { ascending: true });
  if (history.error && !isMissingTable(history.error)) {
    console.warn('[insurance] premium history unavailable:', history.error.message);
  }

  res.json({ policies, history: history.data ?? [] });
});

// ── POST /api/insurance ──────────────────────────────────────────────────────
router.post('/', async (req: AuthRequest, res: Response) => {
  const { fields, refusal } = pickPolicyFields(req.body ?? {});
  if (refusal) { res.status(400).json({ error: refusal.error }); return; }
  if (!fields.name) { res.status(400).json({ error: 'A policy needs a name.' }); return; }

  const scope = await loadScope(req.user!.userId);
  const linkRefusal = await refuseLink(fields, scope);
  if (linkRefusal) { res.status(linkRefusal.status).json({ error: linkRefusal.error }); return; }
  const docRefusal = await refuseDocument(fields, scope);
  if (docRefusal) { res.status(docRefusal.status).json({ error: docRefusal.error }); return; }

  // Born personal and born ACTIVE. Sharing is not an act against this row at
  // all — it happens when the thing the policy covers is shared.
  const row: Record<string, unknown> = {
    ...fields,
    user_id: scope.userId,
    active: fields.active !== false,
  };
  const replay = await beginIdempotentCreate('insurance_policies', req.user!.userId, req.body, row);
  if (replay) { res.status(200).json((await withHouseholds([replay as unknown as PolicyRow]))[0]); return; }

  const { data, error } = await supabase
    .from('insurance_policies').insert(row).select().single();
  if (error) {
    const raced = await recoverIdempotentRace('insurance_policies', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json((await withHouseholds([raced as unknown as PolicyRow]))[0]); return; }
    res.status(isMissingTable(error) ? 503 : 500)
      .json({ error: isMissingTable(error) ? MIGRATION_HINT : error.message });
    return;
  }
  res.status(201).json((await withHouseholds([data as PolicyRow]))[0]);
});

// ── Premium history ──────────────────────────────────────────────────────────
//
// Declared BEFORE the /:id routes: Express matches in order, so a `/history`
// path registered afterwards would be swallowed by `/:id`.
//
// What the policy HAS cost, from when. Written by the client in the same act
// that changes the premium (exactly as a loan event accompanies a balance
// change), so the record of a price rise and the new price can never disagree.
// There is no update: correcting an observation means deleting it and recording
// what actually happened.
router.post('/history', async (req: AuthRequest, res: Response) => {
  const { fields, refusal } = pickHistoryFields(req.body ?? {});
  if (refusal || !fields) { res.status(400).json({ error: refusal?.error ?? 'Invalid record.' }); return; }

  // The policy must be this user's own. Without the check a crafted policy_id
  // would attach a price history to a stranger's cover.
  const { data: policy, error: lookupError } = await supabase
    .from('insurance_policies').select('id')
    .eq('id', fields.policy_id).eq('user_id', req.user!.userId).maybeSingle();
  if (lookupError && isMissingTable(lookupError)) { res.status(503).json({ error: MIGRATION_HINT }); return; }
  if (!policy) { res.status(404).json({ error: 'Policy not found' }); return; }

  const historyRow: Record<string, unknown> = { ...fields, user_id: req.user!.userId };
  const replay = await beginIdempotentCreate('insurance_premium_history', req.user!.userId, req.body, historyRow);
  if (replay) { res.status(200).json(replay); return; }

  const { data, error } = await supabase
    .from('insurance_premium_history')
    .insert(historyRow)
    .select().single();
  if (error) {
    const raced = await recoverIdempotentRace('insurance_premium_history', req.user!.userId, req.body, error);
    if (raced) { res.status(200).json(raced); return; }
    res.status(isMissingTable(error) ? 503 : 500)
      .json({ error: isMissingTable(error) ? MIGRATION_HINT : error.message });
    return;
  }
  res.status(201).json(data);
});

router.delete('/history/:id', async (req: AuthRequest, res: Response) => {
  const { error } = await supabase
    .from('insurance_premium_history').delete()
    .eq('id', req.params.id).eq('user_id', req.user!.userId);
  if (error && !isMissingTable(error)) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── PUT /api/insurance/:id ───────────────────────────────────────────────────
// Owner-only. A household member may read the cover on the joint house and may
// not re-price it — unlike a shared ACCOUNT, whose balance a member may correct,
// because a premium is not arithmetic about shared money, it is a contract.
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const owned = await loadOwned(req.params.id, scope);
  if ('status' in owned) { res.status(owned.status).json({ error: owned.error }); return; }

  const { fields, refusal } = pickPolicyFields(req.body ?? {});
  if (refusal) { res.status(400).json({ error: refusal.error }); return; }
  const linkRefusal = await refuseLink(fields, scope);
  if (linkRefusal) { res.status(linkRefusal.status).json({ error: linkRefusal.error }); return; }
  const docRefusal = await refuseDocument(fields, scope);
  if (docRefusal) { res.status(docRefusal.status).json({ error: docRefusal.error }); return; }

  const { data, error } = await supabase
    .from('insurance_policies')
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json((await withHouseholds([data as PolicyRow]))[0]);
});

// ── DELETE /api/insurance/:id ────────────────────────────────────────────────
// Owner-only. The premium history goes with it (ON DELETE CASCADE) — it is the
// price history OF this policy and means nothing without it. To keep the record
// of cover that has ended, set `active: false` instead of deleting.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const scope = await loadScope(req.user!.userId);
  const owned = await loadOwned(req.params.id, scope);
  if ('status' in owned) { res.status(owned.status).json({ error: owned.error }); return; }

  const { error } = await supabase
    .from('insurance_policies').delete().eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

export default router;
