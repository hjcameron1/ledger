/**
 * The document vault, end to end through the data service.
 *
 * The pure engine (utils/documents.test.ts) proves the decisions. These prove
 * the wiring — and, more to the point, the things a user asked to be sure of:
 *
 *   • MY FINANCES vs a household: My Finances holds the documents you OWN,
 *     shared or not; a household view holds the documents in THAT household,
 *     from every member;
 *   • two households never leak into each other, however many of them the
 *     reader and the owner share;
 *   • an explicit share puts ONE document row into one or several households —
 *     never a copy, never twice in the same one;
 *   • un-sharing takes it back, and takes it back only from the household named;
 *   • a document filed against a shared record belongs to that record's
 *     household for exactly as long as the record does;
 *   • a record can find its own paperwork, from either end of the link;
 *   • one user never sees another's anything.
 *
 * The server is mocked at the API boundary: what is being proven here is what
 * this client does with what it is sent, and what it sends back.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { LedgerDocument, Household, HouseholdMember } from '../types';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size; },
  };
});

vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

import { useStore } from '../store';
import { documentsDS } from './dataService';
import { documentsApi } from './api';

const ADA = 'user-ada';
const BO  = 'user-bo';
const HH  = 'hh-1';
const HH2 = 'hh-2';

const doc = (o: Partial<LedgerDocument> = {}): LedgerDocument => ({
  id: 'doc-1', user_id: ADA, name: 'July statement.pdf',
  original_filename: 'July statement.pdf', mime_type: 'application/pdf',
  size_bytes: 90_000, document_type: 'statement', document_date: '2026-07-31',
  provider: 'CommBank', notes: null, linked_type: null, linked_id: null,
  household_ids: [], shared_household_ids: [], ...o,
});

const household = (id: string, name: string): Household =>
  ({ id, name, created_by: ADA, currency: 'AUD' });
const member = (householdId: string, userId: string, role: HouseholdMember['role'] = 'member'): HouseholdMember =>
  ({ id: `m-${householdId}-${userId}`, household_id: householdId, user_id: userId, role, status: 'active' });

interface Seed {
  as?: string;
  households?: Household[];
  members?: HouseholdMember[];
  scope?: 'personal' | 'household';
  active?: string | null;
}

function seed(o: Seed = {}) {
  useStore.setState({
    user: { id: o.as ?? ADA, email: 'ada@example.com', currency_preference: 'AUD' } as any,
    households: o.households ?? [],
    householdMembers: o.members ?? [],
    financeScope: o.scope ?? 'personal',
    activeHouseholdId: o.active ?? null,
  } as any);
}

/** Ada, in both households — the shape a leak would show up in. */
const inBothHouseholds = (o: Seed = {}) => seed({
  households: [household(HH, 'Ada & Bo'), household(HH2, 'The farm')],
  members: [
    member(HH, ADA, 'owner'), member(HH, BO),
    member(HH2, ADA, 'owner'),
  ],
  ...o,
});

