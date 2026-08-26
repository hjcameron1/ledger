/**
 * Phase 8.1 — the vault's presentation decisions.
 *
 * What matters here: the yours/shared split is by OWNERSHIP (the same line
 * every other screen draws), a link always says what it points at even when
 * this device can't resolve the target, search covers the fields a person
 * actually remembers, and the FY picker speaks real Australian FY labels.
 */
import { describe, it, expect } from 'vitest';
import type { LedgerDocument, Household, HouseholdMember } from '../types';
import {
  kindLabel, formatBytes, canPreview, linkDisplay, splitByOwnership,
  filterDocuments, fyOfDate, fyOptions, DOCUMENT_KINDS, LinkSources,
  scopeDocuments, documentsForRecord, documentsByIds, documentHouseholds,
  withLiveLinkHouseholds,
} from './documents';
import type { Loan } from '../types';
import { buildContext } from './household';

const ME = 'user-me';
const OTHER = 'user-other';

const doc = (o: Partial<LedgerDocument> = {}): LedgerDocument => ({
  id: 'd1', user_id: ME, name: 'October payslip.pdf',
  original_filename: 'October payslip.pdf', mime_type: 'application/pdf',
  size_bytes: 120_000, document_type: 'payslip', document_date: '2026-10-15',
  provider: 'Acme Pty Ltd', notes: null, linked_type: null, linked_id: null, ...o,
});

const sources: LinkSources = {
  accounts: [{ id: 'acc-1', name: 'Everyday' }],
  creditCards: [{ id: 'cc-1', name: 'Amex' }],
  loans: [{ id: 'loan-1', name: 'Home mortgage' }],
  properties: [{ id: 'prop-1', name: 'Bondi apartment' }],
  investments: [{ id: 'inv-1', name: 'VAS' }],
  households: [{ id: 'hh-1', name: 'Our place' }],
};

describe('ownership split', () => {
  it('yours versus shared-with-you is drawn by user_id, nothing else', () => {
    const mineDoc = doc();
    const sharedDoc = doc({ id: 'd2', user_id: OTHER, linked_type: 'household', linked_id: 'hh-1' });
    const { mine, shared } = splitByOwnership([mineDoc, sharedDoc], ME);
    expect(mine).toEqual([mineDoc]);
    expect(shared).toEqual([sharedDoc]);
  });

  it('your own household-linked document still counts as YOURS', () => {
    const d = doc({ linked_type: 'household', linked_id: 'hh-1' });
    const { mine, shared } = splitByOwnership([d], ME);
    expect(mine).toHaveLength(1);
    expect(shared).toHaveLength(0);
  });
});

describe('link display', () => {
  it('resolves each link kind to its record’s name', () => {
    expect(linkDisplay(doc({ linked_type: 'account', linked_id: 'acc-1' }), sources)).toBe('Account · Everyday');
    expect(linkDisplay(doc({ linked_type: 'card', linked_id: 'cc-1' }), sources)).toBe('Credit card · Amex');
    expect(linkDisplay(doc({ linked_type: 'loan', linked_id: 'loan-1' }), sources)).toBe('Loan · Home mortgage');
    expect(linkDisplay(doc({ linked_type: 'household', linked_id: 'hh-1' }), sources)).toBe('Household · Our place');
  });

  it('a tax year renders as its FY label, resolved from nothing', () => {
    expect(linkDisplay(doc({ linked_type: 'tax_year', linked_id: '2025-2026' }), sources))
      .toBe('Tax year 2025–26');
  });

  it("an unresolvable target still SAYS what it is — never pretends there's no link", () => {
    expect(linkDisplay(doc({ linked_type: 'loan', linked_id: 'loan-gone' }), sources)).toBe('Loan');
  });

  it('no link renders nothing', () => {
    expect(linkDisplay(doc(), sources)).toBeNull();
  });
});

