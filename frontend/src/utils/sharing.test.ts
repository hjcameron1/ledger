/**
 * Phase 7.2 — the direct-sharing engine.
 *
 * The law these all check, in two halves:
 *   SHARING CHANGES WHO CAN SEE A ROW, NEVER HOW MANY ROWS THERE ARE
 *   — AND IT NEVER CHANGES WHOSE ROW IT IS.
 *
 * So the assertions worth reading are the negative ones. A grant puts a row on
 * somebody's screen and into no total. Revoking takes it off the screen and
 * deletes nothing. Two people, three codes and an overlapping household still
 * add up to one account.
 */

import { describe, it, expect } from 'vitest';
import type {
  Household, HouseholdMember, RecordShare, ShareCode, Shareable, Transaction,
} from '../types';
import { buildContext, personalRows, householdRows } from './household';
import {
  buildSharingContext, canViewRecord, canEditRecord, canDeleteRecord,
  editRecordRefusal, visibleRecords, sharedWithMeRecords, grantFor, sharedWith,
  isDirectlyShared, sharedAccountIds, onSharedAccount, grantsIHold, grantsIGave,
  hasAnySharing, hasIncomingShares, assignmentOf, shareTargets,
  planShareCode, planRedeem, planEndGrant, cascadeOfEnding,
  codeStatus, isLiveCode, liveCodes, liveCodesFor,
  sharedByMe, sharedWithMe, sharingOverview, SHARE_CODE_TTL_DAYS,
} from './sharing';

const ADA = 'user-ada';   // owns things, shares them
const BO  = 'user-bo';    // is shared with
const CY  = 'user-cy';    // a stranger
const COUPLE_HH = 'hh-couple';
const FAMILY_HH = 'hh-family';

const NOW = '2026-08-20T00:00:00.000Z';
const LATER = '2026-09-20T00:00:00.000Z';   // past a 14-day TTL

// ── Fixtures ────────────────────────────────────────────────────────────────

const row = (o: Partial<Shareable> = {}): Shareable =>
  ({ id: 'acc-1', user_id: ADA, household_id: null, ...o });

const txn = (o: Partial<Transaction> = {}): Transaction =>
  ({ id: 'tx-1', user_id: ADA, account_id: 'acc-1', household_id: null, ...o } as Transaction);

const household = (id: string, name: string): Household =>
  ({ id, name, created_by: ADA, currency: 'AUD' });

const member = (householdId: string, userId: string, role: HouseholdMember['role'] = 'member'): HouseholdMember =>
  ({ id: `m-${householdId}-${userId}`, household_id: householdId, user_id: userId, role, status: 'active' });

const grant = (o: Partial<RecordShare> = {}): RecordShare => ({
  id: 'g-1', record_type: 'account', record_id: 'acc-1',
  owner_user_id: ADA, shared_with_user_id: BO,
  permission: 'view', status: 'active', ...o,
});

const code = (o: Partial<ShareCode> = {}): ShareCode => ({
  id: 'c-1', code: 'CODE-1', record_type: 'account', record_id: 'acc-1',
  owner_user_id: ADA, permission: 'view', max_uses: 1, uses: 0,
  status: 'active', expires_at: '2026-09-03T00:00:00.000Z', ...o,
});

/** A context for one person, with whatever households and grants a test needs. */
const ctxFor = (
  userId: string,
  o: { households?: Household[]; members?: HouseholdMember[]; shares?: RecordShare[]; codes?: ShareCode[]; active?: string } = {},
) => buildSharingContext(
  userId, o.households ?? [], o.members ?? [], o.shares ?? [], o.active ?? null, o.codes ?? [],
);

const labels = () => (_t: string, _id: string) => null;

// ═════════════════════════════════════════════════════════════════════════════
//  Sharing one account directly with one person
// ═════════════════════════════════════════════════════════════════════════════

