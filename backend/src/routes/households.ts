import { Router, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import {
  loadScope, roleCan, roleIn, unshareRowsOf, sharedRowCounts,
  type HouseholdRole,
} from '../services/householdScope';
import {
  dropProposalsBy, pendingRequestsFor, respondToChangeRequest,
} from '../services/householdChangeRequests';

/**
 * Phase 7.1 — households, members, roles and invitations.
 *
 * A household holds PEOPLE, never money. Every figure it shows comes from rows
 * that already belonged to its members and still do; this router can create a
 * membership and it can stamp or clear a `household_id`, and that is the whole
 * of its power over anybody's finances.
 *
 * Which is why every destructive-sounding endpoint here is not: removing a
 * member, leaving, and deleting the household all resolve to the same safe
 * operation — shared rows revert to personal, owned by exactly who owned them
 * all along. Nothing in this file deletes a transaction, an account or a balance.
 */

const router = Router();
router.use(authenticate);

const ROLES: HouseholdRole[] = ['owner', 'admin', 'member', 'viewer'];
const INVITABLE_ROLES = ['admin', 'member', 'viewer'] as const;
const INVITE_TTL_DAYS = 14;

const normaliseEmail = (email: string) => email.trim().toLowerCase();
const nowIso = () => new Date().toISOString();

/** Random, unguessable, and short enough to be pasted by a human. */
const mintCode = () => crypto.randomBytes(16).toString('base64url');

/** The signed-in user's email, straight from the users table rather than the
 *  token, so a stale token can never satisfy an invitation's address check. */
async function emailOf(userId: string): Promise<string | null> {
  const { data } = await supabase.from('users').select('email').eq('id', userId).maybeSingle();
  return data?.email ? normaliseEmail(data.email as string) : null;
}

/** Members of a household with their user details joined on, for the UI. */
async function membersOf(householdId: string) {
  const { data } = await supabase
    .from('household_members')
    .select('*, users:user_id (email, name)')
    .eq('household_id', householdId)
    .order('joined_at', { ascending: true });

  return (data ?? []).map((m: Record<string, unknown>) => {
    const user = m.users as { email?: string; name?: string } | null;
    const { users, ...rest } = m;
    return { ...rest, email: user?.email ?? null, name: user?.name ?? null };
  });
}

/** Guard: resolve the caller's role and refuse when it isn't enough. */
async function requireRole(
  req: AuthRequest, res: Response, householdId: string, action: Parameters<typeof roleCan>[1],
): Promise<{ role: HouseholdRole } | null> {
  const scope = await loadScope(req.user!.userId);
  const role = roleIn(scope, householdId);
  if (!role) { res.status(404).json({ error: 'Household not found' }); return null; }
  if (!roleCan(role, action)) {
    res.status(403).json({ error: "You don't have permission to do that in this household." });
    return null;
  }
  return { role };
}

// ── GET /api/households ───────────────────────────────────────────────────────
// Everything the client needs to build its context in one round trip: the
// households the user is in, every member of them, and any invitations waiting
// for the user's own address.
router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const scope = await loadScope(userId);
  const ids = [...scope.roles.keys()];

  const rawHouseholds = ids.length
    ? (await supabase.from('households').select('*').in('id', ids)).data ?? []
    : [];

  // The join link is a standing invitation, so only somebody who may invite gets
  // to see it. A viewer holding the code could put people into a household they
  // have no say over — the code is the permission, so it travels with it.
  const households = rawHouseholds.map(h => (
    roleCan(scope.roles.get(h.id as string)!, 'invite_member')
      ? h
      : { ...h, join_code: null }
  ));

  const members = (await Promise.all(ids.map(membersOf))).flat();

  // Invitations are addressed to an email, so a user with no membership at all
  // still sees the one waiting for them — that is how they get in.
  const email = await emailOf(userId);
  const { data: invited } = email
    ? await supabase.from('household_invitations').select('*')
        .eq('email', email).eq('status', 'pending')
    : { data: [] };

  // …plus the ones the user's own households have sent out, which only somebody
  // who can invite has any business seeing.
  const manageable = ids.filter(id => roleCan(scope.roles.get(id)!, 'invite_member'));
  const { data: sent } = manageable.length
    ? await supabase.from('household_invitations').select('*')
        .in('household_id', manageable).eq('status', 'pending')
    : { data: [] };

  const invitations = [...(invited ?? []), ...(sent ?? [])]
    .filter((inv, i, all) => all.findIndex(o => o.id === inv.id) === i);

  res.json({ households, members, invitations });
});

