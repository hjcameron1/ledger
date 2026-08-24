/**
 * Phase 8.2 — the decisions behind insurance, tested without a database.
 *
 * Two things are proved here, and they are the two things that would matter if
 * they were wrong:
 *
 *   1. WHO SEES A POLICY. It follows the thing it covers — so a shared house
 *      brings its cover with it, and un-sharing takes it straight back.
 *   2. WHAT A WRITE MAY SAY. The field gate is the only way a column is ever
 *      set, so anything it drops can never be written by any route.
 */

import { describe, it, expect } from 'vitest';
import type { HouseholdScope, ShareRecordType, SharePermission, HouseholdRole } from './householdScope';
import {
  pickPolicyFields, pickHistoryFields, policyVisibilityFilter, canSeePolicy,
  linkTargetRefusal, documentRefusal, POLICY_TYPES, PREMIUM_FREQUENCIES, LINKABLE_TYPES,
} from './insurancePolicies';

const ALICE = 'alice-id';
const BOB = 'bob-id';
const HOUSE = 'household-1';

function scope(opts: {
  userId?: string;
  households?: [string, HouseholdRole][];
  granted?: [ShareRecordType, string, SharePermission][];
  householdRecords?: [ShareRecordType, string[]][];
} = {}): HouseholdScope {
  return {
    userId: opts.userId ?? ALICE,
    roles: new Map(opts.households ?? []),
    grants: new Map((opts.granted ?? []).map(([type, id, perm]) =>
      [type, new Map([[id, perm]])] as [ShareRecordType, Map<string, SharePermission>])),
    householdRecords: new Map((opts.householdRecords ?? []).map(([type, ids]) =>
      [type, new Set(ids)] as [ShareRecordType, Set<string>])),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Who sees a policy
// ═════════════════════════════════════════════════════════════════════════════
describe('visibility', () => {
  it('a user with no sharing gets no `or` at all — the plain path is untouched', () => {
    expect(policyVisibilityFilter(scope())).toBeNull();
  });

  it('sees their own policies, always', () => {
    expect(canSeePolicy({ user_id: ALICE }, scope())).toBe(true);
    expect(canSeePolicy({ user_id: ALICE, linked_type: 'property', linked_id: 'p1' }, scope())).toBe(true);
  });

  it('cannot see a stranger\'s unlinked policy', () => {
    expect(canSeePolicy({ user_id: BOB }, scope())).toBe(false);
  });

  it('sees a policy linked to a household they are in', () => {
    const s = scope({ households: [[HOUSE, 'member']] });
    expect(canSeePolicy({ user_id: BOB, linked_type: 'household', linked_id: HOUSE }, s)).toBe(true);
    expect(canSeePolicy({ user_id: BOB, linked_type: 'household', linked_id: 'other' }, s)).toBe(false);
    expect(policyVisibilityFilter(s))
      .toBe(`user_id.eq.${ALICE},and(linked_type.eq.household,linked_id.in.(${HOUSE}))`);
  });

  it('sees the cover on a property shared into their household', () => {
    const s = scope({
      households: [[HOUSE, 'member']],
      householdRecords: [['property', ['prop-1']]],
    });
    expect(canSeePolicy({ user_id: BOB, linked_type: 'property', linked_id: 'prop-1' }, s)).toBe(true);
    expect(canSeePolicy({ user_id: BOB, linked_type: 'property', linked_id: 'prop-2' }, s)).toBe(false);
    expect(policyVisibilityFilter(s)).toContain('and(linked_type.eq.property,linked_id.in.(prop-1))');
  });

  it('sees the cover on a record granted to them directly', () => {
    const s = scope({ granted: [['investment', 'inv-1', 'view']] });
    expect(canSeePolicy({ user_id: BOB, linked_type: 'investment', linked_id: 'inv-1' }, s)).toBe(true);
  });

  it('un-sharing the house takes its insurance back in the same instant', () => {
    const policy = { user_id: BOB, linked_type: 'property', linked_id: 'prop-1' };
    const shared = scope({ households: [[HOUSE, 'member']], householdRecords: [['property', ['prop-1']]] });
    const afterUnshare = scope({ households: [[HOUSE, 'member']] });
    expect(canSeePolicy(policy, shared)).toBe(true);
    // Nothing was written to the policy — the SCOPE changed, and that is all it
    // takes. This is the whole reason visibility is derived rather than stamped.
    expect(canSeePolicy(policy, afterUnshare)).toBe(false);
  });

  it('record kinds do not cross: a shared account does not reveal property cover', () => {
    const s = scope({ households: [[HOUSE, 'member']], householdRecords: [['account', ['x1']]] });
    expect(canSeePolicy({ user_id: BOB, linked_type: 'property', linked_id: 'x1' }, s)).toBe(false);
    expect(canSeePolicy({ user_id: BOB, linked_type: 'account', linked_id: 'x1' }, s)).toBe(true);
  });

  it('lists every visible record kind in one filter', () => {
    const s = scope({
      households: [[HOUSE, 'admin']],
      householdRecords: [['property', ['p1']], ['loan', ['l1']]],
      granted: [['account', 'a1', 'view']],
    });
    const filter = policyVisibilityFilter(s)!;
    expect(filter).toContain(`user_id.eq.${ALICE}`);
    expect(filter).toContain('and(linked_type.eq.account,linked_id.in.(a1))');
    expect(filter).toContain('and(linked_type.eq.property,linked_id.in.(p1))');
    expect(filter).toContain('and(linked_type.eq.loan,linked_id.in.(l1))');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What may be covered
// ═════════════════════════════════════════════════════════════════════════════
describe('link validation', () => {
  it('lets a user cover their own record', () => {
    expect(linkTargetRefusal('property', 'p1', ALICE, scope())).toBeNull();
  });

  it('lets a user cover a record shared with them', () => {
    const s = scope({ households: [[HOUSE, 'member']], householdRecords: [['property', ['p1']]] });
    expect(linkTargetRefusal('property', 'p1', BOB, s)).toBeNull();
  });

  it('answers 404 — never 403 — for a record they cannot see', () => {
    // 403 would confirm the id exists, turning the endpoint into an oracle for
    // guessing other people's record ids.
    expect(linkTargetRefusal('property', 'p1', BOB, scope())).toEqual({
      status: 404, error: 'That record was not found.',
    });
    expect(linkTargetRefusal('property', 'missing', null, scope())).toEqual({
      status: 404, error: 'That record was not found.',
    });
  });

  it('refuses a household the user is not in', () => {
    expect(linkTargetRefusal('household', HOUSE, null, scope())?.status).toBe(403);
    expect(linkTargetRefusal('household', HOUSE, null, scope({ households: [[HOUSE, 'viewer']] }))).toBeNull();
  });
});

describe('attaching a policy document', () => {
  it('accepts the caller\'s own document', () => {
    expect(documentRefusal(ALICE, scope())).toBeNull();
  });

  it('refuses somebody else\'s — even one legitimately shared with them', () => {
    // Stricter than the link rule on purpose: a policy carries its document to
    // everyone who can see the policy, so attaching another person's file would
    // republish their paperwork to an audience they never chose.
    expect(documentRefusal(BOB, scope({ households: [[HOUSE, 'owner']] }))).toEqual({
      status: 403, error: 'You can only attach your own documents to a policy.',
    });
  });

  it('refuses a document that does not exist', () => {
    expect(documentRefusal(null, scope())?.status).toBe(404);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What a write may say
// ═════════════════════════════════════════════════════════════════════════════
describe('the field gate', () => {
  it('drops every column the server owns', () => {
    const { fields } = pickPolicyFields({
      name: 'House', id: 'forged', user_id: BOB,
      created_at: '2000-01-01', updated_at: '2000-01-01', household_ids: [HOUSE],
    });
    expect(fields).toEqual({ name: 'House' });
  });

  it('needs a name that is actually a name', () => {
    expect(pickPolicyFields({ name: '   ' }).refusal).toEqual({ error: 'A policy needs a name.' });
    expect(pickPolicyFields({ name: 'House' }).refusal).toBeNull();
  });

  it('accepts every policy type it publishes, and nothing else', () => {
    for (const type of POLICY_TYPES) {
      expect(pickPolicyFields({ policy_type: type }).refusal).toBeNull();
    }
    expect(pickPolicyFields({ policy_type: 'spaceship' }).refusal)
      .toEqual({ error: "Unknown policy type 'spaceship'." });
  });

  it('accepts every billing cadence it publishes, and nothing else', () => {
    for (const f of PREMIUM_FREQUENCIES) {
      expect(pickPolicyFields({ premium_frequency: f }).refusal).toBeNull();
    }
    // `once` is a cadence the forecast engine knows and a premium never has.
    expect(pickPolicyFields({ premium_frequency: 'once' }).refusal)
      .toEqual({ error: "Unknown premium frequency 'once'." });
  });

  it('coerces empty strings to null rather than letting Postgres reject them', () => {
    // Multipart and HTML forms send ''; '' in a DATE column is the ""→22P02
    // failure this codebase has met before.
    const { fields } = pickPolicyFields({
      renewal_date: '', start_date: '', insurer: '', excess: '', coverage_amount: '', document_id: '',
    });
    expect(fields).toEqual({
      renewal_date: null, start_date: null, insurer: null,
      excess: null, coverage_amount: null, document_id: null,
    });
  });

  it('insists a date is a date', () => {
    expect(pickPolicyFields({ renewal_date: 'next tuesday' }).refusal)
      .toEqual({ error: 'renewal date must be YYYY-MM-DD.' });
    expect(pickPolicyFields({ renewal_date: '2026-12-01' }).refusal).toBeNull();
  });

  it('insists money is a number, and not a negative one', () => {
    expect(pickPolicyFields({ premium_amount: 'lots' }).refusal)
      .toEqual({ error: 'The premium must be a number.' });
    expect(pickPolicyFields({ premium_amount: -5 }).refusal)
      .toEqual({ error: 'A premium cannot be negative.' });
    expect(pickPolicyFields({ excess: -1 }).refusal?.error).toContain('cannot be negative');
    expect(pickPolicyFields({ premium_amount: '1200.50' }).fields.premium_amount).toBe(1200.5);
  });

  it('takes a link as both halves or neither', () => {
    expect(pickPolicyFields({ linked_type: 'property' }).refusal)
      .toEqual({ error: 'A link needs both linked_type and linked_id (or neither).' });
    expect(pickPolicyFields({ linked_id: 'p1' }).refusal?.error).toContain('both');
    expect(pickPolicyFields({ linked_type: '', linked_id: '' }).fields)
      .toEqual({ linked_type: null, linked_id: null });
    for (const type of LINKABLE_TYPES) {
      expect(pickPolicyFields({ linked_type: type, linked_id: 'x' }).refusal).toBeNull();
    }
  });

  it('refuses a link kind insurance does not have', () => {
    // The vault's `tax_year` is the interesting one: a policy is a live contract,
    // not a year's paperwork, and letting it through would create a link kind
    // with no visibility rule of its own.
    expect(pickPolicyFields({ linked_type: 'tax_year', linked_id: '2025-2026' }).refusal)
      .toEqual({ error: "A policy cannot be linked to 'tax_year'." });
  });

  it('reads `active` as a decision, including the string a form sends', () => {
    expect(pickPolicyFields({ active: false }).fields.active).toBe(false);
    expect(pickPolicyFields({ active: 'false' }).fields.active).toBe(false);
    expect(pickPolicyFields({ active: true }).fields.active).toBe(true);
    // Absent means "don't touch it", not "make it false".
    expect('active' in pickPolicyFields({}).fields).toBe(false);
  });
});

describe('a premium record', () => {
  it('needs a policy, an amount and a date', () => {
    expect(pickHistoryFields({}).refusal).toEqual({ error: 'A premium record needs a policy.' });
    expect(pickHistoryFields({ policy_id: 'p1' }).refusal?.error).toContain('non-negative amount');
    expect(pickHistoryFields({ policy_id: 'p1', premium_amount: 100 }).refusal?.error)
      .toContain('effective_date');
  });

  it('takes a complete record whole', () => {
    const { fields, refusal } = pickHistoryFields({
      policy_id: 'p1', premium_amount: '1200.00', premium_frequency: 'annually',
      effective_date: '2026-08-01', note: 'Renewal', user_id: BOB,
    });
    expect(refusal).toBeNull();
    expect(fields).toEqual({
      policy_id: 'p1', premium_amount: 1200, premium_frequency: 'annually',
      effective_date: '2026-08-01', note: 'Renewal',
    });
    // `user_id` is the server's to set, here as everywhere.
    expect(fields && 'user_id' in fields).toBe(false);
  });

  it('refuses a cadence it does not recognise', () => {
    expect(pickHistoryFields({
      policy_id: 'p1', premium_amount: 10, premium_frequency: 'daily', effective_date: '2026-01-01',
    }).refusal?.error).toContain('Unknown premium frequency');
  });
});