describe('sharing an account with another Ledger user', () => {
  const account = row({ id: 'acc-1', user_id: ADA });
  const shares = [grant()];

  it("puts it on the recipient's screen", () => {
    const bo = ctxFor(BO, { shares });
    expect(canViewRecord('account', account, bo)).toBe(true);
    expect(visibleRecords('account', [account], bo)).toHaveLength(1);
  });

  it('is the SAME row, not a copy — one id, one balance', () => {
    const ada = ctxFor(ADA, { shares });
    const bo = ctxFor(BO, { shares });
    const adaSees = visibleRecords('account', [account], ada);
    const boSees = visibleRecords('account', [account], bo);
    expect(adaSees).toHaveLength(1);
    expect(boSees).toHaveLength(1);
    expect(adaSees[0].id).toBe(boSees[0].id);
    // The row itself is untouched by having been shared.
    expect(adaSees[0]).toBe(account);
    expect(boSees[0]).toBe(account);
  });

  it('leaves the owner as the owner — sharing is not giving', () => {
    const bo = ctxFor(BO, { shares });
    expect(account.user_id).toBe(ADA);
    expect(canDeleteRecord(account, bo)).toBe(false);
  });

  it("does NOT put it in the recipient's own rows, which is what totals read", () => {
    const bo = ctxFor(BO, { shares });
    expect(personalRows([account], bo)).toEqual([]);
    // …and it is in the owner's, exactly as it was before it was shared.
    expect(personalRows([account], ctxFor(ADA, { shares }))).toHaveLength(1);
  });

  it('shows in "shared with you" for the recipient and never for the owner', () => {
    expect(sharedWithMeRecords('account', [account], ctxFor(BO, { shares }))).toHaveLength(1);
    expect(sharedWithMeRecords('account', [account], ctxFor(ADA, { shares }))).toEqual([]);
  });

  it('is invisible to everybody else', () => {
    const cy = ctxFor(CY, { shares });
    expect(canViewRecord('account', account, cy)).toBe(false);
    expect(visibleRecords('account', [account], cy)).toEqual([]);
    expect(grantsIHold(cy)).toEqual([]);
  });

  it('an ended grant grants nothing', () => {
    for (const status of ['revoked', 'left'] as const) {
      const bo = ctxFor(BO, { shares: [grant({ status })] });
      expect(canViewRecord('account', account, bo)).toBe(false);
      expect(grantsIHold(bo)).toEqual([]);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  An account brings its transactions
// ═════════════════════════════════════════════════════════════════════════════

describe('the transactions on a shared account', () => {
  const shares = [grant()];
  const onIt = txn({ id: 'tx-1', account_id: 'acc-1' });
  const elsewhere = txn({ id: 'tx-2', account_id: 'acc-other' });

  it('come with it — an account without them is a number with no explanation', () => {
    const bo = ctxFor(BO, { shares });
    expect(canViewRecord('transaction', onIt, bo)).toBe(true);
    expect(onSharedAccount(onIt, bo)).toBe(true);
    expect(sharedAccountIds(bo).has('acc-1')).toBe(true);
  });

  it('does not drag in transactions on accounts that were not shared', () => {
    const bo = ctxFor(BO, { shares });
    expect(canViewRecord('transaction', elsewhere, bo)).toBe(false);
    expect(visibleRecords('transaction', [onIt, elsewhere], bo)).toEqual([onIt]);
  });

  it('never becomes the recipient\'s own spending', () => {
    const bo = ctxFor(BO, { shares });
    expect(personalRows([onIt], bo)).toEqual([]);
    expect(onIt.user_id).toBe(ADA);
  });

  it('inherits the account\'s permission rather than having one of its own', () => {
    const viewer = ctxFor(BO, { shares: [grant({ permission: 'view' })] });
    const editor = ctxFor(BO, { shares: [grant({ permission: 'edit' })] });
    expect(canEditRecord('transaction', onIt, viewer)).toBe(false);
    expect(canEditRecord('transaction', onIt, editor)).toBe(true);
  });

  it('is listed by the cascade an ending would take with it — and deletes nothing', () => {
    const cascade = cascadeOfEnding(grant(), [onIt, elsewhere]);
    expect(cascade.transactions).toEqual(['tx-1']);
    expect(cascade.deletes).toEqual([]);
  });

  it('a grant on a goal cascades to nothing at all', () => {
    const cascade = cascadeOfEnding(grant({ record_type: 'goal', record_id: 'goal-1' }), [onIt]);
    expect(cascade.transactions).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Permissions
// ═════════════════════════════════════════════════════════════════════════════

describe('what a grant lets somebody do', () => {
  const account = row();

  it('view means look and nothing else', () => {
    const bo = ctxFor(BO, { shares: [grant({ permission: 'view' })] });
    expect(canViewRecord('account', account, bo)).toBe(true);
    expect(canEditRecord('account', account, bo)).toBe(false);
    expect(editRecordRefusal('account', account, bo))
      .toBe('This was shared with you to look at, not to change.');
  });

  it('edit means correct it — never delete it', () => {
    const bo = ctxFor(BO, { shares: [grant({ permission: 'edit' })] });
    expect(canEditRecord('account', account, bo)).toBe(true);
    expect(canDeleteRecord(account, bo)).toBe(false);
  });

  it('deleting stays with the owner, both kinds of sharing, always', () => {
    const shared = row({ household_id: COUPLE_HH });
    const bo = ctxFor(BO, {
      households: [household(COUPLE_HH, 'Ada & Bo')],
      members: [member(COUPLE_HH, ADA, 'owner'), member(COUPLE_HH, BO, 'member')],
      shares: [grant({ permission: 'edit' })],
    });
    expect(canEditRecord('account', shared, bo)).toBe(true);
    expect(canDeleteRecord(shared, bo)).toBe(false);
    expect(canDeleteRecord(shared, ctxFor(ADA))).toBe(true);
  });

  it('only the owner can hand out sight of a row', () => {
    // Bo can EDIT the joint account as a household member, and still cannot
    // publish it: editing somebody's account and showing it to a stranger are
    // not the same permission.
    const joint = row({ user_id: ADA, household_id: COUPLE_HH });
    const bo = ctxFor(BO, {
      households: [household(COUPLE_HH, 'Ada & Bo')],
      members: [member(COUPLE_HH, ADA, 'owner'), member(COUPLE_HH, BO, 'member')],
    });
    expect(canEditRecord('account', joint, bo)).toBe(true);
    const plan = planShareCode('account', joint, bo, NOW);
    expect(plan.ok).toBe(false);
    expect(plan.error).toBe('Only the person this belongs to can share it.');
  });

  it('the owner can, and gets a single-use code with an expiry', () => {
    const plan = planShareCode('account', row(), ctxFor(ADA), NOW, 'edit');
    expect(plan.ok).toBe(true);
    expect(plan.code!.max_uses).toBe(1);
    expect(plan.code!.permission).toBe('edit');
    expect(plan.code!.owner_user_id).toBe(ADA);
    expect(new Date(plan.code!.expires_at).getTime() - new Date(NOW).getTime())
      .toBe(SHARE_CODE_TTL_DAYS * 86_400_000);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Codes, and the fact that a code grants nothing
// ═════════════════════════════════════════════════════════════════════════════

describe('redeeming a code', () => {
  it('mints a grant carrying the code\'s permission', () => {
    const plan = planRedeem(code({ permission: 'edit' }), { id: BO }, [], NOW);
    expect(plan.ok).toBe(true);
    expect(plan.grant).toMatchObject({
      record_type: 'account', record_id: 'acc-1',
      owner_user_id: ADA, shared_with_user_id: BO,
      permission: 'edit', status: 'active',
    });
  });

  it('refuses your own code — you already own the thing', () => {
    const plan = planRedeem(code(), { id: ADA }, [], NOW);
    expect(plan.ok).toBe(false);
    expect(plan.error).toContain('your own share code');
  });

  it('refuses an expired one, reading the clock rather than the column', () => {
    const stale = code({ status: 'active', expires_at: '2026-08-19T00:00:00.000Z' });
    expect(codeStatus(stale, NOW)).toBe('expired');
    expect(isLiveCode(stale, NOW)).toBe(false);
    expect(planRedeem(stale, { id: BO }, [], NOW).error).toContain('expired');
  });

  it('refuses a spent one and a withdrawn one', () => {
    expect(planRedeem(code({ uses: 1 }), { id: BO }, [], NOW).error).toContain('already been used');
    expect(planRedeem(code({ status: 'revoked' }), { id: BO }, [], NOW).error).toContain('withdrawn');
  });

  it('is idempotent: a second code for the same row adds no second grant', () => {
    const existing = [grant()];
    const plan = planRedeem(code({ id: 'c-2', code: 'CODE-2' }), { id: BO }, existing, NOW);
    expect(plan.ok).toBe(false);
    expect(plan.already).toBe(true);
    expect(plan.grant).toBeUndefined();
  });

  it('an ended grant does not block a fresh one — sharing again is allowed', () => {
    const plan = planRedeem(code(), { id: BO }, [grant({ status: 'revoked' })], NOW);
    expect(plan.ok).toBe(true);
  });

  it('lists live codes per row, and drops the expired ones', () => {
    const ada = ctxFor(ADA, {
      codes: [
        code({ id: 'c-1' }),
        code({ id: 'c-2', record_id: 'acc-2' }),
        code({ id: 'c-3', expires_at: '2026-08-01T00:00:00.000Z' }),
      ],
    });
    expect(liveCodes(ada, NOW).map(c => c.id)).toEqual(['c-1', 'c-2']);
    expect(liveCodesFor(ada, 'account', 'acc-1', NOW).map(c => c.id)).toEqual(['c-1']);
    expect(liveCodes(ada, LATER)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Ending access, from either side
// ═════════════════════════════════════════════════════════════════════════════

describe('ending a grant', () => {
  it('the owner revokes', () => {
    const plan = planEndGrant(grant(), ctxFor(ADA), NOW);
    expect(plan.ok).toBe(true);
    expect(plan.patch).toEqual({ status: 'revoked', ended_at: NOW });
  });

  it('the recipient leaves', () => {
    const plan = planEndGrant(grant(), ctxFor(BO), NOW);
    expect(plan.ok).toBe(true);
    expect(plan.patch).toEqual({ status: 'left', ended_at: NOW });
  });

  it('either way, NOTHING is deleted', () => {
    expect(planEndGrant(grant(), ctxFor(ADA), NOW).deletes).toEqual([]);
    expect(planEndGrant(grant(), ctxFor(BO), NOW).deletes).toEqual([]);
  });

  it('a bystander cannot end it', () => {
    const plan = planEndGrant(grant(), ctxFor(CY), NOW);
    expect(plan.ok).toBe(false);
    expect(plan.error).toBe("That isn't yours to end.");
  });

  it('an already-ended grant cannot be ended twice', () => {
    expect(planEndGrant(grant({ status: 'revoked' }), ctxFor(ADA), NOW).ok).toBe(false);
  });

  it('takes the access and leaves the account exactly where it was', () => {
    const account = row();
    const after = ctxFor(BO, { shares: [grant({ status: 'revoked' })] });
    expect(canViewRecord('account', account, after)).toBe(false);
    expect(account.user_id).toBe(ADA);
    expect(personalRows([account], ctxFor(ADA))).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Several households, and overlapping membership
// ═════════════════════════════════════════════════════════════════════════════

describe('belonging to more than one household', () => {
  const houses = [household(COUPLE_HH, 'Ada & Bo'), household(FAMILY_HH, 'The Camerons')];
  const members = [
    member(COUPLE_HH, ADA, 'owner'), member(COUPLE_HH, BO, 'member'),
    member(FAMILY_HH, ADA, 'member'), member(FAMILY_HH, CY, 'owner'),
  ];

  const jointAccount  = row({ id: 'acc-joint',  user_id: ADA, household_id: COUPLE_HH });
  const familyAccount = row({ id: 'acc-family', user_id: CY,  household_id: FAMILY_HH });
  const privateAccount = row({ id: 'acc-priv',  user_id: ADA, household_id: null });
  const all = [jointAccount, familyAccount, privateAccount];

  it('each household shows only its own shared rows', () => {
    const ada = buildContext(ADA, houses, members, COUPLE_HH);
    expect(householdRows(all, ada, COUPLE_HH).map(r => r.id)).toEqual(['acc-joint']);
    expect(householdRows(all, ada, FAMILY_HH).map(r => r.id)).toEqual(['acc-family']);
  });

  it('a row is in ONE household at a time, so no row is ever counted twice', () => {
    const ada = buildContext(ADA, houses, members, COUPLE_HH);
    const couple = householdRows(all, ada, COUPLE_HH);
    const family = householdRows(all, ada, FAMILY_HH);
    const ids = [...couple, ...family].map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('the overlapping member sees both, and neither leaks into the other', () => {
    const ada = ctxFor(ADA, { households: houses, members, active: COUPLE_HH });
    expect(canViewRecord('account', jointAccount, ada)).toBe(true);
    expect(canViewRecord('account', familyAccount, ada)).toBe(true);
    // Bo is only in the couple, so the family's account is not theirs to see.
    const bo = ctxFor(BO, { households: houses, members });
    expect(canViewRecord('account', familyAccount, bo)).toBe(false);
    // Cy is only in the family, so the couple's is not theirs to see.
    const cy = ctxFor(CY, { households: houses, members });
    expect(canViewRecord('account', jointAccount, cy)).toBe(false);
  });

  it("a private account is in neither household's view, for anybody", () => {
    const ada = buildContext(ADA, houses, members, COUPLE_HH);
    expect(householdRows(all, ada, COUPLE_HH).map(r => r.id)).not.toContain('acc-priv');
    expect(householdRows(all, ada, FAMILY_HH).map(r => r.id)).not.toContain('acc-priv');
    const bo = ctxFor(BO, { households: houses, members });
    expect(canViewRecord('account', privateAccount, bo)).toBe(false);
  });

  it('offers the households a row could be moved into, minus the one it is in', () => {
    const ada = ctxFor(ADA, { households: houses, members, active: COUPLE_HH });
    expect(shareTargets(ada, jointAccount).map(h => h.id)).toEqual([FAMILY_HH]);
    expect(shareTargets(ada, privateAccount).map(h => h.id)).toEqual([COUPLE_HH, FAMILY_HH]);
  });

  it('does not offer a household where the user is only a viewer', () => {
    const viewerMembers = [member(COUPLE_HH, ADA, 'viewer'), member(FAMILY_HH, ADA, 'member')];
    const ada = ctxFor(ADA, { households: houses, members: viewerMembers });
    expect(shareTargets(ada, privateAccount).map(h => h.id)).toEqual([FAMILY_HH]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Where a row is assigned
// ═════════════════════════════════════════════════════════════════════════════

describe('assignment', () => {
  const houses = [household(COUPLE_HH, 'Ada & Bo')];
  const members = [member(COUPLE_HH, ADA, 'owner'), member(COUPLE_HH, BO, 'member')];

  it('reads personal when nothing has been done to it', () => {
    const a = assignmentOf('account', row(), ctxFor(ADA, { households: houses, members }));
    expect(a).toMatchObject({ scope: 'personal', householdId: null, directCount: 0, mine: true });
  });

  it('reads the household it is in, by name', () => {
    const a = assignmentOf('account', row({ household_id: COUPLE_HH }),
      ctxFor(ADA, { households: houses, members }));
    expect(a).toMatchObject({ scope: 'household', householdId: COUPLE_HH, householdName: 'Ada & Bo' });
  });

  it('counts direct grants SEPARATELY from the household stamp', () => {
    // A row can be personal and still shown to one named person: the two grants
    // are orthogonal, and conflating them would make "personal" a lie.
    const ada = ctxFor(ADA, { shares: [grant(), grant({ id: 'g-2', shared_with_user_id: CY })] });
    const a = assignmentOf('account', row(), ada);
    expect(a.scope).toBe('personal');
    expect(a.directCount).toBe(2);
    expect(isDirectlyShared(ada, 'account', 'acc-1')).toBe(true);
    expect(sharedWith(ada, 'account', 'acc-1')).toHaveLength(2);
  });

  it("says it isn't yours when it isn't", () => {
    const bo = ctxFor(BO, { shares: [grant()] });
    expect(assignmentOf('account', row(), bo).mine).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Summaries
// ═════════════════════════════════════════════════════════════════════════════

describe('the sharing screen', () => {
  const shares = [
    grant({ id: 'g-1', record_id: 'acc-1', shared_with_user_id: BO, shared_with_name: 'Bo' }),
    grant({ id: 'g-2', record_id: 'acc-1', shared_with_user_id: CY, shared_with_email: 'cy@example.com' }),
    grant({ id: 'g-3', record_id: 'goal-1', record_type: 'goal', shared_with_user_id: BO, shared_with_name: 'Bo' }),
  ];
  const ada = ctxFor(ADA, { shares, codes: [code({ id: 'c-9', record_id: 'acc-2' })] });

  it('lists one entry per ROW, not one per person', () => {
    const given = sharedByMe(ada, labels(), NOW);
    const account = given.find(v => v.recordId === 'acc-1')!;
    expect(account.people.map(p => p.name)).toEqual(['Bo', 'cy@example.com']);
    expect(given.filter(v => v.recordId === 'acc-1')).toHaveLength(1);
  });

  it('includes a link nobody has used yet — it is still something you shared', () => {
    const given = sharedByMe(ada, labels(), NOW);
    const pending = given.find(v => v.recordId === 'acc-2')!;
    expect(pending.pendingCodes.map(c => c.id)).toEqual(['c-9']);
    expect(pending.people).toEqual([]);
  });

  it('names who shared each incoming row', () => {
    const bo = ctxFor(BO, {
      shares: [grant({ owner_name: 'Ada', record_label: 'Everyday offset' })],
    });
    const held = sharedWithMe(bo, labels());
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ from: 'Ada', label: 'Everyday offset', permission: 'view' });
  });

  it('counts rows and people rather than grants', () => {
    const totals = sharingOverview(ada, NOW);
    expect(totals.recordsIShare).toBe(2);      // acc-1 and goal-1
    expect(totals.peopleISharewith).toBe(2);   // Bo and Cy
    expect(totals.pendingCodes).toBe(1);
    expect(totals.recordsSharedWithMe).toBe(0);
  });

  it('knows when a user has no sharing at all — what hides the UI', () => {
    expect(hasAnySharing(ctxFor(ADA))).toBe(false);
    expect(hasIncomingShares(ctxFor(ADA))).toBe(false);
    expect(hasAnySharing(ada)).toBe(true);
    expect(hasAnySharing(ctxFor(BO, { shares: [grant()] }))).toBe(true);
    expect(hasAnySharing(ctxFor(ADA, {
      households: [household(COUPLE_HH, 'Ada & Bo')], members: [member(COUPLE_HH, ADA, 'owner')],
    }))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Duplicate prevention
// ═════════════════════════════════════════════════════════════════════════════

describe('one row stays one row', () => {
  it('a row reachable BOTH ways appears exactly once', () => {
    // Shared with the household Bo is in, AND granted to Bo directly. Two
    // reasons to see it; still one account.
    const account = row({ household_id: COUPLE_HH });
    const bo = ctxFor(BO, {
      households: [household(COUPLE_HH, 'Ada & Bo')],
      members: [member(COUPLE_HH, ADA, 'owner'), member(COUPLE_HH, BO, 'member')],
      shares: [grant()],
    });
    expect(visibleRecords('account', [account], bo)).toHaveLength(1);
    expect(grantFor(bo, 'account', 'acc-1')).not.toBeNull();
  });

  it('the same row arriving twice in the list is still counted once', () => {
    const account = row();
    const bo = ctxFor(BO, { shares: [grant()] });
    expect(visibleRecords('account', [account, { ...account }], bo)).toHaveLength(1);
    expect(sharedWithMeRecords('account', [account, { ...account }], bo)).toHaveLength(1);
  });

  it('two grants from two people on two rows are two rows, not four', () => {
    const a = row({ id: 'acc-1', user_id: ADA });
    const b = row({ id: 'acc-2', user_id: CY });
    const bo = ctxFor(BO, {
      shares: [
        grant({ id: 'g-1', record_id: 'acc-1', owner_user_id: ADA }),
        grant({ id: 'g-2', record_id: 'acc-2', owner_user_id: CY }),
      ],
    });
    expect(visibleRecords('account', [a, b], bo)).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Everything else that can be shared
// ═════════════════════════════════════════════════════════════════════════════

describe('goals, budgets, loans and properties share the same way', () => {
  const kinds = ['goal', 'budget', 'loan', 'property', 'card'] as const;

  it.each(kinds)('a %s can be granted, seen, and never owned by the recipient', kind => {
    const record = row({ id: `${kind}-1`, user_id: ADA });
    const shares = [grant({ record_type: kind, record_id: `${kind}-1` })];
    const bo = ctxFor(BO, { shares });

    expect(canViewRecord(kind, record, bo)).toBe(true);
    expect(personalRows([record], bo)).toEqual([]);
    expect(canDeleteRecord(record, bo)).toBe(false);
    expect(sharedWithMeRecords(kind, [record], bo)).toHaveLength(1);
  });

  it.each(kinds)('a grant on a %s is not a grant on anything else', kind => {
    const other = row({ id: 'acc-1' });
    const bo = ctxFor(BO, { shares: [grant({ record_type: kind, record_id: `${kind}-1` })] });
    expect(canViewRecord('account', other, bo)).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('one user never sees another user\'s anything', () => {
  it('without a grant, a household, or ownership, there is no fourth way in', () => {
    const account = row({ user_id: ADA });
    const cy = ctxFor(CY, {
      // Cy is in a household — just not one this account is shared with.
      households: [household(FAMILY_HH, 'The Camerons')],
      members: [member(FAMILY_HH, CY, 'owner')],
      // …and holds a grant — just not on this account.
      shares: [grant({ id: 'g-x', record_id: 'acc-999', shared_with_user_id: CY })],
    });
    expect(canViewRecord('account', account, cy)).toBe(false);
    expect(canEditRecord('account', account, cy)).toBe(false);
    expect(canDeleteRecord(account, cy)).toBe(false);
    expect(visibleRecords('account', [account], cy)).toEqual([]);
  });

  it("a grant addressed to somebody else does nothing for you", () => {
    const cy = ctxFor(CY, { shares: [grant({ shared_with_user_id: BO })] });
    expect(canViewRecord('account', row(), cy)).toBe(false);
    expect(grantsIHold(cy)).toEqual([]);
    expect(grantsIGave(cy)).toEqual([]);
  });

  it('a signed-out session owns nothing and is shown nothing', () => {
    const nobody = ctxFor(null as unknown as string, { shares: [grant()] });
    expect(sharedWithMeRecords('account', [row()], nobody)).toEqual([]);
    expect(grantsIHold(nobody)).toEqual([]);
  });
});
