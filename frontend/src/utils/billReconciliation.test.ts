import { describe, it, expect } from 'vitest';
import {
  nameSignal, amountSignal, cadenceSignal, normaliseFrequency,
  scoreBillSubscriptionMatch, findReconciliationCandidates,
  differentDecisionKey, preferredCanonicalName,
  type ReconBill, type ReconSubscription,
} from './billReconciliation';

function bill(p: Partial<ReconBill> & { name: string; amount: number }): ReconBill {
  return {
    id: p.id ?? `b-${p.name}`,
    frequency: 'monthly', is_recurring: true, kind: 'bill', is_paid: false,
    ...p,
  };
}
function sub(p: Partial<ReconSubscription> & { name: string; amount: number }): ReconSubscription {
  return { id: p.id ?? `s-${p.name}`, frequency: 'monthly', ...p };
}

describe('signal primitives', () => {
  it('normaliseFrequency folds synonyms', () => {
    expect(normaliseFrequency('fortnightly')).toBe(normaliseFrequency('biweekly'));
    expect(normaliseFrequency('Yearly')).toBe('annually');
    expect(normaliseFrequency(null)).toBeNull();
  });

  it('nameSignal: exact normalised match = 1, suffix is strong, unrelated ~0', () => {
    expect(nameSignal(bill({ name: 'Netflix', amount: 18.99 }), sub({ name: 'Netflix', amount: 18.99 }))).toBe(1);
    expect(nameSignal(bill({ name: 'NETFLIX.COM', amount: 18.99 }), sub({ name: 'Netflix', amount: 18.99 }))).toBeGreaterThanOrEqual(0.8);
    expect(nameSignal(bill({ name: 'Optus', amount: 50 }), sub({ name: 'Optus Mobile', amount: 50 }))).toBeGreaterThanOrEqual(0.8);
    expect(nameSignal(bill({ name: 'Netflix', amount: 18.99 }), sub({ name: 'Spotify', amount: 18.99 }))).toBeLessThan(0.5);
  });

  it('amountSignal: within tolerance = 1, decays, far apart = 0', () => {
    expect(amountSignal(18.99, 18.99)).toBe(1);
    expect(amountSignal(50, 80)).toBe(0);        // 37% gap
    expect(amountSignal(100, 103)).toBeGreaterThan(0.8); // 3% gap
  });

  it('cadenceSignal: match=1, mismatch=0, unknown=neutral', () => {
    expect(cadenceSignal('monthly', 'monthly')).toBe(1);
    expect(cadenceSignal('weekly', 'monthly')).toBe(0);
    expect(cadenceSignal(null, 'monthly')).toBe(0.5);
  });
});

describe('scoreBillSubscriptionMatch', () => {
  it('same name + amount + cadence + account → "same"', () => {
    const r = scoreBillSubscriptionMatch(
      bill({ name: 'Netflix', amount: 18.99 }),
      sub({ name: 'Netflix', amount: 18.99 }),
      { sameAccount: true },
    );
    expect(r.verdict).toBe('same');
    expect(r.score).toBeGreaterThan(0.85);
  });

  it('never links on amount/date alone — different merchants, same amount → "none"', () => {
    const r = scoreBillSubscriptionMatch(
      bill({ name: 'Netflix', amount: 18.99 }),
      sub({ name: 'Spotify', amount: 18.99 }),
      { sameAccount: true },
    );
    expect(r.verdict).toBe('none');
  });

  it('name matches but no corroboration (amount far + cadence differs) → "none"', () => {
    const r = scoreBillSubscriptionMatch(
      bill({ name: 'Netflix', amount: 18.99, frequency: 'monthly' }),
      sub({ name: 'Netflix', amount: 80, frequency: 'weekly' }),
      { sameAccount: false },
    );
    expect(r.verdict).toBe('none');
  });

  it('identical family bills (same name/cadence, different amount) → "possible", not "same"', () => {
    const sameAcct = scoreBillSubscriptionMatch(
      bill({ name: 'Optus Mobile', amount: 50 }),
      sub({ name: 'Optus Mobile', amount: 80 }),
      { sameAccount: true },
    );
    expect(sameAcct.verdict).toBe('possible'); // ambiguous — user decides, never auto-collapsed

    // On clearly different accounts the evidence is too weak to even suggest.
    const diffAcct = scoreBillSubscriptionMatch(
      bill({ name: 'Optus Mobile', amount: 50 }),
      sub({ name: 'Optus Mobile', amount: 80 }),
      { sameAccount: false },
    );
    expect(diffAcct.verdict).toBe('none');
  });

  it('true duplicate with a small price drift still reads as same/possible', () => {
    const r = scoreBillSubscriptionMatch(
      bill({ name: 'Spotify', amount: 11.99 }),
      sub({ name: 'Spotify Premium', amount: 12.49 }),
      { sameAccount: true },
    );
    expect(['same', 'possible']).toContain(r.verdict);
  });

  it('matches through a renamed record via original_name anchor', () => {
    const r = scoreBillSubscriptionMatch(
      bill({ name: 'My streaming', original_name: 'NETFLIX.COM', amount: 18.99 }),
      sub({ name: 'Netflix', amount: 18.99 }),
      { sameAccount: null },
    );
    expect(['same', 'possible']).toContain(r.verdict);
  });
});

