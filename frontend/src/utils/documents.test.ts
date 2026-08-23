/**
 * Phase 8.1 — the vault's presentation decisions.
 *
 * What matters here: the yours/shared split is by OWNERSHIP (the same line
 * every other screen draws), a link always says what it points at even when
 * this device can't resolve the target, search covers the fields a person
 * actually remembers, and the FY picker speaks real Australian FY labels.
 */
import { describe, it, expect } from 'vitest';
import type { LedgerDocument } from '../types';
import {
  kindLabel, formatBytes, canPreview, linkDisplay, splitByOwnership,
  filterDocuments, fyOfDate, fyOptions, DOCUMENT_KINDS, LinkSources,
} from './documents';

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