// ── GET /api/households/change-requests ───────────────────────────────────────
// The owner's approval inbox: household members' edits and deletes of THIS
// user's shared rows, waiting for a yes or no. The household view already shows
// the member's version (edits) or no longer shows the row (deletes) — the only
// question left is whether the owner's own record follows.
router.get('/change-requests', async (req: AuthRequest, res: Response) => {
  res.json({ requests: await pendingRequestsFor(req.user!.userId) });
});

// ── POST /api/households/change-requests/:id/respond ──────────────────────────
// The owner's answer. { accept: true } applies an edit to their real row (or
// performs a delete, with the same cascades their own delete button runs);
// { accept: false } keeps their record as it is — an edit then stays visible in
// the household as ITS version, which is the agreed divergence, not a bug.
router.post('/change-requests/:id/respond', async (req: AuthRequest, res: Response) => {
  const accept = (req.body as { accept?: unknown } | null)?.accept === true;
  const result = await respondToChangeRequest(req.params.id, req.user!.userId, accept);
  if (!result.ok) { res.status(result.status).json({ error: result.error }); return; }
  res.json({ success: true, outcome: result.outcome });
});

// ── POST /api/households ──────────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().min(1).max(80),
  currency: z.string().min(1).max(8).optional(),
});

router.post('/', async (req: AuthRequest, res: Response) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }

  const { data: household, error } = await supabase
    .from('households')
    .insert({ ...parsed.data, created_by: req.user!.userId })
    .select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }

  // The creator is the owner. Written second and checked: a household nobody can
  // administer is worse than no household, so a failure here takes the household
  // with it rather than leaving an unownable one behind.
  const { data: member, error: memberErr } = await supabase
    .from('household_members')
    .insert({ household_id: household.id, user_id: req.user!.userId, role: 'owner', status: 'active' })
    .select().single();

  if (memberErr) {
    await supabase.from('households').delete().eq('id', household.id);
    res.status(500).json({ error: memberErr.message });
    return;
  }

  res.status(201).json({ household, member });
});

// ── PUT /api/households/:id ───────────────────────────────────────────────────
router.put('/:id', async (req: AuthRequest, res: Response) => {
  const parsed = createSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  if (!(await requireRole(req, res, req.params.id, 'rename_household'))) return;

  const { data, error } = await supabase
    .from('households').update({ ...parsed.data, updated_at: nowIso() })
    .eq('id', req.params.id).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

// ── DELETE /api/households/:id ────────────────────────────────────────────────
// Deletes the household, its memberships and its invitations. Every shared row
// reverts to personal via the `ON DELETE SET NULL` on household_id — the money
// was never the household's, so there is nothing of anyone's to delete.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  if (!(await requireRole(req, res, req.params.id, 'delete_household'))) return;

  const unshared = await sharedRowCounts(req.params.id);
  const { error } = await supabase.from('households').delete().eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true, unshared });
});

// ── GET /api/households/:id/members ───────────────────────────────────────────
router.get('/:id/members', async (req: AuthRequest, res: Response) => {
  if (!(await requireRole(req, res, req.params.id, 'view_shared'))) return;
  res.json(await membersOf(req.params.id));
});

// ── PATCH /api/households/:id/members/:memberId ───────────────────────────────
// Role changes only, and never to or from owner: see /transfer for that.
router.patch('/:id/members/:memberId', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ role: z.enum(INVITABLE_ROLES) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Choose a role of admin, member or viewer.' }); return; }
  if (!(await requireRole(req, res, req.params.id, 'change_role'))) return;

  const { data: target } = await supabase.from('household_members').select('*')
    .eq('id', req.params.memberId).eq('household_id', req.params.id).maybeSingle();
  if (!target || target.status !== 'active') { res.status(404).json({ error: 'Member not found' }); return; }
  if (target.role === 'owner') {
    res.status(400).json({ error: 'Hand the household to someone else before changing your own role.' });
    return;
  }

  const { data, error } = await supabase.from('household_members')
    .update({ role: parsed.data.role, updated_at: nowIso() })
    .eq('id', req.params.memberId).select().single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  // A viewer may look at shared money and not change it, so the changes they
  // proposed while they could stop standing in the household's view of it.
  if (parsed.data.role === 'viewer') await dropProposalsBy(target.user_id as string, req.params.id);
  res.json(data);
});

