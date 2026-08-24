/**
 * Phase 8.1 — the document vault's laws, proven without a database.
 *
 * The things worth pinning are exactly the ways a vault can go quietly wrong:
 *
 *   • USER ISOLATION — one user's filter can never match another user's
 *     documents, and a foreign document is invisible even when its id is known;
 *   • SHARING FOLLOWS THE LINK — a document filed to a household or to a shared
 *     record is visible to exactly the people who can see that record, and to
 *     nobody the moment the link (or the share) goes away;
 *   • TAX STAYS PERSONAL — a tax-year document never cascades to anybody;
 *   • LINKING IS FILING, NOT PUBLISHING — you may link only to what you can
 *     already see, and a foreign record answers "not found", never "not yours";
 *   • THE METADATA GATE — server-owned columns can't be smuggled in through a
 *     PATCH, '' coerces to null (the 22P02 class of failure), and a half-link
 *     is refused outright;
 *   • STORAGE PATHS — a hostile filename cannot climb out of the owner's
 *     folder.
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeFilename, storagePathFor, isAcceptedMime, isPreviewable,
  pickDocumentFields, documentVisibilityFilter, canSeeDocument, linkTargetRefusal,
  pickHouseholdIds,
} from './documentVault';
import type { HouseholdScope, ShareRecordType, SharePermission, HouseholdRole } from './householdScope';

const ME = 'user-me';
const OTHER = 'user-other';
const HH = 'household-1';

function scopeOf(o: {
  roles?: Record<string, HouseholdRole>;
  grants?: Partial<Record<ShareRecordType, Record<string, SharePermission>>>;
  householdRecords?: Partial<Record<ShareRecordType, string[]>>;
} = {}): HouseholdScope {
  const scope: HouseholdScope = {
    userId: ME, roles: new Map(), grants: new Map(), householdRecords: new Map(),
  };
  for (const [id, role] of Object.entries(o.roles ?? {})) scope.roles.set(id, role);
  for (const [type, byId] of Object.entries(o.grants ?? {})) {
    scope.grants.set(type as ShareRecordType, new Map(Object.entries(byId)));
  }
  for (const [type, ids] of Object.entries(o.householdRecords ?? {})) {
    scope.householdRecords.set(type as ShareRecordType, new Set(ids));
  }
  return scope;
}

// ── User isolation ───────────────────────────────────────────────────────────

describe('user isolation', () => {
  it('a personal-only user gets NO or-filter — just their own rows', () => {
    // Null tells the route to use .eq('user_id', me): the pre-sharing fast
    // path, with no way to match anybody else's documents.
    expect(documentVisibilityFilter(scopeOf())).toBeNull();
  });

  it('every filter begins with ownership and only ever ADDS linked visibility', () => {
    const filter = documentVisibilityFilter(scopeOf({ roles: { [HH]: 'member' } }));
    expect(filter).toContain(`user_id.eq.${ME}`);
    // The only other clause is the household link — nothing matches a foreign
    // personal document.
    expect(filter).toBe(
      `user_id.eq.${ME},and(linked_type.eq.household,linked_id.in.(${HH}))`);
  });

  it("another user's unlinked document is invisible even with its id in hand", () => {
    const doc = { user_id: OTHER, linked_type: null, linked_id: null };
    expect(canSeeDocument(doc, scopeOf())).toBe(false);
    // …and being in a household changes nothing for an UNLINKED document.
    expect(canSeeDocument(doc, scopeOf({ roles: { [HH]: 'owner' } }))).toBe(false);
  });

  it('your own document is always yours to see, linked or not', () => {
    expect(canSeeDocument({ user_id: ME, linked_type: null, linked_id: null }, scopeOf())).toBe(true);
    expect(canSeeDocument(
      { user_id: ME, linked_type: 'tax_year', linked_id: '2025-2026' }, scopeOf())).toBe(true);
  });
});

// ── Sharing follows the link ─────────────────────────────────────────────────

describe('sharing follows the link', () => {
  const householdDoc = { user_id: OTHER, linked_type: 'household', linked_id: HH };

  it('a household-linked document is visible to members of THAT household only', () => {
    expect(canSeeDocument(householdDoc, scopeOf({ roles: { [HH]: 'viewer' } }))).toBe(true);
    expect(canSeeDocument(householdDoc, scopeOf({ roles: { 'household-2': 'owner' } }))).toBe(false);
    expect(canSeeDocument(householdDoc, scopeOf())).toBe(false);
  });

  it('a document on a household-shared record is visible to whoever sees the record', () => {
    const doc = { user_id: OTHER, linked_type: 'loan', linked_id: 'loan-1' };
    expect(canSeeDocument(doc, scopeOf({ householdRecords: { loan: ['loan-1'] } }))).toBe(true);
    // Sharing a DIFFERENT loan doesn't leak this one's paperwork.
    expect(canSeeDocument(doc, scopeOf({ householdRecords: { loan: ['loan-2'] } }))).toBe(false);
  });

  it('a directly-granted record brings its documents too — view is enough to look', () => {
    const doc = { user_id: OTHER, linked_type: 'account', linked_id: 'acc-1' };
    expect(canSeeDocument(doc, scopeOf({ grants: { account: { 'acc-1': 'view' } } }))).toBe(true);
  });

  it('un-sharing takes the paperwork back in the same instant (nothing stamped)', () => {
    const doc = { user_id: OTHER, linked_type: 'property', linked_id: 'prop-1' };
    const shared = scopeOf({ householdRecords: { property: ['prop-1'] } });
    const unshared = scopeOf(); // the same user after the share is removed
    expect(canSeeDocument(doc, shared)).toBe(true);
    expect(canSeeDocument(doc, unshared)).toBe(false);
  });

  it('the record types must not cross: an account share never unlocks a card document', () => {
    const doc = { user_id: OTHER, linked_type: 'card', linked_id: 'x-1' };
    expect(canSeeDocument(doc, scopeOf({ householdRecords: { account: ['x-1'] } }))).toBe(false);
  });

  it('the list filter and the single-row check agree clause for clause', () => {
    const scope = scopeOf({
      roles: { [HH]: 'member' },
      householdRecords: { account: ['acc-1'], loan: ['loan-9'] },
      grants: { investment: { 'inv-3': 'view' } },
    });
    const filter = documentVisibilityFilter(scope)!;
    expect(filter).toContain('and(linked_type.eq.household,linked_id.in.(household-1))');
    expect(filter).toContain('and(linked_type.eq.account,linked_id.in.(acc-1))');
    expect(filter).toContain('and(linked_type.eq.loan,linked_id.in.(loan-9))');
    expect(filter).toContain('and(linked_type.eq.investment,linked_id.in.(inv-3))');
    // No clause for tax_year exists, ever.
    expect(filter).not.toContain('tax_year');
  });
});

// ── Shared in its own right ──────────────────────────────────────────────────
//
// The second route in: a `record_households` row of type 'document'. It reaches
// the members of the households it was put in, and stops there.

describe('a document shared to a household', () => {
  const doc = { id: 'doc-1', user_id: OTHER, linked_type: null, linked_id: null };

  it('reaches a member of the household it was shared to', () => {
    expect(canSeeDocument(doc, scopeOf({ householdRecords: { document: ['doc-1'] } }))).toBe(true);
  });

  it('reaches nobody else — a member of ANOTHER household sees nothing', () => {
    // The scope of somebody in a household that this document was never put
    // into: the id-set is what decides, not membership of a household in
    // general, so belonging to five households exposes nothing extra.
    expect(canSeeDocument(doc, scopeOf({ roles: { 'household-2': 'owner' } }))).toBe(false);
    expect(canSeeDocument(doc, scopeOf({ householdRecords: { document: ['doc-2'] } }))).toBe(false);
  });

  it('stops reaching them the moment the share is removed', () => {
    const shared = scopeOf({ householdRecords: { document: ['doc-1'] } });
    const revoked = scopeOf();                       // the same user, un-shared
    expect(canSeeDocument(doc, shared)).toBe(true);
    expect(canSeeDocument(doc, revoked)).toBe(false);
  });

  it('puts the shared ids in the filter, alongside ownership', () => {
    const filter = documentVisibilityFilter(
      scopeOf({ householdRecords: { document: ['doc-1', 'doc-2'] } }));
    expect(filter).toContain(`user_id.eq.${ME}`);
    expect(filter).toContain('id.in.(doc-1,doc-2)');
  });

  it('leaves the personal-only fast path exactly as it was', () => {
    // Nothing shared with them, nothing shared to them: still no or-filter.
    expect(documentVisibilityFilter(scopeOf({ householdRecords: { document: [] } }))).toBeNull();
  });

  it('never mistakes an unshared document for a shared one on id alone', () => {
    const other = { id: 'doc-9', user_id: OTHER, linked_type: null, linked_id: null };
    expect(canSeeDocument(other, scopeOf({ householdRecords: { document: ['doc-1'] } }))).toBe(false);
  });
});

// ── What a share request may say ─────────────────────────────────────────────

describe('reading household_ids off a request', () => {
  it('says nothing when the request said nothing — an edit cannot un-share by silence', () => {
    expect(pickHouseholdIds({})).toBeNull();
    expect(pickHouseholdIds({ name: 'Renamed' })).toBeNull();
  });

  it('reads a JSON array, and an empty one means personal', () => {
    expect(pickHouseholdIds({ household_ids: ['h1', 'h2'] })).toEqual(['h1', 'h2']);
    expect(pickHouseholdIds({ household_ids: [] })).toEqual([]);
  });

  it('reads the comma-separated form a multipart upload has to use', () => {
    expect(pickHouseholdIds({ household_ids: 'h1, h2' })).toEqual(['h1', 'h2']);
    expect(pickHouseholdIds({ household_ids: '' })).toEqual([]);
  });

  it('cannot ask for the same household twice', () => {
    expect(pickHouseholdIds({ household_ids: ['h1', 'h1', 'h2'] })).toEqual(['h1', 'h2']);
  });
});

// ── Tax stays personal ───────────────────────────────────────────────────────

describe('tax stays personal', () => {
  it('a tax-year document never cascades — not even to a household owner', () => {
    const doc = { user_id: OTHER, linked_type: 'tax_year', linked_id: '2025-2026' };
    expect(canSeeDocument(doc, scopeOf({ roles: { [HH]: 'owner' } }))).toBe(false);
  });
});

// ── Linking is filing, not publishing ────────────────────────────────────────

describe('link validation', () => {
  it('your own record is always yours to file against', () => {
    expect(linkTargetRefusal('loan', 'loan-1', ME, scopeOf())).toBeNull();
  });

  it('a record shared with you may carry your document', () => {
    const scope = scopeOf({ householdRecords: { account: ['acc-1'] } });
    expect(linkTargetRefusal('account', 'acc-1', OTHER, scope)).toBeNull();
  });

  it("a stranger's record answers NOT FOUND — never 'not yours', never an oracle", () => {
    const refusal = linkTargetRefusal('loan', 'loan-x', OTHER, scopeOf());
    expect(refusal).toEqual({ status: 404, error: 'That record was not found.' });
    // A genuinely missing record gives the identical answer.
    expect(linkTargetRefusal('loan', 'loan-x', null, scopeOf())).toEqual(refusal);
  });

  it('a household link needs membership', () => {
    expect(linkTargetRefusal('household', HH, null, scopeOf({ roles: { [HH]: 'member' } }))).toBeNull();
    expect(linkTargetRefusal('household', HH, null, scopeOf())?.status).toBe(403);
  });

  it('a tax-year link needs no lookup — it is your own by construction', () => {
    expect(linkTargetRefusal('tax_year', '2025-2026', null, scopeOf())).toBeNull();
  });
});

// ── The metadata gate ────────────────────────────────────────────────────────

describe('pickDocumentFields', () => {
  it('keeps exactly the caller-editable fields and drops server-owned columns', () => {
    const { fields, refusal } = pickDocumentFields({
      name: ' Rates notice ', document_type: 'property', document_date: '2026-01-15',
      provider: 'Council', notes: 'Q3', linked_type: 'property', linked_id: 'prop-1',
      // Attempts to smuggle server-owned columns:
      user_id: OTHER, storage_path: '../../etc/passwd', size_bytes: 0, id: 'forged',
    });
    expect(refusal).toBeNull();
    expect(fields).toEqual({
      name: 'Rates notice', document_type: 'property', document_date: '2026-01-15',
      provider: 'Council', notes: 'Q3', linked_type: 'property', linked_id: 'prop-1',
    });
    expect('user_id' in fields).toBe(false);
    expect('storage_path' in fields).toBe(false);
  });

  it("coerces '' to null for the optional columns (the 22P02 class of bug)", () => {
    const { fields } = pickDocumentFields({
      document_date: '', provider: '', notes: '', linked_type: '', linked_id: '',
    });
    expect(fields.document_date).toBeNull();
    expect(fields.provider).toBeNull();
    expect(fields.linked_type).toBeNull();
    expect(fields.linked_id).toBeNull();
  });

  it('refuses a half-link, an unknown type, a bad date and an empty rename', () => {
    expect(pickDocumentFields({ linked_type: 'loan' }).refusal).not.toBeNull();
    expect(pickDocumentFields({ linked_id: 'x' }).refusal).not.toBeNull();
    expect(pickDocumentFields({ linked_type: 'password', linked_id: 'x' }).refusal).not.toBeNull();
    expect(pickDocumentFields({ document_type: 'malware' }).refusal).not.toBeNull();
    expect(pickDocumentFields({ document_date: '15/01/2026' }).refusal).not.toBeNull();
    expect(pickDocumentFields({ name: '   ' }).refusal).not.toBeNull();
  });

  it("a tax-year link must be an FY label, e.g. '2025-2026'", () => {
    expect(pickDocumentFields({ linked_type: 'tax_year', linked_id: '2025-2026' }).refusal).toBeNull();
    expect(pickDocumentFields({ linked_type: 'tax_year', linked_id: 'FY25' }).refusal).not.toBeNull();
  });

  it('an edit that says nothing about the link leaves the link alone', () => {
    const { fields } = pickDocumentFields({ name: 'Renamed' });
    expect('linked_type' in fields).toBe(false);
    expect('linked_id' in fields).toBe(false);
  });
});

// ── Storage paths and file acceptance ────────────────────────────────────────

describe('storage paths', () => {
  it('a hostile filename cannot climb out of the owner’s folder', () => {
    const path = storagePathFor(ME, 'doc-1', '../../{OTHER}/secret.pdf');
    expect(path.startsWith(`${ME}/doc-1/`)).toBe(true);
    expect(path).not.toContain('..');
    const parts = path.split('/');
    expect(parts).toHaveLength(3);
  });

  it('sanitizes but never empties a name', () => {
    expect(sanitizeFilename('October payslip.pdf')).toBe('October payslip.pdf');
    expect(sanitizeFilename('///')).toBe('document');
    expect(sanitizeFilename(undefined)).toBe('document');
    expect(sanitizeFilename('a'.repeat(500) + '.pdf').length).toBeLessThanOrEqual(140);
  });

  it('accepts financial paperwork and refuses executables', () => {
    expect(isAcceptedMime('application/pdf')).toBe(true);
    expect(isAcceptedMime('image/jpeg')).toBe(true);
    expect(isAcceptedMime('text/csv')).toBe(true);
    expect(isAcceptedMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe(true);
    expect(isAcceptedMime('application/x-msdownload')).toBe(false);
    expect(isAcceptedMime('application/zip')).toBe(false);
    expect(isAcceptedMime(undefined)).toBe(false);
  });

  it('previews PDFs, images and text; everything else is download-only', () => {
    expect(isPreviewable('application/pdf')).toBe(true);
    expect(isPreviewable('image/png')).toBe(true);
    expect(isPreviewable('text/csv')).toBe(true);
    expect(isPreviewable('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe(false);
  });
});
