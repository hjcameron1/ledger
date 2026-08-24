/**
 * Phase 8.2 — the insurance engine.
 *
 * Every figure the app shows about a policy is derived here, so these tests are
 * where "what does this cost a year", "has cover lapsed" and "did the premium
 * move" are actually pinned. The alerts and insights suites then test what is
 * said ABOUT these figures, never the figures themselves.
 */

import { describe, it, expect } from 'vitest';
import {
  buildInsuranceReport, annualPremiumOf, daysBetween, sortLines, filterPolicies,
  policyTypeLabel, DEFAULT_INSURANCE_THRESHOLDS,
  type InsurancePolicyInput, type PremiumRecordInput,
} from './insurance';

const TODAY = '2026-08-24';

let seq = 0;
function policy(p: Partial<InsurancePolicyInput> = {}): InsurancePolicyInput {
  seq += 1;
  return {
    id: p.id ?? `p${seq}`,
    name: p.name ?? 'House',
    policy_type: p.policy_type ?? 'home',
    insurer: 'NRMA',
    premium_amount: 1200,
    premium_frequency: 'annually',
    renewal_date: '2026-12-01',
    active: true,
    ...p,
  };
}

let hseq = 0;
const price = (
  policyId: string, amount: number, date: string,
  frequency: PremiumRecordInput['premium_frequency'] = 'annually',
): PremiumRecordInput => ({
  id: `h${++hseq}`, policy_id: policyId, premium_amount: amount,
  premium_frequency: frequency, effective_date: date,
});

const report = (
  policies: InsurancePolicyInput[], premiumHistory: PremiumRecordInput[] = [],
) => buildInsuranceReport({ asOf: TODAY, policies, premiumHistory });

const line = (r: ReturnType<typeof report>, id: string) => r.lines.find(l => l.id === id)!;