// ── DELETE /api/households/:id/members/:memberId ──────────────────────────────
// Removal takes ACCESS, never money. The member's own shared rows revert to
// personal — still theirs — and the rows other members own are untouched.
router.delete('/:id/members/:memberId', async (req: AuthRequest, res: Response) => {
  const householdId = req.params.id;
  const guard = await requireRole(req, res, householdId, 'remove_member');
  if (!guard) return;

  const { data: target } = await supabase.from('household_members').select('*')
    .eq('id', req.params.memberId).eq('household_id', householdId).maybeSingle();
  if (!target || target.status !== 'active') { res.status(404).json({ error: 'Member not found' }); return; }

  if (target.user_id === req.user!.userId) {
    res.status(400).json({ error: 'To remove yourself, leave the household.' }); return;
  }
  if (target.role === 'owner') {
    res.status(400).json({ error: "The household owner can't be removed. They have to hand it over first." });
    return;
  }
  // An admin removing another admin would let two equals eject each other; the
  // owner is the tie-breaker.
  if (guard.role === 'admin' && target.role === 'admin') {
    res.status(403).json({ error: 'Only the owner can remove another admin.' }); return;
  }

  await unshareRowsOf(target.user_id as string, householdId);
  // …and their proposals about everyone ELSE's rows go with them. The rows are
  // untouched; what ends is the household seeing a departed member's version of
  // them, and the owner being asked to adopt it.
  await dropProposalsBy(target.user_id as string, householdId);
  const { error } = await supabase.from('household_members')
    .update({ status: 'removed', removed_at: nowIso(), updated_at: nowIso() })
    .eq('id', req.params.memberId);
  if (error) { res.status(500).json({ error: error.message }); return; }

  res.json({ success: true, unsharedFor: target.user_id });
});

// ── POST /api/households/:id/leave ────────────────────────────────────────────
router.post('/:id/leave', async (req: AuthRequest, res: Response) => {
  const householdId = req.params.id;
  const userId = req.user!.userId;
  const scope = await loadScope(userId);
  const role = roleIn(scope, householdId);
  if (!role) { res.status(404).json({ error: 'Household not found' }); return; }

  if (role === 'owner') {
    const { data: others } = await supabase.from('household_members').select('id')
      .eq('household_id', householdId).eq('status', 'active').neq('user_id', userId);
    if ((others ?? []).length > 0) {
      res.status(400).json({ error: 'Hand the household to someone else before you leave it.' });
      return;
    }
    // Last one out: leaving closes it. The un-share below still runs first, so
    // the rows come home by the same path they would for anybody else.
    await unshareRowsOf(userId, householdId);
    await dropProposalsBy(userId, householdId);
    await supabase.from('households').delete().eq('id', householdId);
    res.json({ success: true, deleted: true });
    return;
  }

  await unshareRowsOf(userId, householdId);
  await dropProposalsBy(userId, householdId);
  const { error } = await supabase.from('household_members')
    .update({ status: 'removed', removed_at: nowIso(), updated_at: nowIso() })
    .eq('household_id', householdId).eq('user_id', userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── POST /api/households/:id/transfer ─────────────────────────────────────────
// Demote then promote, in that order: the database allows exactly one active
// owner, so doing it the other way round would be refused by the index.
router.post('/:id/transfer', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ memberId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Choose who to hand the household to.' }); return; }
  if (!(await requireRole(req, res, req.params.id, 'transfer_ownership'))) return;

  const { data: target } = await supabase.from('household_members').select('*')
    .eq('id', parsed.data.memberId).eq('household_id', req.params.id).maybeSingle();
  if (!target || target.status !== 'active') { res.status(404).json({ error: 'Member not found' }); return; }
  if (target.user_id === req.user!.userId) { res.status(400).json({ error: "You're already the owner." }); return; }

  const { error: demoteErr } = await supabase.from('household_members')
    .update({ role: 'admin', updated_at: nowIso() })
    .eq('household_id', req.params.id).eq('user_id', req.user!.userId);
  if (demoteErr) { res.status(500).json({ error: demoteErr.message }); return; }

  const { data, error } = await supabase.from('household_members')
    .update({ role: 'owner', updated_at: nowIso() })
    .eq('id', parsed.data.memberId).select().single();
  if (error) {
    // Put the household back under an owner rather than leaving it with none.
    await supabase.from('household_members').update({ role: 'owner' })
      .eq('household_id', req.params.id).eq('user_id', req.user!.userId);
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ success: true, owner: data });
});

// ── POST /api/households/:id/code ─────────────────────────────────────────────
//
// Mint or rotate the standing join link.
//
// Rotating invalidates the previous code by overwriting it, so "regenerate" and
// "withdraw the old one" are the same single write — there is never a moment
// when two codes both work, and no list of old codes to reason about.
router.post('/:id/code', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({
    role: z.enum(INVITABLE_ROLES).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  }).safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: 'Choose a role of admin, member or viewer.' }); return; }
  if (!(await requireRole(req, res, req.params.id, 'invite_member'))) return;

  const { data, error } = await supabase.from('households').update({
    join_code: mintCode(),
    ...(parsed.data.role ? { join_role: parsed.data.role } : {}),
    join_code_expires_at: parsed.data.expiresInDays
      ? new Date(Date.now() + parsed.data.expiresInDays * 86_400_000).toISOString()
      : null,
    updated_at: nowIso(),
  }).eq('id', req.params.id).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ household: data });
});

