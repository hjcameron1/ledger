/**
 * Phase 7.1 — the household engine.
 *
 * The law under test, in one line: sharing changes who can SEE a row, never how
 * many rows there are. Almost every case below is a way of trying to break that
 * — two people looking at one account, a member leaving, a stale household id, a
 * viewer reaching for the edit button — and checking that the arithmetic and the
 * privacy both survive it.
 */

import { describe, it, expect } from 'vitest';
import type {
  Household, HouseholdInvitation, HouseholdMember, HouseholdRole, Shareable,
} from '../types';
import {
  ROLE_ORDER, roleRank, roleCan, buildContext, activeMembers, membershipOf, roleIn,
  isMemberOf, myHouseholds, activeHousehold, activeHouseholdId, inAnyHousehold, can,
  isShared, isOwnedBy, canView, canEdit, editRefusal, canShare, shareRefusal, canUnshare,
  visibleRows, personalRows, householdRows, scopeRows, dedupeById, partitionByOwner,
  hasHouseholdOverlay,
  memberRows, responsibleFor, byResponsibility, planShare, planUnshare,
  invitationStatus, isLiveInvitation, liveInvitations, invitationsFor,
  planInvitation, planAcceptance, planDecline, planRevoke,
  planRoleChange, planMemberRemoval, planLeave, planOwnershipTransfer,
  planHouseholdDeletion, summariseSharing, memberViews, INVITE_TTL_DAYS,
} from './household';

// ── The cast ────────────────────────────────────────────────────────────────
// A couple: Ada owns the household, Bo is the partner. Cy is a stranger who is
// in no household at all and exists to prove nothing leaks.
const ADA = 'user-ada';
const BO  = 'user-bo';
const CY  = 'user-cy';
const HH  = 'hh-1';
// A second household Ada is also in — a row can be shared with both at once.
const OTHER_HH = 'hh-2';

const NOW = '2026-08-20T00:00:00.000Z';
const later = (days: number) => new Date(Date.parse(NOW) + days * 86_400_000).toISOString();

const household = (o: Partial<Household> = {}): Household =>
  ({ id: HH, name: 'Ada & Bo', created_by: ADA, currency: 'AUD', ...o });

const member = (o: Partial<HouseholdMember> = {}): HouseholdMember =>
  ({ id: `m-${o.user_id ?? ADA}`, household_id: HH, user_id: ADA, role: 'owner', status: 'active', ...o });

const invite = (o: Partial<HouseholdInvitation> = {}): HouseholdInvitation =>
  ({
    id: 'inv-1', household_id: HH, email: 'bo@example.com', role: 'member',
    code: 'CODE123', invited_by: ADA, status: 'pending', expires_at: later(7), ...o,
  });

/** A row of any shareable kind — the engine only ever reads these three fields.
 *  A row can be in SEVERAL households, so this takes as many as you like. */
const row = (id: string, user_id: string, ...households: (string | null)[]): Shareable =>
  ({ id, user_id, household_ids: households.filter(Boolean) as string[] });

/** The couple, as the engine sees them from Ada's side (and Bo's, and a stranger's). */
const COUPLE = [member({ user_id: ADA, role: 'owner' }), member({ user_id: BO, role: 'member' })];
const asAda = (members = COUPLE, active?: string | null) => buildContext(ADA, [household()], members, active);
const asBo  = (members = COUPLE, active?: string | null) => buildContext(BO,  [household()], members, active);
const asCy  = () => buildContext(CY, [], []);
/** Ada in BOTH households — what multi-household sharing is written against. */
const inBoth = () => buildContext(
  ADA,
  [household(), household({ id: OTHER_HH, name: 'The Camerons' })],
  [...COUPLE, member({ id: 'm-ada-2', household_id: OTHER_HH, user_id: ADA, role: 'member' })],
);
/** One person, no household — the case that must behave exactly as it always did. */
const solo = () => buildContext(ADA, [], []);

// ═════════════════════════════════════════════════════════════════════════════
//  Roles and permissions
// ═════════════════════════════════════════════════════════════════════════════

