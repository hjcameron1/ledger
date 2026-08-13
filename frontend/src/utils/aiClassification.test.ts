import { describe, it, expect } from 'vitest';
import type { Transaction } from '../types';
import {
  needsAiFallback,
  selectAiFallbackCandidates,
  planAiSuggestion,
  toAiClassifyItem,
  AI_FALLBACK_MAX_CONFIDENCE,
} from './aiClassification';

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1', account_id: 'acc', account_type: 'bank',
    date: '2026-08-01', merchant: 'SQ *SOMETHING 123', currency: 'AUD',
    category: 'Uncategorised', category_source: 'auto', confidence: 0.1,
    is_duplicate_flagged: false, is_subscription: false, ...partial,
  };
}

describe('needsAiFallback — fallback order (only after deterministic rules fail)', () => {
  it('fires on a low-confidence uncategorised auto row', () => {
    expect(needsAiFallback(tx({ amount: -12 }))).toBe(true);
  });

  it('NEVER fires on an explicit user category (no override of user rules)', () => {
    expect(needsAiFallback(tx({ amount: -12, category: 'Groceries', category_source: 'user', confidence: 1 }))).toBe(false);
    // even if somehow low-confidence, a user source is untouchable
    expect(needsAiFallback(tx({ amount: -12, category: 'Groceries', category_source: 'user', confidence: 0.1 }))).toBe(false);
  });

  it('NEVER fires on a rule-, merchant- or provider-sourced category', () => {
    expect(needsAiFallback(tx({ amount: -12, category: 'Fuel', category_source: 'rule', confidence: 0.9 }))).toBe(false);
    expect(needsAiFallback(tx({ amount: -12, category: 'Groceries', category_source: 'merchant', confidence: 0.8 }))).toBe(false);
    expect(needsAiFallback(tx({ amount: -12, category: 'Dining', category_source: 'basiq', confidence: 0.6 }))).toBe(false);
  });

  it('does not fire on a confident-enough keyword (auto) categorisation', () => {
    expect(needsAiFallback(tx({ amount: -12, category: 'Transport', category_source: 'auto', confidence: AI_FALLBACK_MAX_CONFIDENCE }))).toBe(false);
    // but a real category with sub-threshold confidence still qualifies
    expect(needsAiFallback(tx({ amount: -12, category: 'Transport', category_source: 'auto', confidence: 0.3 }))).toBe(true);
  });

  it('does not fire on detected transfers / refunds (own flows)', () => {
    expect(needsAiFallback(tx({ amount: 12, is_transfer: true }))).toBe(false);
    expect(needsAiFallback(tx({ amount: 12, transaction_type: 'transfer' }))).toBe(false);
    expect(needsAiFallback(tx({ amount: 12, transaction_type: 'refund' }))).toBe(false);
  });

  it('does not fire when another review reason owns the row', () => {
    expect(needsAiFallback(tx({ amount: 12, review_status: 'needs_review', review_reason: 'possible_refund' }))).toBe(false);
    expect(needsAiFallback(tx({ amount: -12, review_status: 'needs_review', review_reason: 'ambiguous_duplicate' }))).toBe(false);
  });

  it('does not fire twice — ai_classified_at is the no-repeat guard', () => {
    expect(needsAiFallback(tx({ amount: -12, ai_classified_at: '2026-08-02T00:00:00Z' }))).toBe(false);
    expect(needsAiFallback(tx({ amount: -12, category_source: 'ai', confidence: 0.5 }))).toBe(false);
  });

  it('respects the review cutoff — only rows added on/after it are in scope', () => {
    const cutoff = '2026-08-10T00:00:00.000Z';
    // no cutoff → in scope regardless of created_at
    expect(needsAiFallback(tx({ amount: -12, created_at: '2026-01-01T00:00:00Z' }))).toBe(true);
    // added before cutoff → dropped (historical backlog "Clear all" removed)
    expect(needsAiFallback(tx({ amount: -12, created_at: '2026-08-09T23:59:59Z' }), cutoff)).toBe(false);
    // added on/after cutoff → still surfaced (works from new transactions)
    expect(needsAiFallback(tx({ amount: -12, created_at: '2026-08-11T00:00:00Z' }), cutoff)).toBe(true);
    // no created_at with a cutoff set → treated as pre-cutoff backlog → dropped
    expect(needsAiFallback(tx({ amount: -12, created_at: undefined }), cutoff)).toBe(false);
  });
});