// ── DELETE /api/households/:id/code ───────────────────────────────────────────
// Switches the link off. Nobody already in the household is affected: a code
// mints a membership and is finished with — it is not what anyone's access
// rests on afterwards.
router.delete('/:id/code', async (req: AuthRequest, res: Response) => {
  if (!(await requireRole(req, res, req.params.id, 'invite_member'))) return;

  const { error } = await supabase.from('households')
    .update({ join_code: null, join_code_expires_at: null, updated_at: nowIso() })
    .eq('id', req.params.id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── POST /api/households/join ─────────────────────────────────────────────────
//
// Join by link. Mints a MEMBERSHIP, exactly as accepting an invitation does —
// the code itself grants nothing before or after.
//
// Unlike an invitation this is addressed to nobody, so there is no email to
// check. What replaces that check is the role: a link can only ever hand out
// `join_role`, which is never 'owner' and defaults to 'member'.
router.post('/join', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ code: z.string().min(4).max(200) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter the code they sent you.' }); return; }
  const userId = req.user!.userId;

  const { data: household } = await supabase.from('households').select('*')
    .eq('join_code', parsed.data.code.trim()).maybeSingle();
  if (!household) { res.status(404).json({ error: "That link isn't valid. Ask them for a new one." }); return; }

  const expiry = household.join_code_expires_at as string | null;
  if (expiry && new Date(expiry).getTime() <= Date.now()) {
    res.status(400).json({ error: 'That link has expired. Ask them for a new one.' });
    return;
  }

  // One membership row per person per household — a unique index makes a second
  // impossible — so joining a household you are already in changes nothing and
  // says so, rather than failing or quietly creating a duplicate.
  const { data: existing } = await supabase.from('household_members').select('*')
    .eq('household_id', household.id).eq('user_id', userId).maybeSingle();
  if (existing?.status === 'active') {
    res.json({ success: true, already: true, household, member: existing });
    return;
  }

  const role = (household.join_role as string) ?? 'member';
  const membership = existing
    ? await supabase.from('household_members')
        .update({ role, status: 'active', removed_at: null, joined_at: nowIso(), updated_at: nowIso() })
        .eq('id', existing.id).select().single()
    : await supabase.from('household_members')
        .insert({ household_id: household.id, user_id: userId, role, status: 'active' })
        .select().single();

  if (membership.error) { res.status(500).json({ error: membership.error.message }); return; }
  res.json({ success: true, household, member: membership.data });
});

// ── POST /api/households/:id/invitations ──────────────────────────────────────
router.post('/:id/invitations', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({
    email: z.string().email(),
    role: z.enum(INVITABLE_ROLES).default('member'),
  }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter a valid email address.' }); return; }
  if (!(await requireRole(req, res, req.params.id, 'invite_member'))) return;

  const email = normaliseEmail(parsed.data.email);

  // Already in? Resolved through the users table, because an invitation names an
  // address and a membership names an account.
  const { data: existingUser } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
  if (existingUser) {
    const { data: already } = await supabase.from('household_members').select('id')
      .eq('household_id', req.params.id).eq('user_id', existingUser.id).eq('status', 'active').maybeSingle();
    if (already) { res.status(400).json({ error: "They're already in this household." }); return; }
  }

  const { data: open } = await supabase.from('household_invitations').select('id')
    .eq('household_id', req.params.id).eq('email', email).eq('status', 'pending').maybeSingle();
  if (open) { res.status(400).json({ error: "They've already been invited — the invitation is still open." }); return; }

  const { data, error } = await supabase.from('household_invitations').insert({
    household_id: req.params.id,
    email,
    role: parsed.data.role,
    code: mintCode(),
    invited_by: req.user!.userId,
    status: 'pending',
    expires_at: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000).toISOString(),
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json(data);
});

// ── DELETE /api/households/:id/invitations/:inviteId ──────────────────────────
router.delete('/:id/invitations/:inviteId', async (req: AuthRequest, res: Response) => {
  if (!(await requireRole(req, res, req.params.id, 'invite_member'))) return;

  const { data, error } = await supabase.from('household_invitations')
    .update({ status: 'revoked', updated_at: nowIso() })
    .eq('id', req.params.inviteId).eq('household_id', req.params.id).eq('status', 'pending')
    .select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'That invitation is no longer open.' }); return; }
  res.json({ success: true });
});