describe('roles', () => {
  it('ranks weakest to strongest', () => {
    expect(ROLE_ORDER).toEqual(['viewer', 'member', 'admin', 'owner']);
    expect(roleRank('owner')).toBeGreaterThan(roleRank('admin'));
    expect(roleRank('admin')).toBeGreaterThan(roleRank('member'));
    expect(roleRank('member')).toBeGreaterThan(roleRank('viewer'));
    expect(roleRank(null)).toBe(-1);
  });

  it('lets every role see the shared picture', () => {
    for (const r of ROLE_ORDER) expect(roleCan(r, 'view_shared')).toBe(true);
  });

  it('stops a viewer changing or adding anything', () => {
    expect(roleCan('viewer', 'edit_shared')).toBe(false);
    expect(roleCan('viewer', 'share_own')).toBe(false);
    expect(roleCan('viewer', 'invite_member')).toBe(false);
  });

  it('lets a member edit the shared money but not manage people', () => {
    expect(roleCan('member', 'edit_shared')).toBe(true);
    expect(roleCan('member', 'share_own')).toBe(true);
    expect(roleCan('member', 'invite_member')).toBe(false);
    expect(roleCan('member', 'remove_member')).toBe(false);
  });

  it('lets an admin manage people but not roles or the household itself', () => {
    expect(roleCan('admin', 'invite_member')).toBe(true);
    expect(roleCan('admin', 'remove_member')).toBe(true);
    expect(roleCan('admin', 'change_role')).toBe(false);
    expect(roleCan('admin', 'transfer_ownership')).toBe(false);
    expect(roleCan('admin', 'delete_household')).toBe(false);
  });

  it('reserves roles, ownership and deletion for the owner', () => {
    expect(roleCan('owner', 'change_role')).toBe(true);
    expect(roleCan('owner', 'transfer_ownership')).toBe(true);
    expect(roleCan('owner', 'delete_household')).toBe(true);
  });

  it('grants a non-member nothing', () => {
    expect(roleCan(null, 'view_shared')).toBe(false);
    expect(can(asCy(), 'view_shared', HH)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Membership
// ═════════════════════════════════════════════════════════════════════════════

describe('membership', () => {
  it('reads a couple from either side', () => {
    expect(roleIn(asAda(), HH)).toBe('owner');
    expect(roleIn(asBo(), HH)).toBe('member');
    expect(roleIn(asAda(), HH, BO)).toBe('member');
  });

  it('treats a removed member as not in the household', () => {
    const members = [member({ user_id: ADA }), member({ user_id: BO, role: 'member', status: 'removed' })];
    expect(isMemberOf(asAda(members), HH, BO)).toBe(false);
    expect(membershipOf(asBo(members), HH)).toBeNull();
    expect(activeMembers(members, HH)).toHaveLength(1);
  });

  it('lists only the households the user is actually in', () => {
    const ctx = buildContext(ADA, [household(), household({ id: 'hh-2', name: 'Parents' })], COUPLE);
    expect(myHouseholds(ctx).map(h => h.id)).toEqual([HH]);
    expect(inAnyHousehold(ctx)).toBe(true);
    expect(inAnyHousehold(solo())).toBe(false);
  });

  it('picks the requested household, and ignores an id the user is not in', () => {
    const two = [household(), household({ id: 'hh-2', name: 'Parents' })];
    const ctx = buildContext(ADA, two, [...COUPLE, member({ id: 'm-a2', household_id: 'hh-2', user_id: ADA })]);
    expect(activeHouseholdId(buildContext(ADA, two, ctx.members, 'hh-2'))).toBe('hh-2');
    // A stale id — left over from a household they were removed from — must not
    // keep resolving, or the view answers questions about a household they lost.
    // It resolves to NOTHING rather than to another of their households: the
    // switcher is naming one household and the numbers must never be a
    // different one's. The shell clears the stale id and says so.
    expect(activeHouseholdId(asAda(COUPLE, 'hh-999'))).toBeNull();
    expect(activeHousehold(solo())).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One person, no household — nothing may change for them
// ═════════════════════════════════════════════════════════════════════════════

describe('a one-person account', () => {
  const rows = [row('a1', ADA), row('a2', ADA)];

  it('sees all their own rows in the personal view', () => {
    expect(personalRows(rows, solo())).toHaveLength(2);
    expect(visibleRows(rows, solo())).toHaveLength(2);
  });

  it('has an empty household view and no household to switch to', () => {
    expect(householdRows(rows, solo())).toEqual([]);
    expect(scopeRows(rows, solo(), 'household')).toEqual([]);
    expect(inAnyHousehold(solo())).toBe(false);
  });

  it('still owns rows that carry no user_id at all (older local rows)', () => {
    const legacy = [{ id: 'x', household_id: null } as Shareable];
    expect(personalRows(legacy, solo())).toHaveLength(1);
    expect(canEdit(legacy[0], solo())).toBe(true);
  });

  it('can do nothing household-shaped, because there is no household', () => {
    expect(can(solo(), 'invite_member')).toBe(false);
    expect(planShare(rows[0], solo(), HH).ok).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A couple with a shared account
// ═════════════════════════════════════════════════════════════════════════════

describe('a couple sharing an account', () => {
  // Ada owns the joint account and shares it. Each also keeps one private row.
  const joint   = row('joint', ADA, HH);
  const adaOnly = row('ada-private', ADA);
  const boOnly  = row('bo-private', BO);
  const boCar   = row('bo-car', BO, HH);
  const all     = [joint, adaOnly, boOnly, boCar];

  it('shows the shared account to both of them', () => {
    expect(canView(joint, asAda())).toBe(true);
    expect(canView(joint, asBo())).toBe(true);
  });

  it('counts the shared account ONCE in the household view, from either side', () => {
    const fromAda = householdRows(all, asAda());
    const fromBo  = householdRows(all, asBo());
    expect(fromAda.map(r => r.id).sort()).toEqual(['bo-car', 'joint']);
    expect(fromBo.map(r => r.id).sort()).toEqual(['bo-car', 'joint']);
    // The same two rows, not four: two people looking does not make two accounts.
    expect(fromAda.filter(r => r.id === 'joint')).toHaveLength(1);
    expect(fromBo.filter(r => r.id === 'joint')).toHaveLength(1);
  });

  it('keeps the shared account in its OWNER\'s personal view, and only theirs', () => {
    // Sharing told Bo about it; it did not give it away. It is still Ada's money,
    // and the household is just a combined view — it never takes the row out of
    // her own "My Finances".
    expect(personalRows(all, asAda()).map(r => r.id).sort()).toEqual(['ada-private', 'joint']);
    expect(personalRows(all, asBo()).map(r => r.id).sort()).toEqual(['bo-car', 'bo-private']);
    expect(householdRows(all, asAda()).map(r => r.id).sort()).toEqual(['bo-car', 'joint']);
  });

  it('never lets the household view show a private row', () => {
    const shared = householdRows(all, asAda());
    expect(shared.map(r => r.id)).not.toContain('ada-private');
    expect(shared.map(r => r.id)).not.toContain('bo-private');
  });

  it('never shows one partner the other\'s private row anywhere', () => {
    expect(canView(boOnly, asAda())).toBe(false);
    expect(canView(adaOnly, asBo())).toBe(false);
    expect(visibleRows(all, asAda()).map(r => r.id)).not.toContain('bo-private');
    expect(visibleRows(all, asBo()).map(r => r.id)).not.toContain('ada-private');
  });

  it('gives each of them everything shared plus their own, and nothing else', () => {
    expect(visibleRows(all, asAda()).map(r => r.id).sort())
      .toEqual(['ada-private', 'bo-car', 'joint']);
    expect(visibleRows(all, asBo()).map(r => r.id).sort())
      .toEqual(['bo-car', 'bo-private', 'joint']);
  });

  it('lets the partner edit a shared row and not a private one', () => {
    expect(canEdit(joint, asBo())).toBe(true);
    expect(canEdit(adaOnly, asBo())).toBe(false);
    expect(editRefusal(adaOnly, asBo())).toMatch(/personal finances/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Net-worth aggregation: counted once, and the parts add up
// ═════════════════════════════════════════════════════════════════════════════

describe('household aggregation', () => {
  // Values stand in for balances; the engine partitions and the caller sums, so
  // this proves the partition that any total is built on.
  const valued = (id: string, owner: string, hh: string | null, value: number) =>
    ({ ...row(id, owner, hh), value });
  const rows = [
    valued('joint', ADA, HH, 10_000),
    valued('bo-car', BO, HH, 25_000),
    valued('ada-secret', ADA, null, 5_000),
    valued('bo-secret', BO, null, 3_000),
  ];
  const sum = (rs: { value: number }[]) => rs.reduce((t, r) => t + r.value, 0);

  it('puts every shared row in exactly one owner\'s bucket', () => {
    const parts = partitionByOwner(rows, asAda());
    expect([...parts.keys()].sort()).toEqual([ADA, BO].sort());
    expect(parts.get(ADA)!.map(r => r.id)).toEqual(['joint']);
    expect(parts.get(BO)!.map(r => r.id)).toEqual(['bo-car']);

    const bucketed = [...parts.values()].flat().map(r => r.id);
    expect(bucketed).toHaveLength(new Set(bucketed).size);   // nothing twice
    expect(bucketed.sort()).toEqual(householdRows(rows, asAda()).map(r => r.id).sort()); // nothing missing
  });

  it('adds the members\' contributions up to exactly the household total', () => {
    const total = sum(householdRows(rows, asAda()));
    const perMember = activeMembers(COUPLE, HH)
      .map(m => sum(memberRows(rows, asAda(), m.user_id)));
    expect(total).toBe(35_000);
    expect(perMember.reduce((a, b) => a + b, 0)).toBe(total);
  });

  it('reaches the same household total from either partner\'s session', () => {
    expect(sum(householdRows(rows, asAda()))).toBe(sum(householdRows(rows, asBo())));
  });

  it('leaves private money out of the household total but in its owner\'s', () => {
    expect(sum(householdRows(rows, asAda()))).toBe(35_000);          // no secrets
    expect(sum(personalRows(rows, asAda()))).toBe(15_000);           // joint + secret
    expect(sum(personalRows(rows, asBo()))).toBe(28_000);
  });

  it('does not double-count a row that reaches the list twice', () => {
    const doubled = [...rows, rows[0]];
    expect(householdRows(doubled, asAda())).toHaveLength(2);
    expect(sum(householdRows(doubled, asAda()))).toBe(35_000);
    expect(dedupeById([{ id: 'a' }, { id: 'a' }, { id: 'b' }])).toHaveLength(2);
  });

  it('counts nothing at all for someone outside the household', () => {
    expect(householdRows(rows, asCy())).toEqual([]);
    expect(personalRows(rows, asCy())).toEqual([]);
    expect(visibleRows(rows, asCy())).toEqual([]);
  });

  it('summarises who brought what without ever adding per-member lists together', () => {
    const s = summariseSharing(rows, asAda());
    expect(s).toEqual({ sharedByMe: 1, personalToMe: 1, sharedByOthers: 1, householdTotal: 2 });
    expect(s.sharedByMe + s.sharedByOthers).toBe(s.householdTotal);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Ownership and responsibility on a shared transaction
// ═════════════════════════════════════════════════════════════════════════════

describe('a shared transaction keeps its ownership', () => {
  const txn = (id: string, owner: string, responsible?: string) =>
    ({ ...row(id, owner, HH), responsible_user_id: responsible ?? null });

  it('falls back to the owner when nobody has been attributed', () => {
    expect(responsibleFor(txn('t1', ADA))).toBe(ADA);
  });

  it('attributes the spend to the partner without moving the record', () => {
    const t = txn('t1', ADA, BO);
    expect(responsibleFor(t)).toBe(BO);
    // The record is still Ada's: her personal view keeps it, Bo's does not.
    expect(personalRows([t], asAda())).toHaveLength(1);
    expect(personalRows([t], asBo())).toHaveLength(0);
    // …and it is still exactly one row in the household view.
    expect(householdRows([t], asBo())).toHaveLength(1);
  });

  it('splits shared spending by who is responsible, counting each once', () => {
    const rows = [txn('t1', ADA), txn('t2', ADA, BO), txn('t3', BO)];
    const by = byResponsibility(rows, asAda());
    expect(by.get(ADA)!.map(r => r.id)).toEqual(['t1']);
    expect(by.get(BO)!.map(r => r.id).sort()).toEqual(['t2', 't3']);
    expect([...by.values()].flat()).toHaveLength(3);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Household edit overlays — a member's change the owner hasn't approved
// ═════════════════════════════════════════════════════════════════════════════
//
// Bo (a member) edits Ada's shared account. The change lives as an OVERLAY on
// the row, keyed by household: the household view shows Bo's version, and
// nothing else does — Ada's own record hasn't moved until she says yes.

describe('a member edit shows in the household view without touching the owner', () => {
  const account = () => ({
    ...row('joint', ADA, HH),
    name: 'Everyday', balance: 30_000,
    household_overlays: { [HH]: { balance: 25_000, name: 'Joint everyday' } },
  });

  it('shows the household Bo’s version of Ada’s row', () => {
    const [seen] = householdRows([account()], asBo());
    expect(seen.balance).toBe(25_000);
    expect(seen.name).toBe('Joint everyday');
  });

  it('leaves the owner’s personal view exactly as the owner has it', () => {
    const [mine] = personalRows([account()], asAda());
    expect(mine.balance).toBe(30_000);
    expect(mine.name).toBe('Everyday');
  });

  it('applies only the household the overlay belongs to', () => {
    // The same row shared with a second household Ada is in — that household
    // never edited it, so it sees the row as the owner has it.
    const shared = { ...account(), household_ids: [HH, OTHER_HH] };
    const [other] = householdRows([shared], inBoth(), OTHER_HH);
    expect(other.balance).toBe(30_000);
    const [couple] = householdRows([shared], inBoth(), HH);
    expect(couple.balance).toBe(25_000);
  });

  it('can never move identity or ownership through an overlay', () => {
    const hijack = {
      ...account(),
      household_overlays: { [HH]: { id: 'other-row', user_id: BO, balance: 1 } },
    };
    const [seen] = householdRows([hijack], asBo());
    expect(seen.id).toBe('joint');
    expect(seen.user_id).toBe(ADA);
    expect(seen.balance).toBe(1); // the honest part of the patch still applies
  });

  it('tells the sharing panel when a household kept its own version', () => {
    expect(hasHouseholdOverlay(account(), HH)).toBe(true);
    expect(hasHouseholdOverlay(account(), OTHER_HH)).toBe(false);
    expect(hasHouseholdOverlay(row('plain', ADA, HH), HH)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Sharing and un-sharing a row
// ═════════════════════════════════════════════════════════════════════════════

describe('sharing a row', () => {
  it('shares into the household and touches nothing else', () => {
    const plan = planShare(row('a1', ADA), asAda(), HH);
    expect(plan.ok).toBe(true);
    expect(plan.patch).toEqual({ household_ids: [HH] });
    expect(Object.keys(plan.patch!)).toEqual(['household_ids']);
  });

  it('ADDS a household rather than replacing the one it is in', () => {
    // The whole of multi-household sharing: an account already in the couple
    // that is shared with the family belongs to BOTH afterwards.
    const plan = planShare(row('a1', ADA, HH), inBoth(), OTHER_HH);
    expect(plan.ok).toBe(true);
    expect(plan.patch!.household_ids.sort()).toEqual([HH, OTHER_HH].sort());
  });

  it('still understands a row saved before multi-household sharing', () => {
    // A cache written by the old client carries the single `household_id`.
    const legacy = { id: 'a1', user_id: ADA, household_id: HH } as Shareable;
    expect(isShared(legacy)).toBe(true);
    expect(planShare(legacy, asAda(), HH).error).toMatch(/already shared/);
  });

  it('refuses to share someone else\'s row', () => {
    const plan = planShare(row('b1', BO), asAda(), HH);
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/Only the person this belongs to/);
  });

  it('refuses a viewer', () => {
    const ctx = asBo([member({ user_id: ADA }), member({ user_id: BO, role: 'viewer' })]);
    expect(planShare(row('b1', BO), ctx, HH).ok).toBe(false);
    expect(shareRefusal(row('b1', BO), ctx, HH)).toMatch(/Viewers/);
  });

  it('refuses a household the user is not in', () => {
    expect(planShare(row('c1', CY), asCy(), HH).ok).toBe(false);
    expect(shareRefusal(row('a1', ADA), buildContext(ADA, [], []), HH)).toMatch(/not a member/);
  });

  it('is a no-op when it is already shared there', () => {
    expect(planShare(row('a1', ADA, HH), asAda(), HH).error).toMatch(/already shared/);
  });

  it('lets the owner take it back, and nobody else', () => {
    const shared = row('a1', ADA, HH);
    expect(canUnshare(shared, asAda())).toBe(true);
    expect(canUnshare(shared, asBo())).toBe(false);
    expect(planUnshare(shared, asAda()).patch).toEqual({ household_ids: [] });
    expect(planUnshare(shared, asBo()).error).toMatch(/Only the person this belongs to/);
    expect(planUnshare(row('a1', ADA), asAda()).error).toMatch(/already personal/);
  });

  it('takes it out of ONE household and leaves the others alone', () => {
    const both = row('a1', ADA, HH, OTHER_HH);
    expect(planUnshare(both, inBoth(), HH).patch).toEqual({ household_ids: [OTHER_HH] });
    expect(planUnshare(both, inBoth(), OTHER_HH).patch).toEqual({ household_ids: [HH] });
    // And "make it personal" still empties it entirely.
    expect(planUnshare(both, inBoth()).patch).toEqual({ household_ids: [] });
  });

  it('shows a shared row is shared, a personal one is not', () => {
    expect(isShared(row('a', ADA, HH))).toBe(true);
    expect(isShared(row('a', ADA))).toBe(false);
    expect(isOwnedBy(row('a', ADA), ADA)).toBe(true);
    expect(isOwnedBy(row('a', BO), ADA)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Invitations
// ═════════════════════════════════════════════════════════════════════════════

describe('invitations', () => {
  const emailOf = (id: string) => ({ [ADA]: 'ada@example.com', [BO]: 'bo@example.com' }[id] ?? null);
  const soloAda = () => buildContext(ADA, [household()], [member({ user_id: ADA })]);

  it('is created by an owner with a fortnight to run', () => {
    const plan = planInvitation(soloAda(), HH, { email: ' BO@Example.com ', role: 'member' },
      { members: [member({ user_id: ADA })], invitations: [], emailOf }, NOW);
    expect(plan.ok).toBe(true);
    expect(plan.invitation!.email).toBe('bo@example.com');   // normalised
    expect(plan.invitation!.role).toBe('member');
    expect(plan.invitation!.expires_at).toBe(later(INVITE_TTL_DAYS));
  });

  it('cannot be sent by a member or a viewer', () => {
    const ctx = asBo();  // Bo is a plain member
    const plan = planInvitation(ctx, HH, { email: 'cy@example.com', role: 'member' },
      { members: COUPLE, invitations: [], emailOf }, NOW);
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/owner or admin/);
  });

  it('refuses a nonsense address, an existing member and a duplicate invite', () => {
    const base = { members: COUPLE, invitations: [], emailOf };
    expect(planInvitation(asAda(), HH, { email: 'not-an-email', role: 'member' }, base, NOW).error)
      .toMatch(/valid email/);
    expect(planInvitation(asAda(), HH, { email: 'bo@example.com', role: 'member' }, base, NOW).error)
      .toMatch(/already in this household/);
    expect(planInvitation(asAda(), HH, { email: 'ada@example.com', role: 'member' }, base, NOW).error)
      .toMatch(/already in this household/);
    expect(planInvitation(soloAda(), HH, { email: 'cy@example.com', role: 'member' },
      { members: [member({ user_id: ADA })], invitations: [invite({ email: 'cy@example.com' })], emailOf }, NOW).error)
      .toMatch(/already been invited/);
  });

  it('goes stale on its own once the expiry passes', () => {
    const inv = invite({ expires_at: later(7) });
    expect(invitationStatus(inv, NOW)).toBe('pending');
    expect(isLiveInvitation(inv, later(8))).toBe(false);
    expect(invitationStatus(inv, later(8))).toBe('expired');
    // A settled invitation keeps whatever it settled as.
    expect(invitationStatus(invite({ status: 'declined' }), later(99))).toBe('declined');
  });

  it('reaches the person it was addressed to, and nobody else', () => {
    const invitations = [invite(), invite({ id: 'inv-2', email: 'cy@example.com' })];
    expect(invitationsFor(invitations, 'BO@example.com', NOW).map(i => i.id)).toEqual(['inv-1']);
    expect(invitationsFor(invitations, 'someone@else.com', NOW)).toEqual([]);
    expect(invitationsFor(invitations, null, NOW)).toEqual([]);
    expect(liveInvitations(invitations, HH, later(30))).toEqual([]);   // both expired
  });

  it('mints a membership on acceptance — and the invitation itself grants nothing', () => {
    const plan = planAcceptance(invite(), { id: BO, email: 'bo@example.com' }, [member({ user_id: ADA })], NOW);
    expect(plan.ok).toBe(true);
    expect(plan.member).toMatchObject({ household_id: HH, user_id: BO, role: 'member', status: 'active' });
    expect(plan.invitationPatch).toEqual({ status: 'accepted', accepted_by: BO, accepted_at: NOW });
  });

  it('refuses an account whose email is not the one invited', () => {
    // A code that worked for whoever held it would make the address decorative.
    const plan = planAcceptance(invite(), { id: CY, email: 'cy@example.com' }, [], NOW);
    expect(plan.ok).toBe(false);
    expect(plan.error).toMatch(/different email/);
  });

  it('refuses an expired, revoked or already-used invitation', () => {
    const bo = { id: BO, email: 'bo@example.com' };
    expect(planAcceptance(invite(), bo, [], later(30)).error).toMatch(/expired/);
    expect(planAcceptance(invite({ status: 'revoked' }), bo, [], NOW).error).toMatch(/no longer open/);
    expect(planAcceptance(invite({ status: 'accepted' }), bo, [], NOW).error).toMatch(/no longer open/);
  });

  it('refuses someone who is already in', () => {
    expect(planAcceptance(invite(), { id: BO, email: 'bo@example.com' }, COUPLE, NOW).error)
      .toMatch(/already in this household/);
  });

  it('lets a previously-removed person re-join at the role they were re-invited at', () => {
    const removed = [member({ user_id: ADA }), member({ user_id: BO, role: 'admin', status: 'removed' })];
    const plan = planAcceptance(invite({ role: 'viewer' }), { id: BO, email: 'bo@example.com' }, removed, NOW);
    expect(plan.ok).toBe(true);
    expect(plan.member!.role).toBe('viewer');       // not the admin they used to be
    expect(plan.member!.removed_at).toBeNull();
  });

  it('can be declined by its recipient and withdrawn by an admin', () => {
    expect(planDecline(invite(), { email: 'bo@example.com' }, NOW).patch).toEqual({ status: 'declined' });
    expect(planDecline(invite(), { email: 'cy@example.com' }, NOW).error).toMatch(/different email/);
    expect(planRevoke(invite(), asAda(), NOW).patch).toEqual({ status: 'revoked' });
    expect(planRevoke(invite(), asBo(), NOW).error).toMatch(/owner or admin/);
    expect(planRevoke(invite({ status: 'declined' }), asAda(), NOW).error).toMatch(/no longer open/);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Roles, removal and leaving
// ═════════════════════════════════════════════════════════════════════════════

describe('changing a role', () => {
  it('is the owner\'s call alone', () => {
    const bo = member({ user_id: BO, role: 'member' });
    expect(planRoleChange(asAda(), bo, 'admin').patch).toEqual({ role: 'admin' });
    expect(planRoleChange(asBo(), bo, 'admin').error).toMatch(/only the household owner/i);
  });

  it('will not make a second owner by the back door', () => {
    expect(planRoleChange(asAda(), member({ user_id: BO, role: 'member' }), 'owner').error)
      .toMatch(/only ever one owner/);
  });

  it('will not demote the owner while they still are one', () => {
    expect(planRoleChange(asAda(), member({ user_id: ADA, role: 'owner' }), 'admin').error)
      .toMatch(/Hand the household to someone else/);
  });

  it('says nothing changed when nothing changed', () => {
    expect(planRoleChange(asAda(), member({ user_id: BO, role: 'member' }), 'member').error)
      .toMatch(/already a member/);
  });
});

describe('removing a member', () => {
  const joint  = row('joint', ADA, HH);
  const boCar  = row('bo-car', BO, HH);
  const boCash = row('bo-cash', BO, HH);
  const shared = [joint, boCar, boCash];
  const bo = () => COUPLE[1];

  it('takes access, never money', () => {
    const plan = planMemberRemoval(asAda(), bo(), shared);
    expect(plan.ok).toBe(true);
    expect(plan.deletes).toEqual([]);                                  // nothing, ever
    expect(plan.unshare.sort()).toEqual(['bo-car', 'bo-cash']);        // Bo's, back to Bo
    expect(plan.losesAccessTo).toEqual(['joint']);                     // Ada's, untouched
  });

  it('leaves the household still holding what the remaining members own', () => {
    const plan = planMemberRemoval(asAda(), bo(), shared);
    const stillShared = shared.filter(r => !plan.unshare.includes(r.id));
    expect(stillShared.map(r => r.id)).toEqual(['joint']);
  });

  it('cuts the removed member off from the shared rows immediately', () => {
    const after = [member({ user_id: ADA }), member({ user_id: BO, role: 'member', status: 'removed' })];
    // No sweep and no cache to purge: their membership stops being active and
    // every filter in the engine stops letting them through.
    expect(householdRows(shared, asBo(after))).toEqual([]);
    expect(canView(joint, asBo(after))).toBe(false);
    expect(canEdit(joint, asBo(after))).toBe(false);
  });

  it('still shows the removed member their own rows, now personal again', () => {
    const after = [member({ user_id: ADA }), member({ user_id: BO, role: 'member', status: 'removed' })];
    const unshared = [joint, row('bo-car', BO), row('bo-cash', BO)];
    expect(personalRows(unshared, asBo(after)).map(r => r.id).sort()).toEqual(['bo-car', 'bo-cash']);
  });

  it('is refused to a plain member', () => {
    expect(planMemberRemoval(asBo(), COUPLE[0], shared).error).toMatch(/owner or admin/);
  });

  it('refuses to remove the owner, or yourself, or an admin peer', () => {
    expect(planMemberRemoval(asAda(), COUPLE[0], shared).error).toMatch(/To remove yourself/);
    const admins = [member({ user_id: ADA, role: 'admin' }), member({ user_id: BO, role: 'admin' })];
    const owner = member({ id: 'm-own', user_id: 'user-own', role: 'owner' });
    const ctx = buildContext(ADA, [household()], [...admins, owner]);
    expect(planMemberRemoval(ctx, owner, shared).error).toMatch(/owner can't be removed/);
    expect(planMemberRemoval(ctx, admins[1], shared).error).toMatch(/Only the owner can remove another admin/);
  });

  it('refuses to remove someone who has already gone', () => {
    expect(planMemberRemoval(asAda(), member({ user_id: BO, role: 'member', status: 'removed' }), shared).error)
      .toMatch(/not in this household/);
  });
});

describe('leaving', () => {
  const shared = [row('joint', ADA, HH), row('bo-car', BO, HH)];

  it('takes your own rows home with you and leaves everyone else\'s alone', () => {
    const plan = planLeave(asBo(), HH, shared);
    expect(plan.ok).toBe(true);
    expect(plan.unshare).toEqual(['bo-car']);
    expect(plan.losesAccessTo).toEqual(['joint']);
    expect(plan.deletes).toEqual([]);
  });

  it('makes the owner hand over first, while anyone is still there', () => {
    expect(planLeave(asAda(), HH, shared).error).toMatch(/Hand the household to someone else/);
  });

  it('lets the last person out close the door behind them', () => {
    const alone = buildContext(ADA, [household()], [member({ user_id: ADA })]);
    const plan = planLeave(alone, HH, [row('joint', ADA, HH)]);
    expect(plan.ok).toBe(true);
    expect(plan.unshare).toEqual(['joint']);
  });

  it('refuses someone who was never in it', () => {
    expect(planLeave(asCy(), HH, shared).error).toMatch(/not in this household/);
  });
});

describe('handing the household over', () => {
  it('demotes the old owner in the same breath as promoting the new one', () => {
    const plan = planOwnershipTransfer(asAda(), COUPLE[1]);
    expect(plan.ok).toBe(true);
    expect(plan.demote).toEqual({ memberId: `m-${ADA}`, role: 'admin' });
    expect(plan.promote).toEqual({ memberId: `m-${BO}`, role: 'owner' });
  });

  it('is refused to everyone but the owner', () => {
    expect(planOwnershipTransfer(asBo(), COUPLE[0]).error).toMatch(/only the household owner/i);
  });

  it('refuses a removed member, and yourself', () => {
    expect(planOwnershipTransfer(asAda(), member({ user_id: BO, status: 'removed' })).error)
      .toMatch(/not in this household/);
    expect(planOwnershipTransfer(asAda(), COUPLE[0]).error).toMatch(/already the owner/);
  });
});

describe('deleting the household', () => {
  const shared = [row('joint', ADA, HH), row('bo-car', BO, HH), row('ada-private', ADA)];

  it('sends every shared row home and deletes no money at all', () => {
    const plan = planHouseholdDeletion(asAda(), HH, shared);
    expect(plan.ok).toBe(true);
    expect(plan.unshare.sort()).toEqual(['bo-car', 'joint']);
    expect(plan.deletes).toEqual([]);
  });

  it('is the owner\'s call alone', () => {
    expect(planHouseholdDeletion(asBo(), HH, shared).error).toMatch(/only the household owner/i);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What the screen is allowed to offer
// ═════════════════════════════════════════════════════════════════════════════

describe('member views', () => {
  it('offers the owner every lever except one against themselves', () => {
    const views = memberViews(asAda(), HH);
    const me = views.find(v => v.isYou)!;
    const them = views.find(v => !v.isYou)!;
    expect(me.canRemove).toBe(false);
    expect(me.canChangeRole).toBe(false);
    expect(them.canRemove).toBe(true);
    expect(them.canChangeRole).toBe(true);
    expect(them.canMakeOwner).toBe(true);
  });

  it('offers a plain member no levers at all', () => {
    for (const v of memberViews(asBo(), HH)) {
      expect(v.canRemove).toBe(false);
      expect(v.canChangeRole).toBe(false);
      expect(v.canMakeOwner).toBe(false);
    }
  });

  it('lists only the people actually in the household', () => {
    const members = [member({ user_id: ADA }), member({ user_id: BO, role: 'member', status: 'removed' })];
    expect(memberViews(asAda(members), HH).map(v => v.member.user_id)).toEqual([ADA]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Isolation — the property everything else rests on
// ═════════════════════════════════════════════════════════════════════════════

describe('isolation between users', () => {
  const rows = [row('joint', ADA, HH), row('ada-private', ADA), row('bo-private', BO), row('cy-own', CY)];

  it('shows a stranger nothing, in either scope', () => {
    expect(scopeRows(rows, asCy(), 'personal').map(r => r.id)).toEqual(['cy-own']);
    expect(scopeRows(rows, asCy(), 'household')).toEqual([]);
  });

  it('does not let a household id alone buy access', () => {
    // Cy holds a row stamped with Ada and Bo's household — which he is not in.
    // Membership is the only thing that grants access, so it buys him nothing…
    const forged = row('forged', CY, HH);
    expect(householdRows([...rows, forged], asCy())).toEqual([]);
    // …and it does not put his row into their household view either, because he
    // is not a member and their view is built from rows, checked against theirs.
    expect(householdRows([...rows, forged], asAda()).map(r => r.id)).toEqual(['joint', 'forged']);
    // (The stamp is only settable through canShare, which refuses him outright.)
    expect(canShare(row('cy-own', CY), asCy(), HH)).toBe(false);
  });

  it('keeps a departed member\'s data out of the household without deleting it', () => {
    const after = [member({ user_id: ADA }), member({ user_id: BO, role: 'member', status: 'removed' })];
    const unshared = [row('joint', ADA, HH), row('bo-car', BO)];
    expect(householdRows(unshared, asAda()).map(r => r.id)).toEqual(['joint']);
    expect(personalRows(unshared, asBo(after)).map(r => r.id)).toEqual(['bo-car']);
  });
});
