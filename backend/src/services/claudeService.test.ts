import { describe, it, expect } from 'vitest';
import { sanitizeAiClassifications } from './claudeService';

const CATS = ['Groceries', 'Dining', 'Transport', 'Uncategorised'];

describe('sanitizeAiClassifications — Phase 2D.3 AI fallback output guard', () => {
  it('keeps only requested ids and coerces category to the allowed list', () => {
    const raw = {
      results: [
        { id: 'a', category: 'groceries', merchant: 'Woolworths', transaction_type: 'purchase', reason: 'Supermarket', confidence: 0.8 },
        { id: 'ghost', category: 'Dining', confidence: 0.9 },       // not requested → dropped
        { id: 'b', category: 'Made Up Category', confidence: 0.5 }, // unknown cat → null (never invented)
      ],
    };
    const out = sanitizeAiClassifications(raw, ['a', 'b'], CATS);
    expect(out.map(r => r.id)).toEqual(['a', 'b']);
    expect(out[0]).toMatchObject({ category: 'Groceries', merchant: 'Woolworths', transaction_type: 'purchase', confidence: 0.8 });
    expect(out[1].category).toBeNull();
  });

  it('clamps confidence and normalises an unknown transaction_type to null', () => {
    const out = sanitizeAiClassifications(
      { results: [{ id: 'a', category: 'Dining', transaction_type: 'bogus', confidence: 5 }] },
      ['a'], CATS,
    );
    expect(out[0].confidence).toBe(1);
    expect(out[0].transaction_type).toBeNull();
  });

  it('accepts a bare array and dedupes repeated ids', () => {
    const out = sanitizeAiClassifications(
      [{ id: 'a', category: 'Transport' }, { id: 'a', category: 'Dining' }],
      ['a'], CATS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].category).toBe('Transport');
  });

  it('returns [] on garbage input', () => {
    expect(sanitizeAiClassifications(null, ['a'], CATS)).toEqual([]);
    expect(sanitizeAiClassifications({ nope: true }, ['a'], CATS)).toEqual([]);
  });
});
