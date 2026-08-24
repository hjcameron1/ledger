/**
 * Phase 8.3 — the client's half of "what a document says".
 *
 * The decisions are the server's (backend/src/services/documentFacts.ts, and
 * its tests). What is worth pinning HERE is that the client never quietly
 * widens them: a shaky reading is not shown as fact, a rejected one does not
 * come back, and a field the server adds tomorrow appears rather than
 * disappearing.
 */
import { describe, it, expect } from 'vitest';
import {
  factIsUsable, factNeedsConfirmation, factLabel, factView, factsForDocument,
  isReadableDocument, FACT_TRUST_FLOOR,
} from './documentFacts';
import type { DocumentFact, LedgerDocument } from '../types';

const fact = (o: Partial<DocumentFact> = {}): DocumentFact => ({
  id: 'f1', document_id: 'doc-1', user_id: 'u1',
  field: 'renewal_date', value_kind: 'date',
  value_text: '2027-03-03', value_number: null, value_date: '2027-03-03',
  quote: 'Period of cover ends 3 March 2027', page: 1,
  confidence: 0.94, source: 'model', model: 'claude-sonnet-4-5',
  status: 'unconfirmed', ...o,
});

const doc = (o: Partial<LedgerDocument> = {}): LedgerDocument => ({
  id: 'doc-1', user_id: 'u1', name: 'NRMA renewal.pdf',
  original_filename: 'NRMA renewal.pdf', mime_type: 'application/pdf',
  size_bytes: 1000, document_type: 'insurance', document_date: null,
  provider: null, notes: null, linked_type: null, linked_id: null, ...o,
});

describe('what may be answered from', () => {
  it('answers from a confident reading', () => {
    expect(factIsUsable(fact())).toBe(true);
    expect(factNeedsConfirmation(fact())).toBe(false);
  });

  it('holds a shaky one back until somebody confirms it', () => {
    const shaky = fact({ confidence: FACT_TRUST_FLOOR - 0.1 });
    expect(factIsUsable(shaky)).toBe(false);
    expect(factNeedsConfirmation(shaky)).toBe(true);
    expect(factIsUsable({ ...shaky, status: 'confirmed' })).toBe(true);
  });

  it('never brings back a reading the user rejected', () => {
    expect(factIsUsable(fact({ confidence: 1, status: 'rejected' }))).toBe(false);
    expect(factsForDocument([fact({ status: 'rejected' })], 'doc-1')).toEqual([]);
  });

  it('copes with the numbers arriving as strings, the way Postgres sends them', () => {
    const view = factView(fact({
      field: 'premium_amount', value_kind: 'money',
      value_text: '1240.50', value_number: '1240.50', value_date: null,
      confidence: '0.91',
    }));
    expect(view.number).toBe(1240.5);
    expect(view.confidence).toBeCloseTo(0.91);
    expect(view.usable).toBe(true);
  });
});

describe('presentation', () => {
  it('names a field the way a person would say it', () => {
    expect(factLabel('renewal_date')).toBe('Renews');
    expect(factLabel('closing_balance')).toBe('Closing balance');
  });

  it('shows a field it has never heard of rather than dropping it', () => {
    expect(factLabel('waiting_period')).toBe('Waiting period');
  });

  it('puts what can be stated above what is waiting to be confirmed', () => {
    const rows = factsForDocument([
      fact({ id: 'a', field: 'excess', confidence: 0.2 }),
      fact({ id: 'b', field: 'insurer', confidence: 0.99 }),
    ], 'doc-1');
    expect(rows.map(r => r.field)).toEqual(['insurer', 'excess']);
  });

  it('keeps one document\'s readings out of another\'s', () => {
    const rows = factsForDocument([fact(), fact({ id: 'z', document_id: 'doc-2' })], 'doc-1');
    expect(rows).toHaveLength(1);
  });
});

describe('what can be read at all', () => {
  it('reads insurance, loan and statement PDFs and photographs', () => {
    expect(isReadableDocument(doc())).toBe(true);
    expect(isReadableDocument(doc({ document_type: 'loan', mime_type: 'image/jpeg' }))).toBe(true);
    expect(isReadableDocument(doc({ document_type: 'statement' }))).toBe(true);
  });

  it('does not offer to read what it cannot read', () => {
    expect(isReadableDocument(doc({ document_type: 'receipt' }))).toBe(false);
    expect(isReadableDocument(doc({ mime_type: 'application/vnd.ms-excel' }))).toBe(false);
  });
});