describe('filtering', () => {
  const pile = [
    doc(),
    doc({ id: 'd2', document_type: 'insurance', name: 'Car policy', original_filename: 'policy.pdf', provider: 'NRMA' }),
    doc({ id: 'd3', document_type: 'statement', name: 'Jan.pdf', original_filename: 'jan.pdf', notes: 'joint account' }),
  ];

  it('narrows by kind', () => {
    expect(filterDocuments(pile, 'insurance', '').map(d => d.id)).toEqual(['d2']);
    expect(filterDocuments(pile, 'all', '')).toHaveLength(3);
  });

  it('searches name, provider, notes and the type’s own words', () => {
    expect(filterDocuments(pile, 'all', 'nrma').map(d => d.id)).toEqual(['d2']);
    expect(filterDocuments(pile, 'all', 'joint').map(d => d.id)).toEqual(['d3']);
    expect(filterDocuments(pile, 'all', 'payslip').map(d => d.id)).toEqual(['d1']);
    expect(filterDocuments(pile, 'all', 'zzz')).toHaveLength(0);
  });
});

describe('vocabulary and formatting', () => {
  it('every kind has a label and a badge', () => {
    for (const k of DOCUMENT_KINDS) expect(kindLabel(k.value)).toBeTruthy();
    expect(kindLabel('nonsense')).toBe('Other');
  });

  it('formats sizes at human scale', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(120_000)).toBe('117 KB');
    expect(formatBytes(2_600_000)).toBe('2.5 MB');
    expect(formatBytes(null)).toBe('0 B');
  });

  it('previews PDFs, images and text; is honest about the rest', () => {
    expect(canPreview('application/pdf')).toBe(true);
    expect(canPreview('image/jpeg')).toBe(true);
    expect(canPreview('text/csv')).toBe(true);
    expect(canPreview('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(false);
    expect(canPreview(null)).toBe(false);
  });
});

describe('tax years', () => {
  it('an Australian FY runs 1 July – 30 June', () => {
    expect(fyOfDate(new Date(2026, 7, 23))).toBe('2026-2027');  // August → new FY
    expect(fyOfDate(new Date(2026, 5, 30))).toBe('2025-2026');  // June → old FY
    expect(fyOfDate(new Date(2026, 6, 1))).toBe('2026-2027');   // 1 July → new FY
  });

  it('the picker offers the current FY and its predecessors, newest first', () => {
    const options = fyOptions(new Date(2026, 7, 23), 3);
    expect(options).toEqual(['2026-2027', '2025-2026', '2024-2025']);
  });
});


// ═════════════════════════════════════════════════════════════════════════════
//  Which view a document belongs in
// ═════════════════════════════════════════════════════════════════════════════
//
// The leak this closes: being in two households used to put every document
// either of them could reach into both views. A household view now shows the
// documents in THAT household and nothing else.

const HH  = 'hh-1';
const HH2 = 'hh-2';

const householdRow = (id: string, name: string): Household =>
  ({ id, name, created_by: ME, currency: 'AUD' });
const memberRow = (householdId: string, userId: string): HouseholdMember =>
  ({ id: `m-${householdId}-${userId}`, household_id: householdId, user_id: userId,
     role: 'member', status: 'active' });

/** Me, a member of both households — the case multi-household sharing is
 *  written against, and the one where a leak would show. */
const inBoth = (active?: string | null) => buildContext(
  ME,
  [householdRow(HH, 'Our place'), householdRow(HH2, 'The farm')],
  [memberRow(HH, ME), memberRow(HH2, ME)],
  active,
);
/** One person, no household — must behave exactly as it did before any of this. */
const solo = () => buildContext(ME, [], []);