describe('selectAiFallbackCandidates — dedup / in-flight / cap / isolation', () => {
  it('returns only eligible rows, skips in-flight, respects the cap', () => {
    const rows = [
      tx({ id: 'a', amount: -1 }),                                             // eligible
      tx({ id: 'b', amount: -1, category: 'Groceries', category_source: 'user', confidence: 1 }), // user → skip
      tx({ id: 'c', amount: -1 }),                                             // eligible but in-flight
      tx({ id: 'd', amount: -1, ai_classified_at: '2026-08-02' }),            // already classified → skip
      tx({ id: 'e', amount: -1 }),                                             // eligible
    ];
    const picked = selectAiFallbackCandidates(rows, { inFlight: new Set(['c']), limit: 10 });
    expect(picked.map(t => t.id)).toEqual(['a', 'e']);
  });

  it('caps the batch size', () => {
    const rows = Array.from({ length: 30 }, (_, i) => tx({ id: `r${i}`, amount: -1 }));
    expect(selectAiFallbackCandidates(rows, { limit: 25 })).toHaveLength(25);
  });

  it('excludes pre-cutoff backlog when a cutoff is passed', () => {
    const cutoff = '2026-08-10T00:00:00.000Z';
    const rows = [
      tx({ id: 'old', amount: -1, created_at: '2026-05-01T00:00:00Z' }), // backlog → excluded
      tx({ id: 'new', amount: -1, created_at: '2026-08-12T00:00:00Z' }), // added since → included
    ];
    expect(selectAiFallbackCandidates(rows, { cutoff }).map(t => t.id)).toEqual(['new']);
    // without a cutoff, both are candidates
    expect(selectAiFallbackCandidates(rows).map(t => t.id)).toEqual(['old', 'new']);
  });
});

describe('planAiSuggestion — never override, normalise, clamp, surface', () => {
  const now = '2026-08-05T10:00:00Z';

  it('applies a known category as source=ai and surfaces it in review', () => {
    const t = tx({ id: 'x', amount: -18 });
    const patch = planAiSuggestion(t, { id: 'x', category: 'groceries', merchant: 'Woolworths', reason: 'Supermarket', confidence: 0.82 }, { now });
    expect(patch).toMatchObject({
      category: 'Groceries',
      category_source: 'ai',
      confidence: 0.82,
      ai_suggested_category: 'Groceries',
      ai_suggested_merchant: 'Woolworths',
      ai_suggested_reason: 'Supermarket',
      ai_confidence: 0.82,
      ai_classified_at: now,
      review_status: 'needs_review',
      review_reason: 'uncertain_merchant',
    });
  });

  it('returns null rather than overriding a user/rule category (async-race backstop)', () => {
    expect(planAiSuggestion(tx({ amount: -1, category_source: 'user' }), { id: 't', category: 'Dining' })).toBeNull();
    expect(planAiSuggestion(tx({ amount: -1, category_source: 'rule' }), { id: 't', category: 'Dining' })).toBeNull();
    expect(planAiSuggestion(tx({ amount: -1, category_source: 'merchant' }), { id: 't', category: 'Dining' })).toBeNull();
  });

  it('never invents a category — an unknown name is stored as a note but not applied', () => {
    const patch = planAiSuggestion(tx({ amount: -1 }), { id: 't', category: 'Zzxqq Blorp', confidence: 0.9 }, { now })!;
    expect(patch.category).toBeUndefined();          // not applied
    expect(patch.category_source).toBeUndefined();
    expect(patch.ai_suggested_category).toBeNull();  // unknown collapsed out
    expect(patch.ai_classified_at).toBe(now);        // still marked so we don't re-ask
    expect(patch.review_status).toBe('needs_review');
  });

  it('preserves a user custom category', () => {
    const patch = planAiSuggestion(tx({ amount: -1 }), { id: 't', category: 'Side Hustle' }, { customCategories: ['Side Hustle'], now })!;
    expect(patch.category).toBe('Side Hustle');
    expect(patch.category_source).toBe('ai');
  });

  it('clamps out-of-range / non-finite confidence', () => {
    expect(planAiSuggestion(tx({ amount: -1 }), { id: 't', category: 'Food', confidence: 5 }, { now })!.ai_confidence).toBe(1);
    expect(planAiSuggestion(tx({ amount: -1 }), { id: 't', category: 'Food', confidence: -2 }, { now })!.ai_confidence).toBe(0);
    const patch = planAiSuggestion(tx({ amount: -1 }), { id: 't', category: 'Food' }, { now })!;
    expect(patch.ai_confidence).toBeNull();          // no confidence given
    expect(patch.confidence).toBe(0.5);              // applied default when category is usable
  });
});

describe('toAiClassifyItem — low-PII payload', () => {
  it('prefers raw_description and truncates', () => {
    const item = toAiClassifyItem(tx({ amount: -9.5, raw_description: 'SQ *BLUE BOTTLE COFFEE 0417', merchant: 'Blue Bottle' }));
    expect(item).toMatchObject({ description: 'SQ *BLUE BOTTLE COFFEE 0417', merchant: 'Blue Bottle', amount: -9.5 });
  });
});
