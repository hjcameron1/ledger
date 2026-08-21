import { Router, Response } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { authenticate, AuthRequest } from '../middleware/auth';
import { supabase } from '../utils/supabase';
import {
  TABLE_OF_RECORD, type ShareRecordType, type SharePermission,
} from '../services/householdScope';

/**
 * Phase 7.2 — direct sharing: sight of ONE row for ONE named person.
 *
 * ── What this router can and cannot do ──────────────────────────────────────
 * It mints codes, redeems them into grants, and ends grants. That is all of it.
 * Nothing here inserts, updates or deletes a bank account, a transaction, a
 * loan, a property, a budget or a goal — so no request this file serves can move
 * a balance, and no grant it creates can change whose row anything is.
 *
 * Which is the answer to the obvious worry about sharing an account: the
 * recipient sees the same single row the owner is looking at, with the same
 * balance and the same transactions, and it enters NOBODY's totals but the
 * owner's. Two people looking at one account has never meant two accounts' worth
 * of money exists.
 *
 * ── Why a code rather than an email address ─────────────────────────────────
 * A household invitation names an address, because a household is a standing
 * group and you should know who you are letting in before they arrive. A share
 * link is the other case: one person showing one other person one thing, often
 * somebody whose Ledger email they do not know. So the code carries the
 * permission — and, being a bearer token for sight of a bank account, it is
 * single-use and short-lived by default rather than generous.
 */

const router = Router();
router.use(authenticate);

const SHARE_CODE_TTL_DAYS = 14;
const nowIso = () => new Date().toISOString();

/** Random, unguessable, and short enough to be pasted by a human. */
const mintCode = () => crypto.randomBytes(16).toString('base64url');

const RECORD_TYPES = [
  'account', 'card', 'transaction', 'loan', 'property', 'budget', 'goal',
  'investment', 'income',
] as const;

/**
 * Does this user OWN this row?
 *
 * The only question that matters before a grant is made. A household member who
 * can edit the joint account still cannot hand out sight of it: editing somebody
 * else's account and publishing it to a stranger are not the same permission,
 * and a grant made by a non-owner would be access the owner never agreed to and
 * would not find in their own list.
 */
async function ownsRecord(
  type: ShareRecordType, recordId: string, userId: string,
): Promise<boolean> {
  const { data } = await supabase
    .from(TABLE_OF_RECORD[type]).select('user_id').eq('id', recordId).maybeSingle();
  return !!data && (data as { user_id?: string }).user_id === userId;
}

/** Names for both sides of a grant, so the Sharing screen can render without a
 *  second round trip. */
async function namesFor(userIds: string[]): Promise<Map<string, { email: string; name: string | null }>> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (!unique.length) return new Map();
  const { data } = await supabase.from('users').select('id, email, name').in('id', unique);
  const out = new Map<string, { email: string; name: string | null }>();
  for (const u of data ?? []) {
    out.set(u.id as string, { email: u.email as string, name: (u.name as string) ?? null });
  }
  return out;
}

// ── GET /api/shares ───────────────────────────────────────────────────────────
//
// Everything the client needs in one round trip: the grants this user gave, the
// grants they hold, and the codes they have minted that nobody has redeemed yet.
router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;

  const [given, held, codes] = await Promise.all([
    supabase.from('record_shares').select('*')
      .eq('owner_user_id', userId).eq('status', 'active'),
    supabase.from('record_shares').select('*')
      .eq('shared_with_user_id', userId).eq('status', 'active'),
    supabase.from('share_codes').select('*')
      .eq('owner_user_id', userId).eq('status', 'active')
      .gt('expires_at', nowIso()),
  ]);

  // A failure here must not break the app for the overwhelming majority who
  // share nothing — and, not least, for everybody in the window between this
  // deploying and the migration running.
  if (given.error || held.error) {
    console.warn('[sharing] grant listing failed:', (given.error ?? held.error)?.message);
    res.json({ shares: [], codes: [] });
    return;
  }

  const shares = [...(given.data ?? []), ...(held.data ?? [])];
  const names = await namesFor(shares.flatMap(s => [s.owner_user_id, s.shared_with_user_id]));

  res.json({
    shares: shares.map(s => {
      const owner = names.get(s.owner_user_id as string);
      const recipient = names.get(s.shared_with_user_id as string);
      return {
        ...s,
        owner_email: owner?.email ?? null,
        owner_name: owner?.name ?? null,
        shared_with_email: recipient?.email ?? null,
        shared_with_name: recipient?.name ?? null,
      };
    }),
    codes: codes.error ? [] : codes.data ?? [],
  });
});

// ── POST /api/shares/codes ────────────────────────────────────────────────────
//
// Mint a share link for a row the caller owns.
const codeSchema = z.object({
  record_type: z.enum(RECORD_TYPES),
  record_id: z.string().uuid(),
  permission: z.enum(['view', 'edit']).default('view'),
  /** What the row is called, stored so the recipient sees something meaningful
   *  before the row itself reaches their device. Cosmetic; nothing reads it to
   *  make a decision. */
  label: z.string().max(120).optional(),
  expiresInDays: z.number().int().min(1).max(90).optional(),
});

router.post('/codes', async (req: AuthRequest, res: Response) => {
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues }); return; }
  const userId = req.user!.userId;
  const { record_type, record_id, permission, label, expiresInDays } = parsed.data;

  if (!(await ownsRecord(record_type, record_id, userId))) {
    res.status(403).json({ error: 'Only the person this belongs to can share it.' });
    return;
  }

  const { data, error } = await supabase.from('share_codes').insert({
    code: mintCode(),
    record_type,
    record_id,
    owner_user_id: userId,
    permission,
    max_uses: 1,
    uses: 0,
    status: 'active',
    record_label: label ?? null,
    expires_at: new Date(Date.now() + (expiresInDays ?? SHARE_CODE_TTL_DAYS) * 86_400_000).toISOString(),
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.status(201).json({ code: data });
});