describe('scoping documents to a view', () => {
  const mine     = doc({ id: 'd-mine' });
  const inHH     = doc({ id: 'd-hh',   user_id: OTHER, household_ids: [HH] });
  const inHH2    = doc({ id: 'd-hh2',  user_id: OTHER, household_ids: [HH2] });
  const inBothHH = doc({ id: 'd-both', household_ids: [HH, HH2] });
  const all = [mine, inHH, inHH2, inBothHH];

  it('shows a household ONLY what was put into that household', () => {
    const ids = scopeDocuments(all, inBoth(HH), 'household', HH).map(d => d.id);
    expect(ids).toEqual(['d-hh', 'd-both']);
    // The other household's paperwork is not in this view, and mine — which is
    // in no household at all — is not either.
    expect(ids).not.toContain('d-hh2');
    expect(ids).not.toContain('d-mine');
  });

  it('keeps two households apart for the same person', () => {
    expect(scopeDocuments(all, inBoth(), 'household', HH2).map(d => d.id))
      .toEqual(['d-hh2', 'd-both']);
  });

  it('follows the active household when none is named', () => {
    expect(scopeDocuments(all, inBoth(HH2), 'household').map(d => d.id))
      .toEqual(['d-hh2', 'd-both']);
  });

  it('shows nothing rather than everything when no household can be resolved', () => {
    // "Which household?" with no answer must never fall back to "all of them".
    expect(scopeDocuments(all, solo(), 'household')).toEqual([]);
  });

  it('shows My Finances what you OWN — never another member\'s paperwork', () => {
    // THE leak, in one assertion: being in a household with somebody put their
    // documents in a view that means "mine". My Finances is ownership, exactly
    // like every other row in Ledger.
    const ids = scopeDocuments(all, inBoth(HH), 'personal').map(d => d.id);
    expect(ids).toEqual(['d-mine', 'd-both']);
    expect(ids).not.toContain('d-hh');
    expect(ids).not.toContain('d-hh2');
  });

  it('keeps your own document in My Finances after you share it', () => {
    // Sharing tells somebody about your paperwork; it does not give it away.
    expect(scopeDocuments([inBothHH], inBoth(HH), 'personal').map(d => d.id)).toEqual(['d-both']);
  });

  it('leaves somebody with no household seeing their own vault, as before', () => {
    expect(scopeDocuments([mine], solo(), 'personal')).toEqual([mine]);
    expect(scopeDocuments(all, solo(), 'personal').map(d => d.id)).toEqual(['d-mine', 'd-both']);
  });

  it("a member's document reaches them in the household view, and only there", () => {
    // The other half of the rule: what leaves My Finances is not lost — it is
    // where its owner put it.
    expect(scopeDocuments(all, inBoth(HH), 'personal').map(d => d.id)).not.toContain('d-hh');
    expect(scopeDocuments(all, inBoth(HH), 'household', HH).map(d => d.id)).toContain('d-hh');
  });

  it('drops a document the instant its share is revoked', () => {
    const revoked = { ...inHH, household_ids: [] };
    expect(scopeDocuments([revoked], inBoth(HH), 'household', HH)).toEqual([]);
    expect(documentHouseholds(revoked)).toEqual([]);
  });

  it('counts a document in two households once in each, never twice in one', () => {
    expect(scopeDocuments([inBothHH], inBoth(), 'household', HH)).toHaveLength(1);
    expect(scopeDocuments([inBothHH], inBoth(), 'household', HH2)).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The other direction: a record's paperwork
// ═════════════════════════════════════════════════════════════════════════════

describe("a record's documents", () => {
  const statement = doc({ id: 'd-1', linked_type: 'account', linked_id: 'acc-1', document_date: '2026-07-31' });
  const older     = doc({ id: 'd-2', linked_type: 'account', linked_id: 'acc-1', document_date: '2026-06-30' });
  const otherAcc  = doc({ id: 'd-3', linked_type: 'account', linked_id: 'acc-2' });
  const contract  = doc({ id: 'd-4', linked_type: 'loan', linked_id: 'acc-1' });
  const loose     = doc({ id: 'd-5' });
  const all = [older, statement, otherAcc, contract, loose];

  it('finds exactly what was filed against it, newest first', () => {
    expect(documentsForRecord(all, 'account', 'acc-1').map(d => d.id)).toEqual(['d-1', 'd-2']);
  });

  it('never confuses one record kind with another that shares an id', () => {
    expect(documentsForRecord(all, 'loan', 'acc-1').map(d => d.id)).toEqual(['d-4']);
  });

  it('answers nothing for a record with no paperwork, and for no record at all', () => {
    expect(documentsForRecord(all, 'property', 'prop-9')).toEqual([]);
    expect(documentsForRecord(all, 'account', null)).toEqual([]);
    expect(documentsForRecord(all, 'account', undefined)).toEqual([]);
  });

  it('reads a tax year by its FY label', () => {
    const taxDoc = doc({ id: 'd-tax', linked_type: 'tax_year', linked_id: '2025-2026' });
    expect(documentsForRecord([...all, taxDoc], 'tax_year', '2025-2026').map(d => d.id)).toEqual(['d-tax']);
    expect(documentsForRecord([...all, taxDoc], 'tax_year', '2024-2025')).toEqual([]);
  });

  it('resolves a record that points AT its document', () => {
    // An insurance policy names its document rather than being named by it.
    expect(documentsByIds(all, ['d-3']).map(d => d.id)).toEqual(['d-3']);
    expect(documentsByIds(all, [null, undefined])).toEqual([]);
    expect(documentsByIds(all, ['no-such-document'])).toEqual([]);
  });
});


// ── M4 — a document follows the record it is filed against, LIVE ─────────────
describe('following the linked record live', () => {
  const loan = (o: Partial<Loan> = {}): Loan => ({
    id: 'loan-1', user_id: ME, name: 'Home mortgage', loan_type: 'mortgage',
    current_balance: 500_000, household_ids: ['hh-1'], ...o,
  } as Loan);

  const statement = doc({
    id: 'd-loan', linked_type: 'loan', linked_id: 'loan-1',
    // The server's merge said hh-1 — via the loan, not an own share.
    household_ids: ['hh-1'], shared_household_ids: [],
  });

  it('unsharing the loan takes its statement out of the household, before any refetch', () => {
    const [after] = withLiveLinkHouseholds([statement], { loan: [loan({ household_ids: [] })] });
    expect(documentHouseholds(after)).toEqual([]);
  });

  it('sharing the loan somewhere new brings its statement along', () => {
    const [after] = withLiveLinkHouseholds([statement], { loan: [loan({ household_ids: ['hh-1', 'hh-2'] })] });
    expect(documentHouseholds(after).sort()).toEqual(['hh-1', 'hh-2']);
  });

  it("the owner's OWN share survives the link's household ending", () => {
    const shared = doc({
      id: 'd-loan', linked_type: 'loan', linked_id: 'loan-1',
      household_ids: ['hh-1', 'hh-2'], shared_household_ids: ['hh-2'],
    });
    const [after] = withLiveLinkHouseholds([shared], { loan: [loan({ household_ids: [] })] });
    expect(documentHouseholds(after)).toEqual(['hh-2']);
  });

  it('a link this device cannot resolve keeps the server\'s merge — never narrowed on ignorance', () => {
    const [gone] = withLiveLinkHouseholds([statement], { loan: [] });
    expect(documentHouseholds(gone)).toEqual(['hh-1']);
    const [taxYear] = withLiveLinkHouseholds(
      [doc({ id: 'd-tax', linked_type: 'tax_year', linked_id: '2025-2026', household_ids: ['hh-1'] })], {},
    );
    expect(documentHouseholds(taxYear)).toEqual(['hh-1']);
  });

  it('an unlinked document passes through untouched', () => {
    const plain = doc({ id: 'd-plain', household_ids: ['hh-1'] });
    const [after] = withLiveLinkHouseholds([plain], { loan: [loan()] });
    expect(after).toBe(plain);
  });
});