// ── POST /api/households/invitations/:code/accept ─────────────────────────────
//
// Accepting mints a MEMBERSHIP. The invitation itself grants nothing, before or
// after — the membership is the only thing any other endpoint ever checks.
//
// The address on the invitation has to match the account accepting it. A code
// that worked for whoever held it would make the address decorative, and a
// leaked code would be an open door into a couple's finances.
router.post('/invitations/:code/accept', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;
  const email = await emailOf(userId);

  const { data: inv } = await supabase.from('household_invitations').select('*')
    .eq('code', req.params.code).maybeSingle();
  if (!inv) { res.status(404).json({ error: 'That invitation could not be found.' }); return; }
  if (inv.status !== 'pending') { res.status(400).json({ error: 'That invitation is no longer open.' }); return; }
  if (new Date(inv.expires_at as string).getTime() <= Date.now()) {
    await supabase.from('household_invitations').update({ status: 'expired' }).eq('id', inv.id);
    res.status(400).json({ error: 'That invitation has expired. Ask them to send another.' });
    return;
  }
  if (!email || normaliseEmail(inv.email as string) !== email) {
    res.status(403).json({ error: 'That invitation was sent to a different email address.' });
    return;
  }

  // One membership row per person per household (a unique index makes a second
  // impossible), so re-joining REACTIVATES the existing row — at the role they
  // were invited back at, never the role they used to hold.
  const { data: existing } = await supabase.from('household_members').select('*')
    .eq('household_id', inv.household_id).eq('user_id', userId).maybeSingle();

  const membership = existing
    ? await supabase.from('household_members')
        .update({ role: inv.role, status: 'active', removed_at: null, joined_at: nowIso(), updated_at: nowIso() })
        .eq('id', existing.id).select().single()
    : await supabase.from('household_members')
        .insert({ household_id: inv.household_id, user_id: userId, role: inv.role, status: 'active' })
        .select().single();

  if (membership.error) { res.status(500).json({ error: membership.error.message }); return; }

  await supabase.from('household_invitations')
    .update({ status: 'accepted', accepted_by: userId, accepted_at: nowIso(), updated_at: nowIso() })
    .eq('id', inv.id);

  const { data: household } = await supabase.from('households').select('*')
    .eq('id', inv.household_id).maybeSingle();

  res.json({ success: true, household, member: membership.data });
});

// ── POST /api/households/invitations/:code/decline ────────────────────────────
router.post('/invitations/:code/decline', async (req: AuthRequest, res: Response) => {
  const email = await emailOf(req.user!.userId);
  const { data: inv } = await supabase.from('household_invitations').select('*')
    .eq('code', req.params.code).maybeSingle();
  if (!inv || inv.status !== 'pending') { res.status(404).json({ error: 'That invitation is no longer open.' }); return; }
  if (!email || normaliseEmail(inv.email as string) !== email) {
    res.status(403).json({ error: 'That invitation was sent to a different email address.' }); return;
  }
  await supabase.from('household_invitations')
    .update({ status: 'declined', updated_at: nowIso() }).eq('id', inv.id);
  res.json({ success: true });
});

export { ROLES };
export default router;