// ── DELETE /api/shares/codes/:id ──────────────────────────────────────────────
//
// Withdraw a code nobody has redeemed. Grants already made from it are NOT
// affected: a code mints a grant and is finished with, and taking somebody's
// access away is a separate, deliberate act (below).
router.delete('/codes/:id', async (req: AuthRequest, res: Response) => {
  const { data, error } = await supabase.from('share_codes')
    .update({ status: 'revoked', updated_at: nowIso() })
    .eq('id', req.params.id).eq('owner_user_id', req.user!.userId).eq('status', 'active')
    .select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'That code is no longer active.' }); return; }
  res.json({ success: true });
});

// ── POST /api/shares/redeem ───────────────────────────────────────────────────
//
// Redeem a code into a grant.
//
// Two refusals worth stating out loud. Your OWN code does nothing — you already
// own the row, and a grant would put your own account into your own "shared with
// you" list. And a code for something you can ALREADY see returns the existing
// grant rather than a second one: together with the one-live-grant-per-person
// index in the database, that is the whole of duplicate prevention, and no
// amount of link-passing can make one row appear on one screen twice.
router.post('/redeem', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ code: z.string().min(4).max(200) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Enter the code they sent you.' }); return; }
  const userId = req.user!.userId;

  const { data: code } = await supabase.from('share_codes').select('*')
    .eq('code', parsed.data.code.trim()).maybeSingle();
  if (!code) { res.status(404).json({ error: "That code isn't valid. Ask them for a new one." }); return; }

  if (code.status !== 'active') {
    res.status(400).json({ error: 'That code is no longer active.' }); return;
  }
  if (new Date(code.expires_at as string).getTime() <= Date.now()) {
    await supabase.from('share_codes').update({ status: 'revoked' }).eq('id', code.id);
    res.status(400).json({ error: 'That code has expired. Ask them for a new one.' });
    return;
  }
  const maxUses = code.max_uses as number | null;
  if (maxUses != null && (code.uses as number) >= maxUses) {
    res.status(400).json({ error: 'That code has already been used.' }); return;
  }
  if (code.owner_user_id === userId) {
    res.status(400).json({ error: "That's your own share code — this already belongs to you." });
    return;
  }

  const { data: existing } = await supabase.from('record_shares').select('*')
    .eq('record_type', code.record_type).eq('record_id', code.record_id)
    .eq('shared_with_user_id', userId).eq('status', 'active').maybeSingle();
  if (existing) {
    res.json({ success: true, already: true, share: existing });
    return;
  }

  const { data: share, error } = await supabase.from('record_shares').insert({
    record_type: code.record_type,
    record_id: code.record_id,
    owner_user_id: code.owner_user_id,
    shared_with_user_id: userId,
    permission: code.permission,
    status: 'active',
    via_code: code.code,
    record_label: code.record_label ?? null,
  }).select().single();

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Spend the use. Done AFTER the grant so a failure leaves a usable code rather
  // than a spent one that granted nothing.
  const uses = (code.uses as number) + 1;
  await supabase.from('share_codes').update({
    uses,
    status: maxUses != null && uses >= maxUses ? 'used' : 'active',
    updated_at: nowIso(),
  }).eq('id', code.id);

  res.status(201).json({ success: true, share });
});

// ── PATCH /api/shares/:id ─────────────────────────────────────────────────────
//
// Change what somebody may do with a row you own. Owner-only: the recipient does
// not get to promote themselves.
router.patch('/:id', async (req: AuthRequest, res: Response) => {
  const parsed = z.object({ permission: z.enum(['view', 'edit']) }).safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'Choose view or edit.' }); return; }

  const { data, error } = await supabase.from('record_shares')
    .update({ permission: parsed.data.permission as SharePermission, updated_at: nowIso() })
    .eq('id', req.params.id).eq('owner_user_id', req.user!.userId).eq('status', 'active')
    .select().maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return; }
  if (!data) { res.status(404).json({ error: 'Not found' }); return; }
  res.json({ share: data });
});

// ── DELETE /api/shares/:id ────────────────────────────────────────────────────
//
// End a grant, from either side — and it is the same safe operation either way.
//
// The owner REVOKES; the recipient LEAVES. Both stop the access completely and
// NEITHER deletes anything: the account keeps its balance, its transactions and
// its owner, and disappears from exactly one screen. Which side ended it is
// recorded because "they took it back" and "I gave it back" are not the same
// story, and a shared-finances feature should be able to tell you which happened.
router.delete('/:id', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.userId;

  const { data: grant } = await supabase.from('record_shares').select('*')
    .eq('id', req.params.id).maybeSingle();
  if (!grant || grant.status !== 'active') {
    res.status(404).json({ error: 'That access has already ended.' }); return;
  }

  const isOwner = grant.owner_user_id === userId;
  const isRecipient = grant.shared_with_user_id === userId;
  if (!isOwner && !isRecipient) { res.status(404).json({ error: 'Not found' }); return; }

  const { error } = await supabase.from('record_shares').update({
    status: isOwner ? 'revoked' : 'left',
    ended_at: nowIso(),
    updated_at: nowIso(),
  }).eq('id', req.params.id);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true, endedBy: isOwner ? 'owner' : 'recipient', deleted: [] });
});

export default router;
