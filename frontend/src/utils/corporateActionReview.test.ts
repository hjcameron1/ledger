/**
 * The question, and what it costs — the part of a corporate action a person can
 * actually answer.
 *
 * Nothing here decides whether an event was a split; the server has already
 * refused to. What is tested is that the refusal reaches somebody in terms they
 * can act on: which holding, what the feed said, what the count would become,
 * and how far out the holding is if the answer is yes and nobody says so.
 */
import { describe, it, expect } from 'vitest';
import {
  pendingQuestions, applyRatio, actionTerms, markResolved, resolveOn,
} from './corporateActionReview';
import type { Investment, PendingCorporateAction } from '../types';

const action = (over: Partial<PendingCorporateAction> = {}): PendingCorporateAction => ({
  id: 'act-1', date: '2012-11-26', numerator: 77, denominator: 100, ratio: 0.77,
  seen_at: '2012-11-27T00:00:00.000Z', resolved: null, resolved_at: null, ...over,
});

const holding = (over: Partial<Investment> = {}): Investment => ({
  id: 'inv-1', user_id: 'u1', name: 'ASML', ticker: 'ASML',
  market: 'Euronext Amsterdam', asset_type: 'stock',
  shares_owned: 1_000, cost_basis: 30_000, current_price: 41.5, current_value: 41_500,
  currency: 'EUR', native_currency: 'EUR', is_dividend_paying: false,
  ...over,
} as Investment);

describe('what the holder is asked', () => {
  it('names the holding, the terms and both unit counts', () => {
    const [q] = pendingQuestions([holding({ pending_corporate_actions: [action()] })], 'u1');
    expect(q.investmentId).toBe('inv-1');
    expect(q.ticker).toBe('ASML');
    expect(q.terms).toBe('77 for 100');
    expect(q.unitsNow).toBe(1_000);
    expect(q.unitsIfApplied).toBe(770);
  });

  /**
   * The number that makes the question answerable. A holding whose price moved
   * by the ratio and whose count did not is out by the ratio's reciprocal —
   * Vodafone's 6-for-11 leaves it 83% too high — and that, not the ratio, is
   * what a person can recognise as right or wrong.
   */
  it('says how far out the holding is if the answer is yes', () => {
    const vod = action({ numerator: 6, denominator: 11, ratio: 6 / 11 });
    const [q] = pendingQuestions([holding({ shares_owned: 4_400, pending_corporate_actions: [vod] })], 'u1');
    expect(q.terms).toBe('6 for 11');
    expect(q.unitsIfApplied).toBe(2_400);
    expect(q.overstatement).toBeCloseTo(0.8333, 4);
  });

  it('and reads a bonus issue the other way round', () => {
    const bonus = action({ numerator: 11, denominator: 10, ratio: 1.1 });
    const [q] = pendingQuestions([holding({ pending_corporate_actions: [bonus] })], 'u1');
    expect(q.unitsIfApplied).toBe(1_100);
    // The count is too LOW, so the overstatement is negative.
    expect(q.overstatement).toBeCloseTo(-0.0909, 4);
  });

  it('does not try to make an announcement out of a price factor', () => {
    // "1281 for 1000" is not a sentence anybody would recognise.
    expect(actionTerms({ numerator: 1281, denominator: 1000, ratio: 1.281 })).toBe('1.281×');
    expect(actionTerms({ numerator: 1.0299, denominator: 1, ratio: 1.0299 })).toBe('1.0299×');
    expect(actionTerms({ numerator: 4, denominator: 5, ratio: 0.8 })).toBe('4 for 5');
  });
});

describe('what is not asked about', () => {
  it('an answered question, however it was answered', () => {
    for (const resolved of ['applied', 'ignored'] as const) {
      const inv = holding({ pending_corporate_actions: [action({ resolved })] });
      expect(pendingQuestions([inv], 'u1')).toEqual([]);
    }
  });

  it('somebody else\'s holding, shared into a household', () => {
    const theirs = holding({ user_id: 'u2', pending_corporate_actions: [action()] });
    expect(pendingQuestions([theirs], 'u1')).toEqual([]);
    // …and with no owner in hand, everything visible is asked about.
    expect(pendingQuestions([theirs]).length).toBe(1);
  });

  it('a holding with nothing in it — the answer could not change anything', () => {
    const empty = holding({ shares_owned: 0, pending_corporate_actions: [action()] });
    expect(pendingQuestions([empty], 'u1')).toEqual([]);
  });

  it('a ratio that moves nothing, or is not a ratio', () => {
    for (const ratio of [1, 0, -2, NaN]) {
      const inv = holding({ pending_corporate_actions: [action({ ratio })] });
      expect(pendingQuestions([inv], 'u1'), String(ratio)).toEqual([]);
    }
  });

  it('a holding the server has never written to', () => {
    expect(pendingQuestions([holding()], 'u1')).toEqual([]);
    expect(pendingQuestions([holding({ pending_corporate_actions: null })], 'u1')).toEqual([]);
    // Anything that is not a list is not a question either.
    expect(pendingQuestions([holding({ pending_corporate_actions: 'oops' as never })], 'u1')).toEqual([]);
  });
});

describe('answering one', () => {
  it('marks the entry and keeps it — which is what stops it being asked again', () => {
    const list = [action({ id: 'a' }), action({ id: 'b', date: '2014-02-24' })];
    const next = markResolved(list, 'a', 'ignored', '2026-08-30T00:00:00.000Z');
    expect(next).toHaveLength(2);
    expect(next[0].resolved).toBe('ignored');
    expect(next[0].resolved_at).toBe('2026-08-30T00:00:00.000Z');
    expect(next[1].resolved).toBe(null);        // untouched
    // The original list is not mutated — the store holds it.
    expect(list[0].resolved).toBe(null);
  });

  it('reads the list off the holding, whatever shape it is in', () => {
    const inv = holding({ pending_corporate_actions: [action()] });
    expect(resolveOn(inv, 'act-1', 'applied', 'now')[0].resolved).toBe('applied');
    expect(resolveOn(holding(), 'act-1', 'applied', 'now')).toEqual([]);
  });

  it('scales the units the way the server does, to eight places', () => {
    expect(applyRatio(4_400, 6 / 11)).toBe(2_400);
    expect(applyRatio(1_000, 0.77)).toBe(770);
    expect(applyRatio(1_234, 0.1)).toBe(123.4);
    expect(applyRatio(300, 1 / 3)).toBe(100);
  });
});

describe('more than one, and the order they are asked in', () => {
  it('newest event first, across every holding', () => {
    const asml = holding({ id: 'a', pending_corporate_actions: [action({ id: '1' })] });
    const vod = holding({
      id: 'v', name: 'Vodafone', ticker: 'VOD',
      pending_corporate_actions: [
        action({ id: '2', date: '2014-02-24' }),
        action({ id: '3', date: '2006-07-31' }),
      ],
    });
    const qs = pendingQuestions([asml, vod], 'u1');
    expect(qs.map(q => q.action.date)).toEqual(['2014-02-24', '2012-11-26', '2006-07-31']);
  });
});
