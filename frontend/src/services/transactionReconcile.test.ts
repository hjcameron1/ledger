import { describe, it, expect } from 'vitest';
import {
  mergeCreatedTransaction,
  postCreateMetadataDiff,
  POST_CREATE_META_FIELDS,
} from './dataService';
import type { Transaction } from '../types';

// Minimal Transaction factory — only the fields these pure reconciliation helpers
// touch matter; the rest are filled with inert defaults.
function tx(over: Partial<Transaction>): Transaction {
  return {
    id: 'local-1',
    user_id: 'demo',
    account_id: 'acct-1',
    account_type: 'bank',
    date: '2026-08-12',
    merchant: 'JB Hi-Fi',
    amount: 50,
    currency: 'AUD',
    category: 'Shopping',
    created_at: '2026-08-12T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    ...over,
  } as Transaction;
}

describe('mergeCreatedTransaction', () => {
  it('keeps post-create refund metadata and adopts only the server id/timestamps', () => {
    // Local row AFTER refund matching stamped it (transaction_type/refund_of/category).
    const local = tx({
      id: 'local-refund',
      amount: 50,
      transaction_type: 'refund',
      refund_of: 'purchase-server-id',
      category: 'Electronics',
      confidence: 0.95,
      review_status: 'clear',
    });
    // Server create RESPONSE reflects ONLY the create payload — no refund fields,
    // a freshly-minted UUID, and server timestamps.
    const server = tx({
      id: 'server-refund-uuid',
      transaction_type: null as unknown as Transaction['transaction_type'],
      refund_of: null,
      category: 'Shopping',
      confidence: null,
      created_at: '2026-08-12T01:00:00.000Z',
      updated_at: '2026-08-12T01:00:00.000Z',
    });

    const merged = mergeCreatedTransaction(local, server, 'acct-1');

    // Server-owned identity is adopted…
    expect(merged.id).toBe('server-refund-uuid');
    expect(merged.created_at).toBe('2026-08-12T01:00:00.000Z');
    expect(merged.updated_at).toBe('2026-08-12T01:00:00.000Z');
    // …but the refund metadata SURVIVES (this is the badge that used to vanish).
    expect(merged.transaction_type).toBe('refund');
    expect(merged.refund_of).toBe('purchase-server-id');
    expect(merged.category).toBe('Electronics');
    expect(merged.confidence).toBe(0.95);
  });

  it('falls back to the server row when there is no local row', () => {
    const server = tx({ id: 'server-only' });
    const merged = mergeCreatedTransaction(undefined, server, 'acct-9');
    expect(merged.id).toBe('server-only');
    expect(merged.account_id).toBe('acct-9');
  });

  it('applies the reconciled account_id over the local one', () => {
    const local = tx({ account_id: 'temp-acct' });
    const server = tx({ id: 'srv' });
    expect(mergeCreatedTransaction(local, server, 'real-acct').account_id).toBe('real-acct');
  });
});

describe('postCreateMetadataDiff', () => {
  it('returns the refund fields the create payload could not carry', () => {
    const local = tx({
      transaction_type: 'refund',
      refund_of: 'purchase-1',
      category: 'Electronics',
      category_source: 'merchant',
      confidence: 0.9,
      review_status: 'clear',
    });
    // What add() actually sent: a plain positive inflow, no refund classification yet.
    const sent: Partial<Transaction> = {
      transaction_type: null as unknown as Transaction['transaction_type'],
      category: 'Shopping',
      category_source: 'auto',
      review_status: 'clear',
    };

    const diff = postCreateMetadataDiff(local, sent);

    expect(diff.transaction_type).toBe('refund');
    expect(diff.refund_of).toBe('purchase-1');
    expect(diff.category).toBe('Electronics');
    expect(diff.category_source).toBe('merchant');
    expect(diff.confidence).toBe(0.9);
    // Unchanged field is NOT re-sent.
    expect('review_status' in diff).toBe(false);
  });

  it('flags a needs_review inflow (ambiguous/over-refund → Needs Review)', () => {
    const local = tx({ review_status: 'needs_review', review_reason: 'possible_refund' });
    const sent: Partial<Transaction> = { review_status: 'clear', review_reason: null };
    const diff = postCreateMetadataDiff(local, sent);
    expect(diff.review_status).toBe('needs_review');
    expect(diff.review_reason).toBe('possible_refund');
  });

  it('re-sends transfer metadata stamped after add()', () => {
    const local = tx({ is_transfer: true, transfer_pair_id: 'pair-1', transaction_type: 'transfer' });
    const sent: Partial<Transaction> = { transaction_type: null as unknown as Transaction['transaction_type'] };
    const diff = postCreateMetadataDiff(local, sent);
    expect(diff.is_transfer).toBe(true);
    expect(diff.transfer_pair_id).toBe('pair-1');
    expect(diff.transaction_type).toBe('transfer');
  });

  it('produces an EMPTY diff for a plain purchase (no extra write)', () => {
    const local = tx({
      transaction_type: 'purchase',
      category: 'Shopping',
      category_source: 'auto',
      review_status: 'clear',
    });
    // The create payload carried exactly these values.
    const sent: Partial<Transaction> = {
      transaction_type: 'purchase',
      category: 'Shopping',
      category_source: 'auto',
      review_status: 'clear',
    };
    expect(Object.keys(postCreateMetadataDiff(local, sent))).toHaveLength(0);
  });

  it('never emits null/undefined local metadata values', () => {
    // Metadata fields explicitly null/unset; category matches what was sent so the
    // only non-null diff candidate is excluded too → nothing to re-send.
    const local = tx({
      transaction_type: null as unknown as Transaction['transaction_type'],
      refund_of: null,
      confidence: null,
      review_reason: null,
    });
    const diff = postCreateMetadataDiff(local, { category: 'Shopping', review_status: 'clear' });
    for (const k of POST_CREATE_META_FIELDS) {
      expect(diff[k]).toBeUndefined();
    }
  });
});
