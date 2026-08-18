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
  validateMovement, checkMovement, isIndexed, periodInterest, payoffAmount, maxApplicable,
  extraRepaymentScenario, offsetScenario, resolveOffset,
  contractEndDate, contractedRepayment,
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
    expect(state).toMatchObject({ current_balance: 498_500, redraw_available: 4_000 });
  });

  it('never overpays past zero, and never makes the surplus redrawable', () => {
    const next = applyExtraRepayment({ current_balance: 5_000, redraw_available: 0 }, 8_000);
    expect(next.current_balance).toBe(0);
    expect(next.redraw_available).toBe(5_000);   // only what was actually owed
    // …and the trim is reported rather than swallowed.
    expect(next.applied).toBe(5_000);
    expect(next.excess).toBe(3_000);
    expect(next.capped).toBe(true);
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

  it('never treats an overdrawn account as a negative offset', () => {
    const l = loan({ offset_account_id: 'a1' });
    expect(offsetBalanceFor(l, [{ id: 'a1', balance: -500 }])).toBe(0);
  });

  it('tracks the account as its balance moves, with no stored figure involved', () => {
    // Each of these is the same loan on a different day: a Basiq sync, an
    // import, a manual edit. Nothing about the loan changes.
    const l = loan({ offset_balance: 25_000, offset_account_id: 'a1' });
    expect(offsetBalanceFor(l, [{ id: 'a1', balance: 40_000 }])).toBe(40_000);
    expect(offsetBalanceFor(l, [{ id: 'a1', balance: 41_250.5 }])).toBe(41_250.5);
    expect(offsetBalanceFor(l, [{ id: 'a1', balance: 0 }])).toBe(0);
  });

  it('drops the stale typed figure when the linked account is gone', () => {
    // The old behaviour fell back to 25,000 — an account that no longer exists
    // would have gone on discounting interest against cash that isn't there.
    const l = loan({ offset_balance: 25_000, offset_account_id: 'a1' });
    const r = resolveOffset(l, [{ id: 'other', balance: 9 }]);
    expect(r.balance).toBe(0);
    expect(r.linked).toBe(true);
    expect(r.linkBroken).toBe(true);
    expect(r.account).toBeNull();
    expect(offsetBalanceFor(l, [{ id: 'other', balance: 9 }])).toBe(0);
  });

  it('says where the offset came from', () => {
    const linked = resolveOffset(
      loan({ offset_balance: 25_000, offset_account_id: 'a1' }),
      [{ id: 'a1', balance: 40_000, name: 'Everyday offset' }],
    );
    expect(linked).toEqual({
      balance: 40_000, linked: true, linkBroken: false,
      account: { id: 'a1', name: 'Everyday offset' },
    });

    const typed = resolveOffset(loan({ offset_balance: 25_000 }));
    expect(typed).toEqual({ balance: 25_000, linked: false, linkBroken: false, account: null });
  });

  it('names an unnamed account rather than showing a blank', () => {
    const r = resolveOffset(loan({ offset_account_id: 'a1' }), [{ id: 'a1', balance: 10, name: '  ' }]);
    expect(r.account).toEqual({ id: 'a1', name: 'Linked account' });
  });

  it('unlinking hands the loan back to its typed figure', () => {
    const linked = loan({ offset_balance: 12_000, offset_account_id: 'a1' });
    const unlinked = { ...linked, offset_account_id: null } as Loan;
    const accounts = [{ id: 'a1', balance: 40_000 }];
    expect(offsetBalanceFor(linked, accounts)).toBe(40_000);
    expect(offsetBalanceFor(unlinked, accounts)).toBe(12_000);
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

  it('names the linked account and prices what it saves per year and per month', () => {
    const row = buildLoanReport(
      [loan({ offset_balance: 0, offset_account_id: 'a1' })], [], [],
      { today: TODAY, offsetAccounts: [{ id: 'a1', balance: 60_000, name: 'Offset saver' }] },
    ).rows[0];
    expect(row.offsetIsLinked).toBe(true);
    expect(row.offsetAccount).toEqual({ id: 'a1', name: 'Offset saver' });
    expect(row.offsetLinkBroken).toBe(false);
    expect(row.offsetBalance).toBe(60_000);
    expect(row.offsetSavingPerYear).toBe(3_600);   // 60,000 × 6%
    expect(row.offsetSavingPerMonth).toBe(300);
  });

  it('reprojects the whole loan when the linked balance moves', () => {
    const l = loan({ offset_balance: 0, offset_account_id: 'a1', minimum_repayment: 3_500 });
    const before = buildLoanReport([l], [], [], {
      today: TODAY, offsetAccounts: [{ id: 'a1', balance: 0 }],
    }).rows[0];
    // The same loan the day a 100k deposit lands in the offset account.
    const after = buildLoanReport([l], [], [], {
      today: TODAY, offsetAccounts: [{ id: 'a1', balance: 100_000 }],
    }).rows[0];

    expect(after.balance).toBe(before.balance);                       // the debt didn't move
    expect(after.interestPerYear).toBeLessThan(before.interestPerYear);
    expect(after.monthsToPayoff!).toBeLessThan(before.monthsToPayoff!);
    expect(after.projection.totalInterest).toBeLessThan(before.projection.totalInterest);
    expect(after.payoffDate! < before.payoffDate!).toBe(true);
  });

  it('a broken link offsets nothing and says so', () => {
    const row = buildLoanReport(
      [loan({ offset_balance: 100_000, offset_account_id: 'gone' })], [], [],
      { today: TODAY, offsetAccounts: [{ id: 'a1', balance: 75_000 }] },
    ).rows[0];
    expect(row.offsetBalance).toBe(0);
    expect(row.offsetLinkBroken).toBe(true);
    expect(row.offsetAccount).toBeNull();
    expect(row.effectiveBalance).toBe(500_000);
    expect(row.interestPerYear).toBe(30_000);      // the full amount, not the stale discount
  });

  it('an emptied or overdrawn offset account simply stops offsetting', () => {
    const l = loan({ offset_balance: 0, offset_account_id: 'a1' });
    const empty = buildLoanReport([l], [], [], { today: TODAY, offsetAccounts: [{ id: 'a1', balance: 0 }] }).rows[0];
    const over = buildLoanReport([l], [], [], { today: TODAY, offsetAccounts: [{ id: 'a1', balance: -2_500 }] }).rows[0];

    for (const row of [empty, over]) {
      expect(row.offsetBalance).toBe(0);
      expect(row.offsetSavingPerYear).toBe(0);
      expect(row.offsetSavingPerMonth).toBe(0);
      expect(row.effectiveBalance).toBe(500_000);
      expect(row.interestPerYear).toBe(30_000);
      expect(row.balance).toBe(500_000);           // and the debt is never inflated by it
    }
    expect(over.offsetIsLinked).toBe(true);
    expect(over.offsetLinkBroken).toBe(false);     // the account is there, it's just empty
  });

  it('a manual offset stays manual, and a link makes the manual figure dead', () => {
    const accounts = [{ id: 'a1', balance: 10_000, name: 'Everyday' }];
    const manual = buildLoanReport([loan({ offset_balance: 80_000 })], [], [],
      { today: TODAY, offsetAccounts: accounts }).rows[0];
    const linked = buildLoanReport([loan({ offset_balance: 80_000, offset_account_id: 'a1' })], [], [],
      { today: TODAY, offsetAccounts: accounts }).rows[0];

    expect(manual.offsetBalance).toBe(80_000);
    expect(manual.offsetIsLinked).toBe(false);
    expect(manual.offsetAccount).toBeNull();
    expect(linked.offsetBalance).toBe(10_000);     // never the 80,000 still on the row
  });

  it('never lets the offset touch what net worth subtracts', () => {
    const row = buildLoanReport(
      [loan({ offset_balance: 0, offset_account_id: 'a1' })], [], [],
      { today: TODAY, offsetAccounts: [{ id: 'a1', balance: 400_000 }] },
    );
    // The 400,000 is already an asset in that bank account. Net worth reads the
    // balance only, so the cash is counted once as savings and never a second
    // time as a smaller debt.
    expect(row.totals.netWorthDebt).toBe(500_000);
    expect(row.totals.balance).toBe(500_000);
    expect(row.totals.offsetBalance).toBe(400_000);
    expect(row.totals.effectiveBalance).toBe(100_000);
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

  it('does not BLOCK paying more off than is owed — it asks for confirmation', () => {
    const draft = { kind: 'extra_repayment' as const, amount: 200_000, date: '2026-08-17' };
    // Nothing is malformed, so there is no error to show…
    expect(validateMovement(draft, l)).toEqual([]);
    // …but it can't be recorded silently either.
    const check = checkMovement(draft, l);
    expect(check.requiresConfirmation).toBe(true);
    expect(check.excess).toBe(100_000);
    expect(check.warnings[0]).toContain('100000.00 more than the 100000.00 owing');
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

// ═══════════════════════════════════════════════════════════════════════════════
//  Overpayment — a repayment can never create a debt the user doesn't have
// ═══════════════════════════════════════════════════════════════════════════════
//
// The reported case: a $10,000 loan with $9,000 left, and the user types the
// ORIGINAL amount into the repayment box. It used to be trimmed to fit without a
// word, so the app recorded a different number from the one entered. Now the
// excess is measured and named, and nothing is recorded until it is corrected or
// confirmed — but the balance still stops dead at zero either way.

describe('overpayment guards', () => {
  const TODAY = '2026-08-17';
  const nearlyPaid = loan({
    original_amount: 10_000, current_balance: 9_000, interest_rate: 0,
    minimum_repayment: 500, redraw_available: 0,
  });
  const repay = (amount: number) => ({ kind: 'repayment' as const, amount, date: TODAY });

  it('names the excess: 10,000 paid on 9,000 owing is 1,000 over', () => {
    const check = checkMovement(repay(10_000), nearlyPaid);
    expect(check.maxApplicable).toBe(9_000);
    expect(check.excess).toBe(1_000);
    expect(check.appliedIfConfirmed).toBe(9_000);
    expect(check.requiresConfirmation).toBe(true);
    expect(check.errors).toEqual([]);          // legal, just wrong
    expect(check.warnings[0]).toContain('1000.00 more than the 9000.00');
  });

  it('measures against the PAYOFF figure, which includes the period interest', () => {
    const withRate = loan({ current_balance: 9_000, interest_rate: 6, minimum_repayment: 500 });
    expect(periodInterest(withRate)).toBe(45);            // 9,000 × 6% ÷ 12
    expect(payoffAmount(withRate)).toBe(9_045);
    // Paying exactly what it takes to close the loan is not an overpayment.
    expect(checkMovement(repay(9_045), withRate).requiresConfirmation).toBe(false);
    expect(checkMovement(repay(10_000), withRate).excess).toBe(955);
  });

  it('an offset lowers the payoff figure, because it lowers the interest', () => {
    const offsetLoan = loan({ current_balance: 9_000, interest_rate: 6, offset_balance: 9_000 });
    expect(periodInterest(offsetLoan)).toBe(0);
    expect(payoffAmount(offsetLoan)).toBe(9_000);
  });

  it('confirming applies the payoff figure and not a cent more', () => {
    const split = applyRepayment(nearlyPaid, 10_000);
    expect(split.applied).toBe(9_000);
    expect(split.excess).toBe(1_000);
    expect(split.capped).toBe(true);
    expect(split.current_balance).toBe(0);
  });

  it('never drives the balance negative, however large the payment', () => {
    expect(applyRepayment(nearlyPaid, 5_000_000).current_balance).toBe(0);
    expect(applyExtraRepayment(nearlyPaid, 5_000_000).current_balance).toBe(0);
    const hecs = loan({ loan_type: 'hecs', current_balance: 2_000, interest_rate: 5, minimum_repayment: 200 });
    expect(applyRepayment(hecs, 99_999).current_balance).toBe(0);
  });

  it('redraw is only ever what was actually paid ahead, never the excess', () => {
    const split = applyRepayment(nearlyPaid, 10_000);
    // 9,000 applied, 500 of it scheduled — so 8,500 was ahead of schedule. The
    // 1,000 that had nothing to pay is not redrawable: it was never borrowed.
    expect(split.surplus).toBe(8_500);
    expect(split.redraw_available).toBe(8_500);
    expect(split.redraw_available).toBeLessThanOrEqual(split.applied);
  });

  it('an exact payoff is not flagged at all', () => {
    const check = checkMovement(repay(9_000), nearlyPaid);
    expect(check.excess).toBe(0);
    expect(check.requiresConfirmation).toBe(false);
    expect(applyRepayment(nearlyPaid, 9_000).capped).toBe(false);
    expect(applyRepayment(nearlyPaid, 9_000).current_balance).toBe(0);
  });

  it('leaves ordinary and partial repayments alone', () => {
    expect(checkMovement(repay(500), nearlyPaid).requiresConfirmation).toBe(false);
    expect(checkMovement(repay(25), nearlyPaid).requiresConfirmation).toBe(false);
    expect(applyRepayment(nearlyPaid, 500).capped).toBe(false);
  });

  it('caps an extra repayment at the balance — no interest is due on one', () => {
    expect(maxApplicable(nearlyPaid, 'extra_repayment')).toBe(9_000);
    const check = checkMovement({ kind: 'extra_repayment', amount: 10_000, date: TODAY }, nearlyPaid);
    expect(check.excess).toBe(1_000);
    expect(check.requiresConfirmation).toBe(true);
    expect(check.warnings[0]).toContain('owing');
  });

  it('an over-redraw stays a hard error — confirming cannot make it true', () => {
    const check = checkMovement({ kind: 'redraw', amount: 5_000, date: TODAY },
      { current_balance: 9_000, redraw_available: 1_000 });
    expect(check.errors).toEqual(['Only 1000.00 is available to redraw.']);
    expect(check.requiresConfirmation).toBe(false);
  });

  it('a malformed amount is an error, never something to confirm', () => {
    const check = checkMovement(repay(0), nearlyPaid);
    expect(check.errors).toContain('Amount must be more than zero.');
    expect(check.requiresConfirmation).toBe(false);
    expect(checkMovement({ kind: 'repayment', amount: 10_000 }, nearlyPaid).errors)
      .toContain('A date is required.');
  });

  it('a rate change has no amount to overshoot', () => {
    const check = checkMovement({ kind: 'rate_change', rate: 6.8, date: TODAY }, nearlyPaid);
    expect(check.requiresConfirmation).toBe(false);
    expect(check.errors).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  Redraw and interest — the double-discount audit
// ═══════════════════════════════════════════════════════════════════════════════
//
// An extra repayment reduces `current_balance`, and the interest saved is
// already in that smaller balance. `redraw_available` records that the same
// money could be pulled back — so if it ALSO reduced the interest-bearing
// balance, every extra repayment would be discounted twice and the payoff date
// would run years early. Offset is the only balance allowed to reduce the
// interest charged without reducing the debt, because that money is still the
// user's.

describe('redraw never reduces the interest charged', () => {
  const TODAY = '2026-08-17';
  const base = { current_balance: 450_000, interest_rate: 6, minimum_repayment: 3_000 };

  it('a loan with redraw is charged exactly what the same loan without it is', () => {
    const withRedraw = loan({ ...base, redraw_available: 50_000 });
    const without = loan({ ...base, redraw_available: 0 });
    expect(periodInterest(withRedraw)).toBe(periodInterest(without));
    expect(periodInterest(withRedraw)).toBe(2_250);        // 450,000 × 6% ÷ 12

    const [a] = buildLoanReport([withRedraw], [], [], { today: TODAY }).rows;
    const [b] = buildLoanReport([without], [], [], { today: TODAY }).rows;
    expect(a.effectiveBalance).toBe(450_000);              // NOT 400,000
    expect(a.interestThisPeriod).toBe(b.interestThisPeriod);
    expect(a.interestPerYear).toBe(b.interestPerYear);
    expect(a.payoffDate).toBe(b.payoffDate);
    // It is still reported — just as capacity, never as a discount.
    expect(a.redrawAvailable).toBe(50_000);
  });

  it('only the offset moves the interest, and it moves it by the offset alone', () => {
    const l = loan({ ...base, redraw_available: 50_000, offset_balance: 30_000 });
    expect(periodInterest(l)).toBe(2_100);                 // (450,000 − 30,000) × 6% ÷ 12
    const [row] = buildLoanReport([l], [], [], { today: TODAY }).rows;
    expect(row.effectiveBalance).toBe(420_000);            // offset only — redraw untouched
  });

  it('an extra repayment saves interest ONCE, through the balance', () => {
    const before = loan({ current_balance: 500_000, interest_rate: 6, minimum_repayment: 3_500 });
    const moved = applyExtraRepayment(before, 50_000);
    const after = loan({ ...before, ...moved });
    expect(after.current_balance).toBe(450_000);
    expect(after.redraw_available).toBe(50_000);

    const projectionAfter = projectLoan(projectionInputForLoan(after, [], TODAY));
    // Identical to a loan that simply owes 450,000 and has never paid ahead…
    const neverPaidAhead = projectLoan(projectionInputForLoan(
      loan({ ...before, current_balance: 450_000 }), [], TODAY,
    ));
    expect(projectionAfter.totalInterest).toBe(neverPaidAhead.totalInterest);
    expect(projectionAfter.payoffDate).toBe(neverPaidAhead.payoffDate);

    // …and NOT the same as one owing 400,000, which is what discounting the
    // redraw a second time would have produced.
    const doubleCounted = projectLoan(projectionInputForLoan(
      loan({ ...before, current_balance: 400_000 }), [], TODAY,
    ));
    expect(projectionAfter.totalInterest).toBeGreaterThan(doubleCounted.totalInterest);
    expect(projectionAfter.periodsToPayoff!).toBeGreaterThan(doubleCounted.periodsToPayoff!);
  });

  it('redrawing it all puts the interest back exactly where it started', () => {
    const start = loan({ current_balance: 500_000, interest_rate: 6, minimum_repayment: 3_500 });
    const paidAhead = { ...start, ...applyExtraRepayment(start, 25_000) };
    const redrawn = loan({ ...start, ...applyRedraw(paidAhead, 25_000) });

    expect(periodInterest(paidAhead)).toBeLessThan(periodInterest(start));
    expect(periodInterest(redrawn)).toBe(periodInterest(start));
    expect(redrawn.redraw_available).toBe(0);
  });

  it('offset, extra repayment and redraw together each do their own job', () => {
    const start = loan({
      current_balance: 500_000, interest_rate: 6, minimum_repayment: 3_500, offset_balance: 20_000,
    });
    const paidAhead = { ...start, ...applyExtraRepayment(start, 30_000) };
    const then = { ...paidAhead, ...applyRedraw(paidAhead, 10_000) };

    // Balance: 500,000 − 30,000 + 10,000. Redraw: 30,000 − 10,000.
    expect(then.current_balance).toBe(480_000);
    expect(then.redraw_available).toBe(20_000);
    // Interest: (480,000 − 20,000 offset) × 6% ÷ 12. The 20,000 of redraw is
    // nowhere in that sum.
    expect(periodInterest(then)).toBe(2_300);

    const [row] = buildLoanReport([loan(then)], [], [], { today: TODAY }).rows;
    expect(row.effectiveBalance).toBe(460_000);
    expect(row.offsetSavingPerYear).toBe(1_200);           // 20,000 × 6%, the offset alone
  });

  it('a repayment charges interest on the balance net of offset only', () => {
    const l = loan({
      current_balance: 100_000, interest_rate: 6, minimum_repayment: 1_000,
      offset_balance: 40_000, redraw_available: 25_000,
    });
    const split = applyRepayment(l, 1_000);
    expect(split.interest).toBe(300);                       // (100,000 − 40,000) × 6% ÷ 12
    expect(split.principal).toBe(700);                      // …and not a cent more for the redraw
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('a scenario extra can\'t be bigger than the loan', () => {
  // 9,000 owing at 6% monthly: one period's interest is 45, so 9,045 pays it out.
  // 500 of that is already the scheduled repayment, leaving 8,545 of useful extra.
  const nearlyPaid = (o: Partial<Loan> = {}) => loan({
    current_balance: 9_000, interest_rate: 6, minimum_repayment: 500,
    repayment_frequency: 'monthly', ...o,
  });

  it('names the excess and the ceiling for a huge amount', () => {
    const s = extraRepaymentScenario(nearlyPaid(), 1_000_000);
    expect(s.payoffAmount).toBe(9_045);
    expect(s.committedPerPeriod).toBe(500);
    expect(s.maxUsefulExtra).toBe(8_545);
    expect(s.excess).toBe(991_455);
    expect(s.exceedsPayoff).toBe(true);
    expect(s.usefulExtra).toBe(8_545);
    expect(s.alreadyCleared).toBe(false);
  });

  it('measures against the SAME payoff figure an overpayment is checked against', () => {
    const l = nearlyPaid();
    expect(extraRepaymentScenario(l, 1).payoffAmount).toBe(payoffAmount(l));
    expect(extraRepaymentScenario(l, 1).payoffAmount).toBe(maxApplicable(l, 'repayment'));
  });

  it('does not flag the exact ceiling', () => {
    const s = extraRepaymentScenario(nearlyPaid(), 8_545);
    expect(s.exceedsPayoff).toBe(false);
    expect(s.excess).toBe(0);
    expect(s.usefulExtra).toBe(8_545);
  });

  it('does not flag an ordinary extra', () => {
    const s = extraRepaymentScenario(nearlyPaid(), 200);
    expect(s.exceedsPayoff).toBe(false);
    expect(s.excess).toBe(0);
    expect(s.usefulExtra).toBe(200);
  });

  it('counts a standing extra repayment toward the ceiling', () => {
    // 500 scheduled + 300 already paid extra every period = 800 committed.
    const s = extraRepaymentScenario(nearlyPaid({ extra_repayment: 300 }), 9_000);
    expect(s.committedPerPeriod).toBe(800);
    expect(s.maxUsefulExtra).toBe(8_245);
    expect(s.excess).toBe(755);
  });

  it('capping loses nothing — the ceiling clears the loan just as fast', () => {
    const l = nearlyPaid();
    const at = (extra: number) => projectLoan({ ...projectionInputForLoan(l, [], TODAY), extraPerPeriod: extra });
    const capped = at(extraRepaymentScenario(l, 1_000_000).maxUsefulExtra);
    const absurd = at(1_000_000);
    expect(capped.periodsToPayoff).toBe(1);
    expect(capped.periodsToPayoff).toBe(absurd.periodsToPayoff);
    expect(capped.totalInterest).toBe(absurd.totalInterest);
  });

  it('an offset lowers the payoff figure, so it lowers the ceiling too', () => {
    // Interest on (9,000 − 4,000) is 25, so paying out costs 9,025.
    const s = extraRepaymentScenario(nearlyPaid({ offset_balance: 4_000 }), 50_000);
    expect(s.payoffAmount).toBe(9_025);
    expect(s.maxUsefulExtra).toBe(8_525);
  });

  it('an offset covering the whole balance leaves the debt itself to pay', () => {
    // No interest is charged, but the 9,000 is still owed — the offset is the
    // user's own cash, not a repayment.
    const l = nearlyPaid({ offset_balance: 9_000 });
    expect(periodInterest(l)).toBe(0);
    const s = extraRepaymentScenario(l, 20_000);
    expect(s.payoffAmount).toBe(9_000);
    expect(s.maxUsefulExtra).toBe(8_500);
    expect(s.excess).toBe(11_500);
    // …and none of that offset is redrawable.
    expect(redrawLimit(l)).toBe(0);
    expect(maxApplicable(l, 'redraw')).toBe(0);
  });

  it('redraw sitting on the loan does not raise the ceiling', () => {
    const withRedraw = extraRepaymentScenario(nearlyPaid({ redraw_available: 50_000 }), 100);
    const without = extraRepaymentScenario(nearlyPaid(), 100);
    expect(withRedraw.payoffAmount).toBe(without.payoffAmount);
    expect(withRedraw.maxUsefulExtra).toBe(without.maxUsefulExtra);
  });

  it('paying extra lowers the ceiling by exactly what was paid', () => {
    const before = nearlyPaid();
    const next = applyExtraRepayment(before, 4_000);
    const after = nearlyPaid({
      current_balance: next.current_balance, redraw_available: next.redraw_available,
    });
    expect(after.current_balance).toBe(5_000);
    expect(after.redraw_available).toBe(4_000);

    const s = extraRepaymentScenario(after, 8_545);
    expect(s.payoffAmount).toBe(5_025);                   // 5,000 + 25 interest
    expect(s.maxUsefulExtra).toBe(4_525);                 // 4,020 lower, the paid amount + its interest
    expect(s.exceedsPayoff).toBe(true);
  });

  it('a redraw puts the ceiling back up', () => {
    const paidAhead = nearlyPaid({ current_balance: 5_000, redraw_available: 4_000 });
    const back = applyRedraw(paidAhead, 4_000);
    const after = nearlyPaid({
      current_balance: back.current_balance, redraw_available: back.redraw_available,
    });
    expect(after.current_balance).toBe(9_000);
    expect(extraRepaymentScenario(after, 1).maxUsefulExtra).toBe(8_545);
  });

  it('says so when the schedule already clears the loan', () => {
    const s = extraRepaymentScenario(nearlyPaid({ minimum_repayment: 10_000 }), 100);
    expect(s.alreadyCleared).toBe(true);
    expect(s.maxUsefulExtra).toBe(0);
    expect(s.exceedsPayoff).toBe(true);
    expect(s.excess).toBe(100);
  });

  it('a cleared loan has nothing left for any extra to do', () => {
    const s = extraRepaymentScenario(nearlyPaid({ current_balance: 0 }), 500);
    expect(s.payoffAmount).toBe(0);
    expect(s.maxUsefulExtra).toBe(0);
    expect(s.alreadyCleared).toBe(true);
    expect(s.excess).toBe(500);
  });

  it('an indexed debt charges no interest, so the balance is the whole ceiling', () => {
    const s = extraRepaymentScenario(
      loan({ loan_type: 'hecs', current_balance: 9_000, interest_rate: 0, minimum_repayment: 500 }),
      50_000,
    );
    expect(s.payoffAmount).toBe(9_000);
    expect(s.maxUsefulExtra).toBe(8_500);
  });

  it('ignores a nonsensical amount rather than reporting an excess', () => {
    const s = extraRepaymentScenario(nearlyPaid(), Number.NaN);
    expect(s.exceedsPayoff).toBe(false);
    expect(s.usefulExtra).toBe(0);
    expect(s.excess).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('what adding to the offset is worth', () => {
  // 9,000 owing with 4,000 already offsetting: interest is charged on 5,000, so
  // 5,000 more is the most that can change anything.
  const partlyOffset = (o: Partial<Loan> = {}) => loan({
    current_balance: 9_000, offset_balance: 4_000, interest_rate: 6,
    minimum_repayment: 500, repayment_frequency: 'monthly', ...o,
  });

  it('names the ceiling and the excess for a huge amount', () => {
    const s = offsetScenario(partlyOffset(), 50_000);
    expect(s.balance).toBe(9_000);
    expect(s.currentOffset).toBe(4_000);
    expect(s.maxUsefulExtra).toBe(5_000);
    expect(s.usefulExtra).toBe(5_000);
    expect(s.effectiveOffset).toBe(9_000);
    expect(s.excess).toBe(45_000);
    expect(s.exceedsBalance).toBe(true);
    expect(s.alreadyInterestFree).toBe(false);
  });

  it('does not flag the exact ceiling', () => {
    const s = offsetScenario(partlyOffset(), 5_000);
    expect(s.exceedsBalance).toBe(false);
    expect(s.excess).toBe(0);
    expect(s.effectiveOffset).toBe(9_000);
  });

  it('adds an ordinary amount to what is already offsetting', () => {
    const s = offsetScenario(partlyOffset(), 1_000);
    expect(s.usefulExtra).toBe(1_000);
    expect(s.effectiveOffset).toBe(5_000);
    expect(s.exceedsBalance).toBe(false);
  });

  it('says so when the offset already covers the balance', () => {
    const s = offsetScenario(partlyOffset({ offset_balance: 9_000 }), 2_000);
    expect(s.alreadyInterestFree).toBe(true);
    expect(s.maxUsefulExtra).toBe(0);
    expect(s.usefulExtra).toBe(0);
    expect(s.exceedsBalance).toBe(true);
    expect(s.excess).toBe(2_000);
    expect(periodInterest(partlyOffset({ offset_balance: 9_000 }))).toBe(0);
  });

  it('a cleared loan has no interest for an offset to save', () => {
    const s = offsetScenario(partlyOffset({ current_balance: 0, offset_balance: 0 }), 5_000);
    expect(s.maxUsefulExtra).toBe(0);
    expect(s.alreadyInterestFree).toBe(true);
    expect(s.excess).toBe(5_000);
  });

  it('redraw sitting on the loan does not raise the ceiling', () => {
    // Those dollars have already come off the balance — counting them here
    // would discount the same money twice, exactly as it would for an extra.
    const withRedraw = offsetScenario(partlyOffset({ redraw_available: 50_000 }), 100);
    const without = offsetScenario(partlyOffset(), 100);
    expect(withRedraw.maxUsefulExtra).toBe(without.maxUsefulExtra);
    expect(withRedraw.effectiveOffset).toBe(without.effectiveOffset);
  });

  it('ignores a nonsensical amount rather than reporting an excess', () => {
    const s = offsetScenario(partlyOffset(), Number.NaN);
    expect(s.exceedsBalance).toBe(false);
    expect(s.usefulExtra).toBe(0);
    expect(s.excess).toBe(0);
    expect(s.effectiveOffset).toBe(4_000);
  });

  it('capping loses nothing — the ceiling already makes the loan interest-free', () => {
    const l = partlyOffset();
    const at = (offsetBalance: number) => projectLoan({
      ...projectionInputForLoan(l, [], TODAY), offsetBalance,
    });
    const capped = at(offsetScenario(l, 1_000_000).effectiveOffset);
    const absurd = at(1_000_000);
    expect(capped.totalInterest).toBe(0);
    expect(capped.totalInterest).toBe(absurd.totalInterest);
    expect(capped.periodsToPayoff).toBe(absurd.periodsToPayoff);
  });

  it('is priced by the same engine as the schedule, so the two agree', () => {
    // 500,000 at 6% paid 3,000 a month clears in 30 years. Offset the whole
    // balance and no interest is ever charged, so the 3,000 is all principal:
    // 167 repayments and not a cent of interest.
    const l = loan();
    const s = offsetScenario(l, 1_000_000);
    expect(s.maxUsefulExtra).toBe(500_000);

    const impact = repaymentImpact(
      projectionInputForLoan(l, [], TODAY),
      { offsetBalance: s.effectiveOffset },
    );
    expect(impact.comparable).toBe(true);
    expect(impact.scenario.totalInterest).toBe(0);
    expect(impact.scenario.periodsToPayoff).toBe(167);
    expect(impact.interestSaved).toBe(impact.baseline.totalInterest);
    expect(impact.monthsSaved!).toBeGreaterThan(0);
    expect(impact.scenario.payoffDate! < impact.baseline.payoffDate!).toBe(true);
    // The outlay is untouched: an offset changes what the interest costs, not
    // what leaves the account each month.
    expect(impact.periodPaymentDelta).toBe(0);
  });

  it('saves interest and time without touching the debt', () => {
    const l = partlyOffset({ current_balance: 300_000, offset_balance: 0, minimum_repayment: 2_000 });
    const before = projectLoan(projectionInputForLoan(l, [], TODAY));
    const impact = repaymentImpact(projectionInputForLoan(l, [], TODAY), { offsetBalance: 50_000 });

    expect(impact.interestSaved).toBeGreaterThan(0);
    expect(impact.monthsSaved!).toBeGreaterThan(0);
    // Asking the question changed nothing: the loan still owes what it owed,
    // still offsets what it offset, and its own projection is untouched.
    expect(l.current_balance).toBe(300_000);
    expect(l.offset_balance).toBe(0);
    expect(projectLoan(projectionInputForLoan(l, [], TODAY))).toEqual(before);
  });

  it('an indexed debt is charged no interest, so an offset saves nothing', () => {
    const hecs = loan({
      loan_type: 'hecs', current_balance: 30_000, interest_rate: 0,
      minimum_repayment: 500, offset_balance: 0,
    });
    const impact = repaymentImpact(projectionInputForLoan(hecs, [], TODAY), { offsetBalance: 20_000 });
    expect(impact.interestSaved).toBe(0);
    expect(impact.monthsSaved).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
describe('the contract, beside the projection', () => {
  // 850,000 at 6.09% over 30 years. The contract needs about 5,145 a month;
  // paying 10,000 clears it two decades early — which is why the panel has to
  // name the agreed date rather than let a 2035 payoff look like a bug.
  const rental = (o: Partial<Loan> = {}) => loan({
    current_balance: 850_000, interest_rate: 6.09, minimum_repayment: 10_000,
    repayment_frequency: 'monthly', next_due_date: '2026-08-19',
    start_date: '2026-02-19', end_date: '2056-08-19', offset_balance: 0, ...o,
  });

  it('reads the end date straight off the loan', () => {
    expect(contractEndDate(rental())).toBe('2056-08-19');
    expect(contractedRemainingMonths(rental(), TODAY)).toBe(360);
  });

  it('falls back to the term from the start date, and agrees with itself', () => {
    const l = rental({ end_date: null, term_months: 360, start_date: '2026-02-19' });
    expect(contractEndDate(l)).toBe('2056-02-19');
    expect(contractedRemainingMonths(l, TODAY)).toBe(monthsBetween(TODAY, '2056-02-19'));
  });

  it('has no contract when neither an end date nor a term is on file', () => {
    const l = rental({ end_date: null, term_months: null, start_date: null });
    expect(contractEndDate(l)).toBeNull();
    expect(contractedRemainingMonths(l, TODAY)).toBeNull();
    expect(contractedRepayment(l, TODAY)).toBeNull();
  });

  it('works out the repayment the contract was written for', () => {
    const need = contractedRepayment(rental(), TODAY)!;
    expect(need).toBeCloseTo(5_145.47, 2);
    // …and it is the repayment that actually lands on the end date: paid that,
    // the loan clears in the contracted 360 periods, not sooner or later.
    const p = projectLoan({
      balance: 850_000, annualRate: 6.09, frequency: 'monthly',
      repayment: need, startDate: '2026-08-19',
    });
    // 360 repayments, the contracted number — the last one falling a month
    // before the end date because the first is made on it, not after it.
    expect(p.periodsToPayoff).toBe(360);
    expect(p.payoffDate).toBe('2056-07-19');
  });

  it('reports the gap the panel exists to explain', () => {
    const { rows } = buildLoanReport([rental()], [], [], { today: TODAY });
    const row = rows[0];
    expect(row.contractEndDate).toBe('2056-08-19');
    expect(row.contractedRemainingMonths).toBe(360);
    expect(row.payoffDate).toBe('2035-11-19');            // what 10,000 a month does
    expect(row.monthsAheadOfContract).toBeGreaterThan(240);
    expect(row.contractedRepayment).toBeCloseTo(5_145.47, 2);
  });

  it('goes NEGATIVE when the repayment won\'t reach the end date', () => {
    // 1,100 a month on 765,655 at 5% doesn't even cover the interest.
    const { rows } = buildLoanReport(
      [loan({ current_balance: 765_655, interest_rate: 5, minimum_repayment: 1_100, end_date: '2056-08-19' })],
      [], [], { today: TODAY },
    );
    expect(rows[0].projection.neverPaysOff).toBe(true);
    expect(rows[0].contractEndDate).toBe('2056-08-19');
    // No payoff date at all, so there is no gap to measure — reported as null
    // rather than as a loan that is somehow on schedule.
    expect(rows[0].monthsAheadOfContract).toBeNull();
    expect(rows[0].contractedRepayment).toBeGreaterThan(1_100);
  });

  it('an indexed debt is costed with no interest, as it is charged none', () => {
    const hecs = loan({
      loan_type: 'hecs', current_balance: 24_000, interest_rate: 0,
      minimum_repayment: 500, end_date: '2030-08-17', start_date: null, term_months: null,
    });
    // 48 months to run, 24,000 owing: 500 a month and not a cent of interest.
    expect(contractedRemainingMonths(hecs, TODAY)).toBe(48);
    expect(contractedRepayment(hecs, TODAY)).toBe(500);
  });

  it('has no repayment to quote for a contract that has already expired', () => {
    expect(contractedRepayment(rental({ end_date: '2020-01-01' }), TODAY)).toBeNull();
    expect(contractedRepayment(rental({ current_balance: 0 }), TODAY)).toBeNull();
  });
});