// ═════════════════════════════════════════════════════════════════════════════
//  What cover costs
// ═════════════════════════════════════════════════════════════════════════════
describe('annualising a premium', () => {
  it('uses the app\'s one piece of cadence arithmetic', () => {
    // The same multipliers the forecast and recurring engines use, so a
    // fortnightly premium is the same number of dollars a year everywhere.
    expect(annualPremiumOf(1200, 'annually')).toBe(1200);
    expect(annualPremiumOf(100, 'monthly')).toBe(1200);
    expect(annualPremiumOf(300, 'quarterly')).toBe(1200);
    expect(annualPremiumOf(50, 'fortnightly')).toBeCloseTo(1304.46, 1);
    expect(annualPremiumOf(25, 'weekly')).toBeCloseTo(1304.46, 1);
  });

  it('totals only cover the user still holds', () => {
    const r = report([
      policy({ id: 'a', premium_amount: 1200, premium_frequency: 'annually' }),
      policy({ id: 'b', premium_amount: 100, premium_frequency: 'monthly' }),
      policy({ id: 'c', premium_amount: 900, active: false }),
    ]);
    expect(r.totalAnnualPremium).toBe(2400);
    expect(r.totalMonthlyPremium).toBe(200);
    expect(r.held.map(l => l.id).sort()).toEqual(['a', 'b']);
    expect(r.inactive.map(l => l.id)).toEqual(['c']);
  });

  it('counts an EXPIRED policy in the totals — it is still cover you think you have', () => {
    const r = report([policy({ id: 'a', renewal_date: '2026-01-01', premium_amount: 800 })]);
    expect(r.expired.map(l => l.id)).toEqual(['a']);
    expect(r.totalAnnualPremium).toBe(800);
  });

  it('sums the sum insured without ever calling it an asset', () => {
    const r = report([
      policy({ id: 'a', coverage_amount: 900_000 }),
      policy({ id: 'b', coverage_amount: 100_000 }),
      policy({ id: 'c' }), // no figure stated — contributes nothing, not zero-by-guess
    ]);
    expect(r.totalCoverage).toBe(1_000_000);
  });

  it('groups spend by type, dearest first', () => {
    const r = report([
      policy({ id: 'a', policy_type: 'car', premium_amount: 600 }),
      policy({ id: 'b', policy_type: 'home', premium_amount: 1800 }),
      policy({ id: 'c', policy_type: 'car', premium_amount: 400 }),
    ]);
    expect(r.byType.map(t => [t.type, t.count, t.annualPremium]))
      .toEqual([['car', 2, 1000], ['home', 1, 1800]].sort((x, y) => (y[2] as number) - (x[2] as number)));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Renewal and expiry
// ═════════════════════════════════════════════════════════════════════════════
describe('where a policy stands', () => {
  it('counts days to renewal in whole UTC days', () => {
    expect(daysBetween(TODAY, '2026-08-31')).toBe(7);
    expect(daysBetween(TODAY, TODAY)).toBe(0);
    expect(daysBetween(TODAY, '2026-08-01')).toBe(-23);
    expect(daysBetween(TODAY, 'not-a-date')).toBeNull();
  });

  it('is active while the renewal is comfortably away', () => {
    const r = report([policy({ id: 'a', renewal_date: '2026-12-01' })]);
    expect(line(r, 'a').status).toBe('active');
    expect(line(r, 'a').expired).toBe(false);
  });

  it('is due-soon inside the reminder window, boundary included', () => {
    const soon = DEFAULT_INSURANCE_THRESHOLDS.renewalSoonDays; // 30
    const r = report([
      policy({ id: 'edge', renewal_date: '2026-09-23' }),   // exactly 30 days
      policy({ id: 'outside', renewal_date: '2026-09-24' }), // 31
    ]);
    expect(daysBetween(TODAY, '2026-09-23')).toBe(soon);
    expect(line(r, 'edge').status).toBe('due-soon');
    expect(line(r, 'outside').status).toBe('active');
  });

  it('renewing TODAY has not expired yet — cover runs to the end of the day', () => {
    const r = report([policy({ id: 'a', renewal_date: TODAY })]);
    expect(line(r, 'a').daysToRenewal).toBe(0);
    expect(line(r, 'a').status).toBe('due-soon');
    expect(line(r, 'a').expired).toBe(false);
  });

  it('is expired the day after the renewal date passes', () => {
    const r = report([policy({ id: 'a', renewal_date: '2026-08-23' })]);
    expect(line(r, 'a').daysToRenewal).toBe(-1);
    expect(line(r, 'a').status).toBe('expired');
    expect(line(r, 'a').expired).toBe(true);
  });

  it('cannot expire without a renewal date — life cover often has none', () => {
    const r = report([policy({ id: 'a', renewal_date: null })]);
    expect(line(r, 'a').daysToRenewal).toBeNull();
    expect(line(r, 'a').status).toBe('active');
    expect(line(r, 'a').expired).toBe(false);
  });

  it('cover the user no longer holds is inactive, whatever its dates say', () => {
    const r = report([policy({ id: 'a', renewal_date: '2020-01-01', active: false })]);
    expect(line(r, 'a').status).toBe('inactive');
    // …and it is NOT reported as expired: you cannot lapse out of cover you
    // already told us you don't have.
    expect(line(r, 'a').expired).toBe(false);
    expect(r.expired).toEqual([]);
  });

  it('names the next renewal, skipping anything already lapsed', () => {
    const r = report([
      policy({ id: 'late', name: 'Car', renewal_date: '2026-07-01' }),
      policy({ id: 'next', name: 'House', renewal_date: '2026-09-10' }),
      policy({ id: 'later', name: 'Health', renewal_date: '2027-02-02' }),
    ]);
    expect(r.nextRenewal?.id).toBe('next');
  });

  it('sorts lapsed first, then soonest, with inactive at the bottom', () => {
    const r = report([
      policy({ id: 'far', renewal_date: '2027-01-01' }),
      policy({ id: 'gone', active: false, renewal_date: '2026-08-25' }),
      policy({ id: 'lapsed', renewal_date: '2026-08-01' }),
      policy({ id: 'soon', renewal_date: '2026-09-01' }),
      policy({ id: 'undated', renewal_date: null }),
    ]);
    expect(r.lines.map(l => l.id)).toEqual(['lapsed', 'soon', 'far', 'undated', 'gone']);
  });

  it('sortLines is stable on name when two policies share a date', () => {
    const r = report([
      policy({ id: 'b', name: 'Zulu', renewal_date: '2026-09-01' }),
      policy({ id: 'a', name: 'Alpha', renewal_date: '2026-09-01' }),
    ]);
    expect(sortLines(r.lines).map(l => l.name)).toEqual(['Alpha', 'Zulu']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  What the premium has done
// ═════════════════════════════════════════════════════════════════════════════
describe('premium changes', () => {
  it('says nothing when the price has never moved', () => {
    const r = report(
      [policy({ id: 'a', premium_amount: 1200 })],
      [price('a', 1200, '2025-12-01')],
    );
    expect(line(r, 'a').premiumChange).toBeNull();
  });

  it('reports the latest movement, annualised', () => {
    const r = report(
      [policy({ id: 'a', premium_amount: 1440 })],
      [price('a', 1200, '2024-12-01'), price('a', 1440, '2025-12-01')],
    );
    const change = line(r, 'a').premiumChange!;
    expect(change.previousAnnual).toBe(1200);
    expect(change.annual).toBe(1440);
    expect(change.delta).toBe(240);
    expect(change.percent).toBe(20);
    expect(change.date).toBe('2025-12-01');
    expect(change.frequencyChanged).toBe(false);
  });

  it('reports a fall as readily as a rise', () => {
    const r = report(
      [policy({ id: 'a', premium_amount: 900 })],
      [price('a', 1200, '2024-12-01'), price('a', 900, '2025-12-01')],
    );
    expect(line(r, 'a').premiumChange!.delta).toBe(-300);
    expect(line(r, 'a').premiumChange!.percent).toBe(-25);
  });

  it('compares yearly cost across a change of billing cadence', () => {
    // $120 a month → $1,300 a year is $140 a year CHEAPER, even though the
    // billed figure went up tenfold. Comparing billed amounts would call this a
    // 983% rise.
    const r = report(
      [policy({ id: 'a', premium_amount: 1300, premium_frequency: 'annually' })],
      [price('a', 120, '2025-01-01', 'monthly')],
    );
    const change = line(r, 'a').premiumChange!;
    expect(change.previousAnnual).toBe(1440);
    expect(change.annual).toBe(1300);
    expect(change.delta).toBe(-140);
    expect(change.frequencyChanged).toBe(true);
  });

  it('is not a change when a cadence switch costs exactly the same', () => {
    const r = report(
      [policy({ id: 'a', premium_amount: 100, premium_frequency: 'monthly' })],
      [price('a', 1200, '2025-01-01', 'annually')],
    );
    expect(line(r, 'a').premiumChange).toBeNull();
  });

  it('trusts the POLICY over stale history, rather than reporting last year\'s price', () => {
    // History says $1,200; the policy now says $1,500 (edited on a device that
    // never wrote a record). The current price wins and the move is reported.
    const r = report(
      [policy({ id: 'a', premium_amount: 1500 })],
      [price('a', 1200, '2025-12-01')],
    );
    const change = line(r, 'a').premiumChange!;
    expect(change.annual).toBe(1500);
    expect(change.previousAnnual).toBe(1200);
    expect(change.date).toBe(TODAY);
  });

  it('reads only its OWN policy\'s history', () => {
    const r = report(
      [policy({ id: 'a', premium_amount: 1200 }), policy({ id: 'b', premium_amount: 800 })],
      [price('b', 400, '2025-01-01'), price('a', 1200, '2025-01-01')],
    );
    expect(line(r, 'a').premiumChange).toBeNull();
    expect(line(r, 'b').premiumChange!.delta).toBe(400);
  });

  it('has nothing to compare with a single record', () => {
    const r = report(
      [policy({ id: 'a', premium_amount: 1200 })],
      [price('a', 1200, '2025-12-01')],
    );
    expect(line(r, 'a').premiumChange).toBeNull();
  });

  it('handles a policy with no history at all', () => {
    const r = report([policy({ id: 'a', premium_amount: 1200 })]);
    expect(line(r, 'a').premiumChange).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Odds and ends the UI leans on
// ═════════════════════════════════════════════════════════════════════════════
describe('presentation helpers', () => {
  it('an empty vault of policies reports zeroes, not NaN', () => {
    const r = report([]);
    expect(r.totalAnnualPremium).toBe(0);
    expect(r.totalMonthlyPremium).toBe(0);
    expect(r.totalCoverage).toBe(0);
    expect(r.nextRenewal).toBeNull();
    expect(r.byType).toEqual([]);
  });

  it('a policy with no premium is a policy, not a divide by zero', () => {
    const r = report([policy({ id: 'a', premium_amount: 0 })]);
    expect(line(r, 'a').annualPremium).toBe(0);
    expect(line(r, 'a').premiumChange).toBeNull();
  });

  it('filters on the things a person actually remembers', () => {
    const r = report([
      policy({ id: 'a', name: 'House', insurer: 'NRMA', policy_type: 'home', policy_number: 'H-99' }),
      policy({ id: 'b', name: 'Corolla', insurer: 'AAMI', policy_type: 'car', policy_number: 'C-11' }),
    ]);
    expect(filterPolicies(r.lines, 'all', 'aami').map(l => l.id)).toEqual(['b']);
    expect(filterPolicies(r.lines, 'all', 'H-99').map(l => l.id)).toEqual(['a']);
    expect(filterPolicies(r.lines, 'car', '').map(l => l.id)).toEqual(['b']);
    // The words of the TYPE count as searchable text too.
    expect(filterPolicies(r.lines, 'all', 'vehicle').map(l => l.id)).toEqual(['b']);
    expect(filterPolicies(r.lines, 'home', 'aami')).toEqual([]);
  });

  it('names every type it accepts, and falls back rather than throwing', () => {
    expect(policyTypeLabel('income_protection')).toBe('Income protection');
    expect(policyTypeLabel('nonsense')).toBe('Other');
  });

  it('carries the link and the document through untouched — they are not its business', () => {
    const r = report([policy({
      id: 'a', linked_type: 'property', linked_id: 'prop-1', document_id: 'doc-1',
    })]);
    expect(line(r, 'a').linkedType).toBe('property');
    expect(line(r, 'a').linkedId).toBe('prop-1');
    expect(line(r, 'a').documentId).toBe('doc-1');
  });
});
