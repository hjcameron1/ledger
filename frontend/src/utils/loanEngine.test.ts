/**
 * Phase 4.2 — the mortgage/debt engine, unit-tested.
 *
 * The things these tests exist to hold down:
 *
 *   • a repayment splits into interest and principal the way a lender splits it,
 *     so a partial payment reduces the debt by less and doesn't pretend the
 *     period is paid;
 *   • an offset reduces the INTEREST and never the debt — the money is already
 *     an asset in the user's bank account, so netting it off the loan as well
 *     would count it twice;
 *   • an extra repayment builds redraw, a redraw is re-borrowing, and neither
 *     can be talked into inventing money;
 *   • a variable rate — a scheduled change, or a fixed period reverting —
 *     actually changes the interest charged from that date onwards;
 *   • a projection and a "what if I paid more" answer come from the SAME
 *     amortisation, so they can never disagree;
 *   • a property-linked mortgage is the same loan, reported once.
 */

import { describe, it, expect } from 'vitest';
import type { Loan, LoanEvent, Property } from '../types';
import {
  PERIODS_PER_YEAR, addPeriods, monthsBetween, formatTerm, rateAt, loanRateSteps,
  projectLoan, requiredRepayment, repaymentImpact, summarise,
  applyExtraRepayment, applyRedraw, applyRepayment, redrawLimit, offsetBalanceFor,
  buildLoanReport, contractedRemainingMonths, projectionInputForLoan, perMonth,
  validateMovement, isIndexed,
} from './loanEngine';

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'l1', user_id: 'u1', name: 'Home mortgage', loan_type: 'mortgage',
  original_amount: 600_000, current_balance: 500_000,
  interest_rate: 6, minimum_repayment: 3_000, repayment_frequency: 'monthly',
  next_due_date: '2026-09-01', include_in_net_worth: true, ...o,
} as Loan);

const event = (o: Partial<LoanEvent> = {}): LoanEvent => ({
  id: 'e1', user_id: 'u1', loan_id: 'l1', kind: 'repayment',
  amount: 0, date: '2026-08-01', ...o,
});

const property = (o: Partial<Property> = {}): Property => ({
  id: 'p1', user_id: 'u1', name: 'Bondi apartment',
  address_street: '34 Beach Rd', address_suburb: 'Bondi', address_state: 'NSW',
  address_postcode: '2026', address_country: 'Australia',
  property_type: 'home', held_by: 'personal',
  purchase_price: 800_000, current_value: 1_000_000, ownership_percent: 100,
  loan_id: null, include_in_net_worth: true, ...o,
} as Property);

const TODAY = '2026-08-17';