/** Put a vault in front of the client, as the server would send it. */
async function vault(docs: LedgerDocument[]) {
  vi.spyOn(documentsApi, 'getAll').mockResolvedValue(docs);
  vi.spyOn(documentsApi, 'facts').mockResolvedValue([]);
  await documentsDS.refresh();
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  documentsDS.reset();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  My Finances versus a household
// ═════════════════════════════════════════════════════════════════════════════

describe('which documents a view shows', () => {
  const mine     = doc({ id: 'd-mine' });
  const inHH     = doc({ id: 'd-hh',  user_id: BO, household_ids: [HH],  shared_household_ids: [HH] });
  const inHH2    = doc({ id: 'd-hh2', household_ids: [HH2], shared_household_ids: [HH2] });
  const all = [mine, inHH, inHH2];

  it('My Finances holds what you OWN — never a housemate\'s paperwork', async () => {
    inBothHouseholds();
    await vault(all);
    // d-hh is Bo's. Ada is in a household with him; that is not a reason for his
    // documents to sit in a view called My Finances.
    expect(documentsDS.inScope().map(d => d.id)).toEqual(['d-mine', 'd-hh2']);
  });

  it("keeps your own document in My Finances after you share it", async () => {
    inBothHouseholds();
    await vault(all);
    // d-hh2 is Ada's, shared to the farm — still hers, still in her own view.
    expect(documentsDS.inScope('personal').map(d => d.id)).toContain('d-hh2');
  });

  it("sends a housemate's document to the household view, not to nowhere", async () => {
    inBothHouseholds({ scope: 'household', active: HH });
    await vault(all);
    expect(documentsDS.inScope('personal').map(d => d.id)).not.toContain('d-hh');
    expect(documentsDS.inScope('household', HH).map(d => d.id)).toEqual(['d-hh']);
  });

  it('a household holds only what is in THAT household', async () => {
    inBothHouseholds({ scope: 'household', active: HH });
    await vault(all);
    expect(documentsDS.inScope().map(d => d.id)).toEqual(['d-hh']);
  });

  it('switching households switches the paperwork with it', async () => {
    inBothHouseholds({ scope: 'household', active: HH2 });
    await vault(all);
    expect(documentsDS.inScope().map(d => d.id)).toEqual(['d-hh2']);
  });

  it('never lets membership of one household expose another\'s documents', async () => {
    // Bo is in HH only. Ada's farm paperwork is not his business, and Ada
    // being in both households does not make it so.
    seed({
      as: BO,
      households: [household(HH, 'Ada & Bo')],
      members: [member(HH, ADA, 'owner'), member(HH, BO)],
      scope: 'household', active: HH,
    });
    await vault([inHH, inHH2]);
    expect(documentsDS.inScope().map(d => d.id)).toEqual(['d-hh']);
  });

  it('shows nothing rather than everything when no household is resolved', async () => {
    seed({ scope: 'household' });                 // a stale preference, no household
    await vault(all);
    // currentScope() refuses 'household' for somebody in none, so the vault is
    // what shows — the personal answer, never another household's.
    expect(documentsDS.inScope('household').map(d => d.id)).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Sharing a document to households
// ═════════════════════════════════════════════════════════════════════════════

describe('explicit sharing', () => {
  it('sends exactly the households asked for, and keeps one row', async () => {
    inBothHouseholds();
    const original = doc({ id: 'd-1' });
    await vault([original]);

    const update = vi.spyOn(documentsApi, 'update').mockResolvedValue(
      { ...original, household_ids: [HH, HH2], shared_household_ids: [HH, HH2] });
    const saved = await documentsDS.setHouseholds('d-1', [HH, HH2]);

    expect(update).toHaveBeenCalledWith('d-1', { household_ids: [HH, HH2] });
    expect(saved.household_ids).toEqual([HH, HH2]);
    // One document, in both pictures — not two documents.
    expect(documentsDS.cached()).toHaveLength(1);
    expect(documentsDS.cached()[0].household_ids).toEqual([HH, HH2]);
  });

  it('shows the shared document in each household, once', async () => {
    inBothHouseholds({ scope: 'household', active: HH });
    await vault([doc({ id: 'd-1', household_ids: [HH, HH2], shared_household_ids: [HH, HH2] })]);
    expect(documentsDS.inScope('household', HH)).toHaveLength(1);
    expect(documentsDS.inScope('household', HH2)).toHaveLength(1);
  });

  it('un-sharing takes it out of one household and leaves the others alone', async () => {
    inBothHouseholds();
    const shared = doc({ id: 'd-1', household_ids: [HH, HH2], shared_household_ids: [HH, HH2] });
    await vault([shared]);

    vi.spyOn(documentsApi, 'update').mockResolvedValue(
      { ...shared, household_ids: [HH2], shared_household_ids: [HH2] });
    await documentsDS.setHouseholds('d-1', [HH2]);

    expect(documentsDS.inScope('household', HH)).toEqual([]);
    expect(documentsDS.inScope('household', HH2)).toHaveLength(1);
    // Nothing was deleted — un-sharing takes access, never paperwork.
    expect(documentsDS.cached()).toHaveLength(1);
  });

  it('making it personal empties the households and keeps the document', async () => {
    inBothHouseholds();
    const shared = doc({ id: 'd-1', household_ids: [HH], shared_household_ids: [HH] });
    await vault([shared]);

    vi.spyOn(documentsApi, 'update').mockResolvedValue(
      { ...shared, household_ids: [], shared_household_ids: [] });
    await documentsDS.setHouseholds('d-1', []);

    expect(documentsDS.inScope('household', HH)).toEqual([]);
    expect(documentsDS.inScope('personal')).toHaveLength(1);
  });

  it('leaves the rest of the vault untouched when one document is shared', async () => {
    inBothHouseholds();
    const one = doc({ id: 'd-1' });
    const two = doc({ id: 'd-2', name: 'Payslip.pdf' });
    await vault([one, two]);

    vi.spyOn(documentsApi, 'update').mockResolvedValue(
      { ...one, household_ids: [HH], shared_household_ids: [HH] });
    await documentsDS.setHouseholds('d-1', [HH]);

    expect(documentsDS.cached().find(d => d.id === 'd-2')!.household_ids).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Following the record it is filed against
// ═════════════════════════════════════════════════════════════════════════════

describe('a document filed against a shared record', () => {
  it('appears in the record\'s household without a share of its own', async () => {
    inBothHouseholds({ scope: 'household', active: HH });
    // The server merged the account's households into household_ids and left
    // shared_household_ids empty: nobody shared the DOCUMENT.
    await vault([doc({
      id: 'd-1', linked_type: 'account', linked_id: 'acc-1',
      household_ids: [HH], shared_household_ids: [],
    })]);
    expect(documentsDS.inScope().map(d => d.id)).toEqual(['d-1']);
  });

  it('leaves that household the moment the record stops being shared', async () => {
    inBothHouseholds({ scope: 'household', active: HH });
    const linked = doc({ id: 'd-1', linked_type: 'account', linked_id: 'acc-1', household_ids: [HH] });
    await vault([linked]);
    expect(documentsDS.inScope()).toHaveLength(1);

    // The account was un-shared: the next read simply carries no household.
    await vault([{ ...linked, household_ids: [] }]);
    expect(documentsDS.inScope()).toEqual([]);
    expect(documentsDS.inScope('personal')).toHaveLength(1);   // still Ada's own
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  A record's own paperwork — the link read from the other end
// ═════════════════════════════════════════════════════════════════════════════

describe('finding a record\'s documents', () => {
  beforeEach(async () => {
    seed();
    await vault([
      doc({ id: 'd-acc', linked_type: 'account', linked_id: 'acc-1' }),
      doc({ id: 'd-acc-old', linked_type: 'account', linked_id: 'acc-1', document_date: '2026-06-30' }),
      doc({ id: 'd-loan', linked_type: 'loan', linked_id: 'loan-1' }),
      doc({ id: 'd-tax', linked_type: 'tax_year', linked_id: '2025-2026' }),
      doc({ id: 'd-policy' }),
    ]);
  });

  it('finds what is filed against an account, newest first', () => {
    expect(documentsDS.forRecord('account', 'acc-1').map(d => d.id)).toEqual(['d-acc', 'd-acc-old']);
  });

  it('keeps record kinds apart, and answers nothing for a record with none', () => {
    expect(documentsDS.forRecord('loan', 'loan-1').map(d => d.id)).toEqual(['d-loan']);
    expect(documentsDS.forRecord('property', 'prop-1')).toEqual([]);
    expect(documentsDS.forRecord('account', null)).toEqual([]);
  });

  it('finds a financial year\'s paperwork by its FY label', () => {
    expect(documentsDS.forRecord('tax_year', '2025-2026').map(d => d.id)).toEqual(['d-tax']);
  });

  it('resolves a record that points AT its document', () => {
    expect(documentsDS.byIds(['d-policy']).map(d => d.id)).toEqual(['d-policy']);
    expect(documentsDS.byIds([null])).toEqual([]);
  });

  it('can only ever find what the server was willing to send', () => {
    // Nothing here filters by permission, because nothing here needs to: a
    // document that was not sent is not in the list to be found.
    expect(documentsDS.forRecord('account', 'acc-someone-elses')).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  User isolation
// ═════════════════════════════════════════════════════════════════════════════

describe('user isolation', () => {
  it('a vault fetched for one user is never served to another', async () => {
    seed({ as: ADA });
    await vault([doc({ id: 'd-1' })]);
    expect(documentsDS.cached()).toHaveLength(1);

    // The signed-in user changes — the cache belongs to the person it was
    // fetched for, and nobody else.
    seed({ as: BO });
    expect(documentsDS.cached()).toEqual([]);
    expect(documentsDS.loaded()).toBe(false);
    expect(documentsDS.inScope()).toEqual([]);
    expect(documentsDS.forRecord('account', 'acc-1')).toEqual([]);
  });

  it('a failed fetch is not an empty vault', async () => {
    seed();
    vi.spyOn(documentsApi, 'getAll').mockRejectedValue(new Error('offline'));
    vi.spyOn(documentsApi, 'facts').mockResolvedValue([]);
    await documentsDS.refresh();
    expect(documentsDS.loaded()).toBe(false);
  });
});