describe('findReconciliationCandidates', () => {
  const bills = [
    bill({ id: 'b1', name: 'Netflix', amount: 18.99 }),
    bill({ id: 'b2', name: 'Optus Mobile', amount: 50 }),
    bill({ id: 'b3', name: 'Council rates', amount: 400, subscription_id: 's-linked' }), // already linked
    bill({ id: 'b4', name: 'Reminder only', amount: 0, kind: 'reminder' }),
    bill({ id: 'b5', name: 'Netflix', amount: 18.99, is_paid: true }),                    // paid
  ];
  const subs = [
    sub({ id: 's1', name: 'Netflix', amount: 18.99 }),
    sub({ id: 's2', name: 'Optus Mobile', amount: 80 }),
  ];

  it('proposes best match per unlinked, unpaid, non-reminder bill', () => {
    const cands = findReconciliationCandidates(bills, subs, { sameAccount: () => true });
    const byBill = new Map(cands.map(c => [c.bill.id, c]));
    expect(byBill.has('b1')).toBe(true);
    expect(byBill.get('b1')!.subscription.id).toBe('s1');
    expect(byBill.get('b1')!.result.verdict).toBe('same');
    expect(byBill.has('b2')).toBe(true); // family-plan ambiguity surfaces as "possible"
    expect(byBill.has('b3')).toBe(false); // linked
    expect(byBill.has('b4')).toBe(false); // reminder
    expect(byBill.has('b5')).toBe(false); // paid
  });

  it('excludes pairs the user marked "Different bills" (persisted decision)', () => {
    const isDifferent = (b: ReconBill, s: ReconSubscription) =>
      b.id === 'b2' && s.id === 's2';
    const cands = findReconciliationCandidates(bills, subs, { sameAccount: () => true, isDifferent });
    expect(cands.some(c => c.bill.id === 'b2')).toBe(false);
    expect(cands.some(c => c.bill.id === 'b1')).toBe(true); // unaffected
  });

  it('sorts strongest candidate first', () => {
    const cands = findReconciliationCandidates(bills, subs, { sameAccount: () => true });
    for (let i = 1; i < cands.length; i++) {
      expect(cands[i - 1].result.score).toBeGreaterThanOrEqual(cands[i].result.score);
    }
  });
});

describe('differentDecisionKey — stable across id churn and renames', () => {
  it('same anchors ⇒ same key even after rename / new occurrence id', () => {
    const k1 = differentDecisionKey(
      bill({ id: 'b-old', name: 'NETFLIX.COM', amount: 18.99 }),
      sub({ id: 's-old', name: 'Netflix', amount: 18.99 }),
    );
    const k2 = differentDecisionKey(
      bill({ id: 'b-new', name: 'My Netflix', original_name: 'NETFLIX.COM', amount: 18.99 }),
      sub({ id: 's-new', name: 'Netflix (shared)', original_name: 'Netflix', amount: 18.99 }),
    );
    expect(k1).toBe(k2);
  });
});

describe('preferredCanonicalName — never clobber a user-edited name', () => {
  it('prefers the renamed side; subscription wins ties', () => {
    // Bill was renamed (has original_name), subscription is raw.
    expect(preferredCanonicalName(
      bill({ name: 'My Netflix', original_name: 'NETFLIX.COM', amount: 18.99 }),
      sub({ name: 'NETFLIX', amount: 18.99 }),
    )).toBe('My Netflix');

    // Subscription was renamed → it wins.
    expect(preferredCanonicalName(
      bill({ name: 'NETFLIX.COM', amount: 18.99 }),
      sub({ name: 'Netflix', original_name: 'NETFLIX', amount: 18.99 }),
    )).toBe('Netflix');

    // Neither renamed → subscription (merchant record) wins.
    expect(preferredCanonicalName(
      bill({ name: 'NETFLIX.COM', amount: 18.99 }),
      sub({ name: 'Netflix', amount: 18.99 }),
    )).toBe('Netflix');
  });
});