// ═══════════════════════════════════════════════════════════════════════════════
describe('dates', () => {
  it('advances weekly and fortnightly by whole days', () => {
    expect(addPeriods('2026-08-17', 'weekly', 1)).toBe('2026-08-24');
    expect(addPeriods('2026-08-17', 'fortnightly', 2)).toBe('2026-09-14');
  });

  it('advances monthly by calendar months', () => {
    expect(addPeriods('2026-08-17', 'monthly', 1)).toBe('2026-09-17');
    expect(addPeriods('2026-08-17', 'monthly', 12)).toBe('2027-08-17');
  });

  it('clamps a month step to the end of a short month', () => {
    // The 31st plus one month is the 28th, not the 3rd of March. Left to drift,
    // a loan due on the 31st would gain days every short month.
    expect(addPeriods('2026-01-31', 'monthly', 1)).toBe('2026-02-28');
    expect(addPeriods('2028-01-31', 'monthly', 1)).toBe('2028-02-29');
    expect(addPeriods('2026-03-31', 'monthly', 1)).toBe('2026-04-30');
  });

  it('does not shift a date across a timezone boundary', () => {
    expect(addPeriods('2026-01-01', 'monthly', 0)).toBe('2026-01-01');
    expect(addPeriods('2026-12-31', 'weekly', 1)).toBe('2027-01-07');
  });

  it('counts whole months between dates', () => {
    expect(monthsBetween('2026-08-17', '2027-08-17')).toBe(12);
    expect(monthsBetween('2026-08-17', '2026-09-16')).toBe(0);
    expect(monthsBetween('2026-08-17', '2026-09-17')).toBe(1);
  });

  it('reports an expired term as negative months', () => {
    expect(monthsBetween('2026-08-17', '2025-08-17')).toBe(-12);
  });

  it('formats a term for a card', () => {
    expect(formatTerm(28)).toBe('2 yrs 4 mos');
    expect(formatTerm(12)).toBe('1 yr');
    expect(formatTerm(1)).toBe('1 mo');
    expect(formatTerm(0)).toBe('Paid off');
    expect(formatTerm(null)).toBe('—');
    expect(formatTerm(-3)).toBe('—');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('rates', () => {
  it('uses the base rate before any step starts', () => {
    expect(rateAt(6, [{ from: '2027-01-01', rate: 8 }], '2026-12-31')).toBe(6);
  });

  it('switches to a step on the day it starts', () => {
    expect(rateAt(6, [{ from: '2027-01-01', rate: 8 }], '2027-01-01')).toBe(8);
  });

  it('takes the latest step that has started, whatever order they arrive in', () => {
    const steps = [{ from: '2028-01-01', rate: 5 }, { from: '2027-01-01', rate: 8 }];
    expect(rateAt(6, steps, '2027-06-01')).toBe(8);
    expect(rateAt(6, steps, '2028-06-01')).toBe(5);
  });

  it('turns a fixed period into a revert step', () => {
    const steps = loanRateSteps(loan({ rate_type: 'fixed', fixed_until: '2028-06-01', revert_rate: 7.4 }));
    expect(steps).toEqual([{ from: '2028-06-01', rate: 7.4 }]);
  });

  it('ignores a fixed period with no revert rate on file', () => {
    expect(loanRateSteps(loan({ rate_type: 'fixed', fixed_until: '2028-06-01' }))).toEqual([]);
  });

  it('reads rate changes off the movement history, soonest first', () => {
    const steps = loanRateSteps(loan({ rate_type: 'variable' }), [
      event({ id: 'e2', kind: 'rate_change', rate: 7.1, date: '2027-03-01' }),
      event({ id: 'e3', kind: 'rate_change', rate: 6.5, date: '2026-11-01' }),
      event({ id: 'e4', kind: 'repayment', amount: 3000, date: '2026-10-01' }),
    ]);
    expect(steps).toEqual([
      { from: '2026-11-01', rate: 6.5 },
      { from: '2027-03-01', rate: 7.1 },
    ]);
  });

  it('treats HECS as indexed rather than interest-bearing', () => {
    expect(isIndexed('hecs')).toBe(true);
    expect(isIndexed('mortgage')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('projectLoan', () => {
  const base = {
    balance: 100_000, annualRate: 6, frequency: 'monthly' as const,
    repayment: 1_000, startDate: '2026-09-01',
  };

  it('splits the first repayment into interest and principal', () => {
    const p = projectLoan(base);
    expect(p.periods[0].interest).toBe(500);   // 100,000 × 6% ÷ 12
    expect(p.periods[0].principal).toBe(500);
    expect(p.periods[0].closingBalance).toBe(99_500);
    expect(p.periods[0].date).toBe('2026-09-01');
  });

  it('charges less interest as the balance falls', () => {
    const p = projectLoan(base);
    expect(p.periods[1].interest).toBeLessThan(p.periods[0].interest);
    expect(p.periods[1].principal).toBeGreaterThan(p.periods[0].principal);
  });

  it('every period pays exactly interest + principal', () => {
    for (const period of projectLoan(base).periods.slice(0, 50)) {
      expect(period.payment).toBeCloseTo(period.interest + period.principal, 2);
      expect(period.closingBalance).toBeCloseTo(period.openingBalance - period.principal, 2);
    }
  });

  it('reaches zero and reports the payoff date', () => {
    const p = projectLoan({ ...base, balance: 3_000, annualRate: 0, repayment: 1_000 });
    expect(p.periods).toHaveLength(3);
    expect(p.payoffDate).toBe('2026-11-01');
    expect(p.finalBalance).toBe(0);
    expect(p.truncated).toBe(false);
  });

  it('trims the final repayment instead of overshooting into credit', () => {
    const p = projectLoan({ ...base, balance: 1_000, annualRate: 0, repayment: 700 });
    expect(p.periods.map(x => x.payment)).toEqual([700, 300]);
    expect(p.totalPaid).toBe(1_000);
    expect(p.finalBalance).toBe(0);
  });

  it('flags a repayment that never covers the interest', () => {
    const p = projectLoan({ ...base, repayment: 400 });
    expect(p.neverPaysOff).toBe(true);
    expect(p.shortfall).toBe(100);          // 500 interest − 400 paid
    expect(p.payoffDate).toBeNull();
    expect(p.monthsToPayoff).toBeNull();
  });

  it('flags a live balance with no repayment at all', () => {
    const p = projectLoan({ ...base, repayment: 0 });
    expect(p.neverPaysOff).toBe(true);
    expect(p.periods).toHaveLength(0);
  });

  it('says nothing is owed when the balance is already zero', () => {
    const p = projectLoan({ ...base, balance: 0 });
    expect(p.periods).toHaveLength(0);
    expect(p.monthsToPayoff).toBe(0);
    expect(p.neverPaysOff).toBe(false);
  });

  it('charges interest only on the balance net of the offset', () => {
    const p = projectLoan({ ...base, offsetBalance: 40_000 });
    expect(p.periods[0].interest).toBe(300);   // 60,000 × 6% ÷ 12
    expect(p.periods[0].principal).toBe(700);
  });

  it('makes a loan interest-free when the offset covers it, without paying the user', () => {
    const p = projectLoan({ ...base, offsetBalance: 200_000 });
    expect(p.periods[0].interest).toBe(0);
    expect(p.periods[0].principal).toBe(1_000);
    expect(p.totalInterest).toBe(0);
    expect(p.periods).toHaveLength(100);       // 100,000 ÷ 1,000, no interest at all
  });

  it('an offset shortens the loan and cuts the interest', () => {
    const without = projectLoan(base);
    const with40k = projectLoan({ ...base, offsetBalance: 40_000 });
    expect(with40k.totalInterest).toBeLessThan(without.totalInterest);
    expect(with40k.periodsToPayoff!).toBeLessThan(without.periodsToPayoff!);
  });

  it('applies a scheduled rate change from its date onwards', () => {
    const p = projectLoan({
      ...base, startDate: '2026-11-01',
      rateSteps: [{ from: '2027-01-01', rate: 12 }],
    });
    expect(p.periods[0].rate).toBe(6);         // Nov
    expect(p.periods[1].rate).toBe(6);         // Dec
    expect(p.periods[2].rate).toBe(12);        // Jan — the change lands
    expect(p.periods[2].interest).toBeCloseTo(p.periods[2].openingBalance * 0.01, 2);
  });

  it('a rate rise costs more interest and takes longer', () => {
    const flat = projectLoan(base);
    const rising = projectLoan({ ...base, rateSteps: [{ from: '2028-09-01', rate: 9 }] });
    expect(rising.totalInterest).toBeGreaterThan(flat.totalInterest);
    expect(rising.periodsToPayoff!).toBeGreaterThan(flat.periodsToPayoff!);
  });

  it('pays nothing off the principal while interest-only', () => {
    const p = projectLoan({ ...base, startDate: '2026-11-01', interestOnlyUntil: '2027-01-01' });
    expect(p.periods[0].interestOnly).toBe(true);
    expect(p.periods[0].principal).toBe(0);
    expect(p.periods[0].closingBalance).toBe(100_000);
    expect(p.periods[0].payment).toBe(500);      // interest only
    expect(p.periods[2].interestOnly).toBe(false);
    expect(p.periods[2].principal).toBeGreaterThan(0);
  });

  it('still lets an extra repayment bite during an interest-only period', () => {
    const p = projectLoan({
      ...base, startDate: '2026-11-01', interestOnlyUntil: '2027-01-01', extraPerPeriod: 250,
    });
    expect(p.periods[0].principal).toBe(250);
    expect(p.periods[0].closingBalance).toBe(99_750);
  });

  it('uses the recalculated repayment once interest-only ends', () => {
    const p = projectLoan({
      ...base, startDate: '2026-11-01', interestOnlyUntil: '2027-01-01',
      repaymentAfterInterestOnly: 2_000,
    });
    expect(p.periods[0].payment).toBe(500);
    expect(p.periods[2].payment).toBe(2_000);
  });

  it('an extra repayment every period pays the loan off sooner', () => {
    const plain = projectLoan(base);
    const extra = projectLoan({ ...base, extraPerPeriod: 300 });
    expect(extra.periodsToPayoff!).toBeLessThan(plain.periodsToPayoff!);
    expect(extra.totalInterest).toBeLessThan(plain.totalInterest);
    expect(extra.periods[0].payment).toBe(1_300);
  });

  it('stops at the cap instead of looping forever, and says so', () => {
    const p = projectLoan({ ...base, balance: 1_000_000, repayment: 5_001, maxPeriods: 12 });
    expect(p.periods).toHaveLength(12);
    expect(p.truncated).toBe(true);
    expect(p.payoffDate).toBeNull();
    expect(p.finalBalance).toBeGreaterThan(0);
  });

  it('converts payoff to months so any frequency compares', () => {
    const monthly = projectLoan({ ...base, frequency: 'monthly', repayment: 1_000 });
    const fortnightly = projectLoan({ ...base, frequency: 'fortnightly', repayment: 500 });
    // 26 half-payments a year is thirteen months of repayments, not twelve — so
    // paying fortnightly really does clear the loan sooner.
    expect(fortnightly.monthsToPayoff!).toBeLessThan(monthly.monthsToPayoff!);
    expect(PERIODS_PER_YEAR.fortnightly).toBe(26);
  });

  it('summarises without the period rows', () => {
    const p = projectLoan(base);
    const sum = summarise(p);
    expect(sum.totalInterest).toBe(p.totalInterest);
    expect(sum.payoffDate).toBe(p.payoffDate);
    expect(Object.keys(sum)).not.toContain('periods');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('requiredRepayment', () => {
  it('matches the standard annuity payment', () => {
    expect(requiredRepayment(100_000, 6, 'monthly', 360)).toBeCloseTo(599.55, 1);
  });

  it('clears the loan in exactly the term it was calculated for', () => {
    const repayment = requiredRepayment(300_000, 5.5, 'monthly', 240);
    const p = projectLoan({
      balance: 300_000, annualRate: 5.5, frequency: 'monthly',
      repayment, startDate: '2026-09-01',
    });
    expect(p.periodsToPayoff).toBe(240);
  });

  it('is a straight division when there is no interest', () => {
    expect(requiredRepayment(12_000, 0, 'monthly', 12)).toBe(1_000);
  });

  it('is zero when there is nothing owed or no term', () => {
    expect(requiredRepayment(0, 6, 'monthly', 360)).toBe(0);
    expect(requiredRepayment(100_000, 6, 'monthly', 0)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('repaymentImpact', () => {
  const input = {
    balance: 500_000, annualRate: 6, frequency: 'monthly' as const,
    repayment: 4_000, startDate: '2026-09-01',
  };

  it('prices paying more each period', () => {
    const impact = repaymentImpact(input, { extraPerPeriod: 500 });
    expect(impact.interestSaved).toBeGreaterThan(0);
    expect(impact.monthsSaved!).toBeGreaterThan(0);
    expect(impact.periodPayment).toBe(4_500);
    expect(impact.periodPaymentDelta).toBe(500);
    expect(impact.comparable).toBe(true);
    expect(impact.scenario.payoffDate! < impact.baseline.payoffDate!).toBe(true);
  });

  it('prices a lump sum without changing the repayment', () => {
    const impact = repaymentImpact(input, { lumpSum: 50_000 });
    expect(impact.interestSaved).toBeGreaterThan(0);
    expect(impact.periodPaymentDelta).toBe(0);
  });

  it('prices moving cash into an offset', () => {
    const impact = repaymentImpact(input, { offsetBalance: 100_000 });
    expect(impact.interestSaved).toBeGreaterThan(0);
    expect(impact.periodPaymentDelta).toBe(0);
  });

  it('prices a rate rise as a cost, not a saving', () => {
    const impact = repaymentImpact(input, { annualRate: 8 });
    expect(impact.comparable).toBe(true);
    expect(impact.interestSaved).toBeLessThan(0);
    expect(impact.monthsSaved!).toBeLessThan(0);
  });

  it('a rate override replaces the whole rate story rather than fighting it', () => {
    const withRevert = { ...input, rateSteps: [{ from: '2028-09-01', rate: 8 }] };
    const impact = repaymentImpact(withRevert, { annualRate: 6 });
    // The scenario is a flat 6%, so it must beat a baseline that reverts to 8%.
    expect(impact.interestSaved).toBeGreaterThan(0);
  });

  it('reports no time saved when a side never pays off', () => {
    const impact = repaymentImpact({ ...input, repayment: 2_000 }, { extraPerPeriod: 100 });
    expect(impact.baseline.neverPaysOff).toBe(true);
    expect(impact.periodsSaved).toBeNull();
    expect(impact.monthsSaved).toBeNull();
  });

  it('refuses to call a stalled projection comparable', () => {
    // The scenario stops covering the interest, so its interest total only runs
    // to the point it gave up — subtracting it would report a rise as a saving.
    const impact = repaymentImpact(input, { annualRate: 12 });
    expect(impact.scenario.neverPaysOff).toBe(true);
    expect(impact.comparable).toBe(false);
  });

  it('adds to any extra already being paid rather than replacing it', () => {
    const impact = repaymentImpact({ ...input, extraPerPeriod: 200 }, { extraPerPeriod: 300 });
    expect(impact.periodPayment).toBe(4_500);
    expect(impact.periodPaymentDelta).toBe(300);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('extra repayments and redraw', () => {
  it('an extra repayment cuts the debt and builds redraw by the same amount', () => {
    const next = applyExtraRepayment({ current_balance: 500_000, redraw_available: 0 }, 10_000);
    expect(next.current_balance).toBe(490_000);
    expect(next.redraw_available).toBe(10_000);
  });

  it('accumulates redraw across several extra repayments', () => {
    let state = { current_balance: 500_000, redraw_available: 2_500 };
    state = applyExtraRepayment(state, 1_000);
    state = applyExtraRepayment(state, 500);
    expect(state).toEqual({ current_balance: 498_500, redraw_available: 4_000 });
  });

  it('never overpays past zero, and never makes the surplus redrawable', () => {
    const next = applyExtraRepayment({ current_balance: 5_000, redraw_available: 0 }, 8_000);
    expect(next.current_balance).toBe(0);
    expect(next.redraw_available).toBe(5_000);   // only what was actually owed
  });

  it('a redraw is re-borrowing: the debt goes back up', () => {
    const next = applyRedraw({ current_balance: 490_000, redraw_available: 10_000 }, 4_000);
    expect(next.current_balance).toBe(494_000);
    expect(next.redraw_available).toBe(6_000);
  });

  it('cannot redraw more than was paid ahead', () => {
    const next = applyRedraw({ current_balance: 490_000, redraw_available: 10_000 }, 999_999);
    expect(next.current_balance).toBe(500_000);
    expect(next.redraw_available).toBe(0);
  });

  it('cannot redraw at all when nothing was paid ahead', () => {
    const next = applyRedraw({ current_balance: 500_000, redraw_available: 0 }, 5_000);
    expect(next).toEqual({ current_balance: 500_000, redraw_available: 0 });
  });

  it('paying extra then redrawing it all leaves the loan exactly where it started', () => {
    const start = { current_balance: 500_000, redraw_available: 0 };
    const after = applyRedraw(applyExtraRepayment(start, 25_000), 25_000);
    expect(after).toEqual(start);
  });

  it('treats a missing redraw figure as nothing available', () => {
    expect(redrawLimit({ redraw_available: null })).toBe(0);
    expect(redrawLimit({ redraw_available: undefined })).toBe(0);
    expect(redrawLimit({ redraw_available: -50 })).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('applyRepayment', () => {
  const l = loan({ current_balance: 100_000, interest_rate: 6, minimum_repayment: 1_000 });

  it('charges the interest first and puts the rest on the principal', () => {
    const split = applyRepayment(l, 1_000);
    expect(split.interest).toBe(500);
    expect(split.principal).toBe(500);
    expect(split.current_balance).toBe(99_500);
    expect(split.meetsSchedule).toBe(true);
    expect(split.surplus).toBe(0);
  });

  it('a partial repayment pays less principal and does not meet the schedule', () => {
    const split = applyRepayment(l, 600);
    expect(split.interest).toBe(500);
    expect(split.principal).toBe(100);
    expect(split.current_balance).toBe(99_900);
    expect(split.meetsSchedule).toBe(false);
  });

  it('a repayment smaller than the interest moves the balance not at all', () => {
    const split = applyRepayment(l, 300);
    expect(split.principal).toBe(0);
    expect(split.current_balance).toBe(100_000);
    expect(split.meetsSchedule).toBe(false);
  });

  it('an overpayment clears the schedule and the surplus becomes redrawable', () => {
    const split = applyRepayment(l, 1_500);
    expect(split.principal).toBe(1_000);
    expect(split.current_balance).toBe(99_000);
    expect(split.surplus).toBe(500);
    expect(split.redraw_available).toBe(500);
    expect(split.meetsSchedule).toBe(true);
  });

  it('charges interest on the balance net of the offset', () => {
    const split = applyRepayment({ ...l, offset_balance: 40_000 }, 1_000);
    expect(split.interest).toBe(300);
    expect(split.principal).toBe(700);
  });

  it('puts the whole payment on an indexed debt, which has no interest', () => {
    const hecs = loan({ loan_type: 'hecs', current_balance: 20_000, interest_rate: 5, minimum_repayment: 500 });
    const split = applyRepayment(hecs, 500);
    expect(split.interest).toBe(0);
    expect(split.principal).toBe(500);
    expect(split.current_balance).toBe(19_500);
  });

  it('behaves as the app did before the engine when no rate is on file', () => {
    const noRate = loan({ current_balance: 10_000, interest_rate: null, minimum_repayment: 400 });
    expect(applyRepayment(noRate, 400).current_balance).toBe(9_600);
  });

  it('never pays past zero', () => {
    const nearlyDone = loan({ current_balance: 200, interest_rate: 0, minimum_repayment: 1_000 });
    const split = applyRepayment(nearlyDone, 1_000);
    expect(split.applied).toBe(200);
    expect(split.current_balance).toBe(0);
  });

  it('scales the interest to the repayment frequency', () => {
    const weekly = loan({ current_balance: 100_000, interest_rate: 5.2, repayment_frequency: 'weekly', minimum_repayment: 500 });
    expect(applyRepayment(weekly, 500).interest).toBe(100);   // 100,000 × 5.2% ÷ 52
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('offsets', () => {
  it('uses the typed figure when no account is linked', () => {
    expect(offsetBalanceFor(loan({ offset_balance: 25_000 }))).toBe(25_000);
  });

  it('reads the linked account\'s live balance instead', () => {
    const l = loan({ offset_balance: 25_000, offset_account_id: 'a1' });
    expect(offsetBalanceFor(l, [{ id: 'a1', balance: 40_000 }])).toBe(40_000);
  });

  it('falls back to the typed figure when the linked account is gone', () => {
    const l = loan({ offset_balance: 25_000, offset_account_id: 'a1' });
    expect(offsetBalanceFor(l, [{ id: 'other', balance: 9 }])).toBe(25_000);
  });

  it('never treats an overdrawn account as a negative offset', () => {
    const l = loan({ offset_account_id: 'a1' });
    expect(offsetBalanceFor(l, [{ id: 'a1', balance: -500 }])).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('contracted term', () => {
  it('counts months to the end date', () => {
    expect(contractedRemainingMonths(loan({ end_date: '2046-08-17' }), TODAY)).toBe(240);
  });

  it('falls back to the term measured from the start date', () => {
    expect(contractedRemainingMonths(loan({ start_date: '2020-08-17', term_months: 360 }), TODAY)).toBe(288);
  });

  it('prefers the end date when both are on file', () => {
    const l = loan({ end_date: '2036-08-17', start_date: '2020-08-17', term_months: 360 });
    expect(contractedRemainingMonths(l, TODAY)).toBe(120);
  });

  it('is unknown when neither is on file', () => {
    expect(contractedRemainingMonths(loan(), TODAY)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('projectionInputForLoan', () => {
  it('starts at the next repayment when one is scheduled', () => {
    const input = projectionInputForLoan(loan({ next_due_date: '2026-09-01' }), [], TODAY);
    expect(input.startDate).toBe('2026-09-01');
  });

  it('starts today when the due date has already passed', () => {
    const input = projectionInputForLoan(loan({ next_due_date: '2020-01-01' }), [], TODAY);
    expect(input.startDate).toBe(TODAY);
  });

  it('carries the offset, extra repayment and rate steps through', () => {
    const input = projectionInputForLoan(
      loan({ offset_balance: 30_000, extra_repayment: 250, rate_type: 'fixed', fixed_until: '2028-01-01', revert_rate: 8 }),
      [], TODAY,
    );
    expect(input.offsetBalance).toBe(30_000);
    expect(input.extraPerPeriod).toBe(250);
    expect(input.rateSteps).toEqual([{ from: '2028-01-01', rate: 8 }]);
  });

  it('zeroes the rate on an indexed debt', () => {
    expect(projectionInputForLoan(loan({ loan_type: 'hecs', interest_rate: 7 }), [], TODAY).annualRate).toBe(0);
  });

  it('ignores an interest-only period that has already ended', () => {
    const input = projectionInputForLoan(loan({ interest_only_until: '2024-01-01' }), [], TODAY);
    expect(input.interestOnlyUntil).toBeNull();
  });

  it('recalculates the repayment for when interest-only ends', () => {
    const l = loan({
      current_balance: 500_000, interest_only_until: '2028-08-17',
      end_date: '2046-08-17', minimum_repayment: 2_500,
    });
    const input = projectionInputForLoan(l, [], TODAY);
    // 18 years of P&I left after the 2-year interest-only period — the lender
    // recalculates, and so does the projection, so the payment shock is visible.
    expect(input.repaymentAfterInterestOnly).toBeCloseTo(requiredRepayment(500_000, 6, 'monthly', 216), 0);
    expect(input.repaymentAfterInterestOnly!).toBeGreaterThan(2_500);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('buildLoanReport', () => {
  it('works out a mortgage end to end', () => {
    const report = buildLoanReport([loan()], [], [], { today: TODAY });
    const row = report.rows[0];
    expect(row.balance).toBe(500_000);
    expect(row.rate).toBe(6);
    expect(row.interestThisPeriod).toBe(2_500);
    expect(row.interestPerYear).toBe(30_000);
    expect(row.repaidPercent).toBeCloseTo(16.67, 1);
    expect(row.payoffDate).not.toBeNull();
    expect(row.monthsToPayoff).toBeGreaterThan(0);
  });

  it('keeps the offset out of the debt and only takes it off the interest', () => {
    const report = buildLoanReport([loan({ offset_balance: 100_000 })], [], [], { today: TODAY });
    const row = report.rows[0];
    expect(row.balance).toBe(500_000);            // the debt is untouched
    expect(row.effectiveBalance).toBe(400_000);   // only the interest sees the offset
    expect(row.interestPerYear).toBe(24_000);
    expect(row.offsetSavingPerYear).toBe(6_000);
    expect(report.totals.netWorthDebt).toBe(500_000);
  });

  it('reads a linked offset account\'s live balance', () => {
    const report = buildLoanReport(
      [loan({ offset_balance: 0, offset_account_id: 'a1' })], [], [],
      { today: TODAY, offsetAccounts: [{ id: 'a1', balance: 75_000 }] },
    );
    expect(report.rows[0].offsetBalance).toBe(75_000);
    expect(report.rows[0].effectiveBalance).toBe(425_000);
    expect(report.rows[0].balance).toBe(500_000);
  });

  it('names the property a mortgage backs without counting it twice', () => {
    const p = property({ loan_id: 'l1' });
    const report = buildLoanReport([loan()], [], [p], { today: TODAY });
    expect(report.rows[0].property).toEqual({ id: 'p1', name: 'Bondi apartment' });
    // One loan, one debt — the property adds nothing to the debt side.
    expect(report.totals.balance).toBe(500_000);
    expect(report.totals.count).toBe(1);
  });

  it('falls back to the address when a property has no nickname', () => {
    const p = property({ name: null, loan_id: 'l1' });
    const report = buildLoanReport([loan()], [], [p], { today: TODAY });
    expect(report.rows[0].property?.name).toBe('34 Beach Rd, Bondi');
  });

  it('reports no property for an ordinary loan', () => {
    const report = buildLoanReport([loan({ loan_type: 'car' })], [], [property()], { today: TODAY });
    expect(report.rows[0].property).toBeNull();
  });

  it('leaves an excluded loan out of the net-worth total but still lists it', () => {
    const report = buildLoanReport(
      [loan(), loan({ id: 'l2', current_balance: 20_000, include_in_net_worth: false })],
      [], [], { today: TODAY },
    );
    expect(report.totals.balance).toBe(520_000);
    expect(report.totals.netWorthDebt).toBe(500_000);
    expect(report.rows[1].countsTowardNetWorth).toBe(false);
  });

  it('surfaces a fixed rate and what it reverts to', () => {
    const l = loan({ rate_type: 'fixed', fixed_until: '2028-06-01', revert_rate: 7.4 });
    const row = buildLoanReport([l], [], [], { today: TODAY }).rows[0];
    expect(row.rateType).toBe('fixed');
    expect(row.fixedUntil).toBe('2028-06-01');
    expect(row.upcomingRateChanges).toEqual([{ from: '2028-06-01', rate: 7.4 }]);
  });

  it('charges a rate change that has already happened', () => {
    const events = [event({ id: 'e9', kind: 'rate_change', rate: 7, date: '2026-07-01' })];
    const row = buildLoanReport([loan()], events, [], { today: TODAY }).rows[0];
    expect(row.rate).toBe(7);
    expect(row.upcomingRateChanges).toEqual([]);
  });

  it('keeps a future rate change out of today\'s figures but in the projection', () => {
    const paysOff = loan({ minimum_repayment: 4_000 });
    const events = [event({ id: 'e9', kind: 'rate_change', rate: 8, date: '2027-01-01' })];
    const row = buildLoanReport([paysOff], events, [], { today: TODAY }).rows[0];
    expect(row.rate).toBe(6);
    expect(row.upcomingRateChanges).toEqual([{ from: '2027-01-01', rate: 8 }]);
    const flat = buildLoanReport([paysOff], [], [], { today: TODAY }).rows[0];
    expect(row.projection.totalInterest).toBeGreaterThan(flat.projection.totalInterest);
  });

  it('attaches only the movements belonging to the loan, newest first', () => {
    const events = [
      event({ id: 'a', loan_id: 'l1', kind: 'extra_repayment', amount: 100, date: '2026-01-01' }),
      event({ id: 'b', loan_id: 'l1', kind: 'redraw', amount: 50, date: '2026-05-01' }),
      event({ id: 'c', loan_id: 'other', kind: 'extra_repayment', amount: 999, date: '2026-06-01' }),
    ];
    const row = buildLoanReport([loan()], events, [], { today: TODAY }).rows[0];
    expect(row.events.map(e => e.id)).toEqual(['b', 'a']);
  });

  it('reports redraw as available credit, never as an asset', () => {
    const row = buildLoanReport([loan({ redraw_available: 15_000 })], [], [], { today: TODAY }).rows[0];
    expect(row.redrawAvailable).toBe(15_000);
    expect(row.balance).toBe(500_000);
    // Redraw is nowhere in the net-worth figure — it is borrowing capacity, not money.
    expect(buildLoanReport([loan({ redraw_available: 15_000 })], [], [], { today: TODAY }).totals.netWorthDebt).toBe(500_000);
  });

  it('says how far ahead of the contract the projection runs', () => {
    const l = loan({ end_date: '2056-08-17', minimum_repayment: 4_000 });
    const row = buildLoanReport([l], [], [], { today: TODAY }).rows[0];
    expect(row.contractedRemainingMonths).toBe(360);
    expect(row.monthsAheadOfContract!).toBeGreaterThan(0);
  });

  it('normalises every repayment to a month in the totals', () => {
    const report = buildLoanReport([
      loan({ minimum_repayment: 3_000, repayment_frequency: 'monthly' }),
      loan({ id: 'l2', minimum_repayment: 500, repayment_frequency: 'fortnightly', current_balance: 20_000 }),
    ], [], [], { today: TODAY });
    expect(report.totals.monthlyOutlay).toBeCloseTo(3_000 + perMonth(500, 'fortnightly'), 2);
  });

  it('counts an extra repayment as part of the period outlay', () => {
    const row = buildLoanReport([loan({ extra_repayment: 400 })], [], [], { today: TODAY }).rows[0];
    expect(row.periodOutlay).toBe(3_400);
  });

  it('reports the debt-free date as the LAST loan to clear', () => {
    const report = buildLoanReport([
      loan({ current_balance: 3_000, interest_rate: 0, minimum_repayment: 1_000, next_due_date: '2026-09-01' }),
      loan({ id: 'l2', current_balance: 10_000, interest_rate: 0, minimum_repayment: 1_000, next_due_date: '2026-09-01' }),
    ], [], [], { today: TODAY });
    expect(report.totals.debtFreeDate).toBe('2027-06-01');
  });

  it('has no debt-free date while one loan never pays off', () => {
    const report = buildLoanReport([
      loan({ current_balance: 3_000, interest_rate: 0, minimum_repayment: 1_000 }),
      loan({ id: 'l2', current_balance: 100_000, interest_rate: 6, minimum_repayment: 100 }),
    ], [], [], { today: TODAY });
    expect(report.totals.debtFreeDate).toBeNull();
  });

  it('adds up to the sum of its rows', () => {
    const report = buildLoanReport([
      loan({ offset_balance: 50_000, redraw_available: 5_000 }),
      loan({ id: 'l2', current_balance: 30_000, offset_balance: 0, redraw_available: 1_000 }),
    ], [], [], { today: TODAY });
    expect(report.totals.balance).toBe(530_000);
    expect(report.totals.offsetBalance).toBe(50_000);
    expect(report.totals.effectiveBalance).toBe(480_000);
    expect(report.totals.redrawAvailable).toBe(6_000);
    expect(report.totals.interestPerYear)
      .toBeCloseTo(report.rows.reduce((s, r) => s + r.interestPerYear, 0), 2);
  });

  it('handles an empty portfolio', () => {
    const report = buildLoanReport([], [], [], { today: TODAY });
    expect(report.rows).toEqual([]);
    expect(report.totals.balance).toBe(0);
    expect(report.totals.debtFreeDate).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('validateMovement', () => {
  const l = { current_balance: 100_000, redraw_available: 5_000 };

  it('accepts a good extra repayment', () => {
    expect(validateMovement({ kind: 'extra_repayment', amount: 1_000, date: '2026-08-17' }, l)).toEqual([]);
  });

  it('needs a date', () => {
    expect(validateMovement({ kind: 'extra_repayment', amount: 1_000 }, l))
      .toContain('A date is required.');
  });

  it('needs a positive amount', () => {
    expect(validateMovement({ kind: 'extra_repayment', amount: 0, date: '2026-08-17' }, l))
      .toContain('Amount must be more than zero.');
  });

  it('refuses to redraw more than is available', () => {
    expect(validateMovement({ kind: 'redraw', amount: 6_000, date: '2026-08-17' }, l))
      .toContain('Only 5000.00 is available to redraw.');
  });

  it('allows a redraw of exactly what is available', () => {
    expect(validateMovement({ kind: 'redraw', amount: 5_000, date: '2026-08-17' }, l)).toEqual([]);
  });

  it('refuses to pay more off than is owed', () => {
    expect(validateMovement({ kind: 'extra_repayment', amount: 200_000, date: '2026-08-17' }, l))
      .toContain("That's more than the balance owing.");
  });

  it('allows a partial repayment of any size', () => {
    expect(validateMovement({ kind: 'repayment', amount: 25, date: '2026-08-17' }, l)).toEqual([]);
  });

  it('wants a rate on a rate change, not an amount', () => {
    expect(validateMovement({ kind: 'rate_change', date: '2026-08-17' }, l))
      .toContain('Enter the new interest rate.');
    expect(validateMovement({ kind: 'rate_change', rate: 6.8, date: '2026-08-17' }, l)).toEqual([]);
  });
});
