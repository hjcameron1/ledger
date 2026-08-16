/**
 * Scenario-based regression suite (synthetic fixtures only — no store, no network,
 * no production data). Each `describe` is one real-world scenario from the review
 * brief; it drives the SAME pure engine functions the app uses in production and
 * asserts the observable behaviour. Nothing here touches Supabase, localStorage,
 * or the network — every input is hand-built.
 */
import { describe, it, expect } from 'vitest';
import type { Bill, Subscription, Transaction, PendingPayment, TransactionRule } from '../types';

import {
  learnFromHistory, detectCadence, removeOutliers, monthlyEquivalent, type HistoryTxn,
} from './adaptiveForecast';
import {
  buildCashFlowForecast, generateOccurrences, dedupeInputs, addDays, addMonths,
  type RecurringInput,
} from './cashFlowForecast';
import {
  scoreBillSubscriptionMatch, findReconciliationCandidates, differentDecisionKey,
  preferredCanonicalName,
} from './billReconciliation';
import { classifyRefund } from './refundMatching';
import { validateSplits, splitCategoryAmounts } from './transactionSplits';
import { classifyManualAgainstSync } from './reconcile';
import {
  isSpendTransaction, isTransferTransaction, totalSpend, netMovement, incomeInflowAmount,
} from './transactionCore';
import { buildCardPaymentLeg, shouldPromptCardPayment, linkedCardPayments } from './cardPaymentReconciliation';
import { findMatchingSubscription, detectRecurringPatterns } from './recurringDetection';
import { applyRules } from './transactionRules';

const ASOF = '2026-08-13';
const daysAgo = (n: number) => addDays(ASOF, -n);

// ── Fixture factories ─────────────────────────────────────────────────────────
let seq = 0;
function tx(p: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: p.id ?? `t${seq}`, user_id: 'u1', account_id: 'acc-1', account_type: 'bank',
    date: ASOF, merchant: 'Merchant', currency: 'AUD', category: 'Shopping',
    is_duplicate_flagged: false, is_subscription: false, ...p,
  } as Transaction;
}
function htxn(p: Partial<HistoryTxn> & { date: string; amount: number }): HistoryTxn {
  return {
    category: 'Uncategorised', accountId: 'acc-1', merchantKey: 'thing', merchantName: 'Thing',
    isSpend: p.amount < 0, isTransfer: false, isRefund: false, committed: false, ...p,
  };
}
function ri(p: Partial<RecurringInput> & { id: string; amount: number; anchorDate: string }): RecurringInput {
  return {
    sourceType: 'bill', name: 'Thing', frequency: 'monthly', accountId: 'acc-1', confidence: 1, ...p,
  } as RecurringInput;
}
function subFx(p: Partial<Subscription> & { id: string; name: string; amount: number }): Subscription {
  return {
    user_id: 'u1', original_name: null, currency: 'AUD', frequency: 'monthly',
    next_charge_date: '2026-09-01', category: 'Entertainment', is_auto_detected: true,
    account_id: 'acc-1', ...p,
  } as Subscription;
}
function billFx(p: Partial<Bill> & { id: string; name: string; amount: number }): Bill {
  return {
    user_id: 'u1', due_date: '2026-09-01', is_recurring: true, frequency: 'monthly',
    colour: 'grey', is_paid: false, kind: 'bill', calendar_synced: false,
    account_id: 'acc-1', account_type: 'bank', ...p,
  } as Bill;
}
const rule = (p: Partial<TransactionRule> & { id: string; conditions: TransactionRule['conditions']; actions: TransactionRule['actions'] }): TransactionRule => ({
  user_id: 'u1', priority: 0, enabled: true, ...p,
});
const cand = (p: Partial<Parameters<typeof applyRules>[0]> & { amount: number }) => ({
  merchant_normalized: 'acme', raw_description: 'ACME', merchant: 'ACME',
  account_id: 'acc-1', source: 'basiq', ...p,
});

// ══════════════════════════════════════════════════════════════════════════════
// 1. Salary changes
// ══════════════════════════════════════════════════════════════════════════════
describe('1. salary changes', () => {
  const salary = (date: string, amount: number): HistoryTxn =>
    htxn({ date, amount, category: 'Income', merchantKey: 'acme payroll', merchantName: 'ACME Payroll' });

  it('a pay rise carries forward as the new level, not the old', () => {
    const r = learnFromHistory({ asOf: ASOF, knownInputs: [], history: [
      salary(daysAgo(56), 2000), salary(daysAgo(42), 2000),
      salary(daysAgo(28), 2500), salary(daysAgo(14), 2500),
    ] });
    expect(r.income).toHaveLength(1);
    expect(r.income[0].amount).toBe(2500);              // learned to the raise
    expect(r.income[0].frequency).toBe('fortnightly');
  });

  it('a one-off bonus spike does not permanently inflate the projection', () => {
    const r = learnFromHistory({ asOf: ASOF, knownInputs: [], history: [
      salary(daysAgo(42), 2000), salary(daysAgo(28), 8000 /*bonus*/), salary(daysAgo(14), 2000),
    ] });
    expect(r.income[0].amount).toBe(2000);              // median smooths the spike
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. Irregular pay
// ══════════════════════════════════════════════════════════════════════════════
describe('2. irregular pay', () => {
  it('irregular spacing is not accepted as a salary cadence', () => {
    expect(detectCadence(['2026-06-01', '2026-06-20', '2026-08-05'])).toBeNull();
  });
  it('irregular gig income is not projected as a recurring stream', () => {
    const gig = (date: string, amount: number): HistoryTxn =>
      htxn({ date, amount, category: 'Income', merchantKey: 'gig co', merchantName: 'Gig Co' });
    const r = learnFromHistory({ asOf: ASOF, knownInputs: [], history: [
      gig(daysAgo(74), 900), gig(daysAgo(55), 300), gig(daysAgo(9), 1500), // gaps 19d then 46d — irregular
    ] });
    expect(r.income).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. Multiple identical family bills must remain separate; true dupes link
// ══════════════════════════════════════════════════════════════════════════════
describe('3. family bills vs true duplicates', () => {
  it('same name+cadence but DIFFERENT amount (family plan) is "possible", never auto-"same"', () => {
    const bill = billFx({ id: 'b', name: 'Optus', amount: 89, frequency: 'monthly' });
    const sub = subFx({ id: 's', name: 'Optus', amount: 45, frequency: 'monthly' });
    expect(scoreBillSubscriptionMatch(bill, sub, { sameAccount: true }).verdict).toBe('possible');
  });

  it('two identical family subscriptions both survive the forecast de-duper (not collapsed into one)', () => {
    const alice = ri({ id: 'sub-alice', sourceType: 'subscription', name: 'Telstra', amount: -59, anchorDate: addDays(ASOF, 5) });
    const bob = ri({ id: 'sub-bob', sourceType: 'subscription', name: 'Telstra', amount: -59, anchorDate: addDays(ASOF, 5) });
    const { kept, suppressed } = dedupeInputs([alice, bob]);
    expect(kept.map(k => k.id).sort()).toEqual(['sub-alice', 'sub-bob']);
    expect(suppressed).toHaveLength(0);                 // two real obligations, both counted
  });

  it('a TRUE duplicate (same merchant, amount, cadence, account) links as "same"', () => {
    const bill = billFx({ id: 'b', name: 'Netflix', amount: 18.99, frequency: 'monthly' });
    const sub = subFx({ id: 's', name: 'Netflix', amount: 18.99, frequency: 'monthly' });
    const c = findReconciliationCandidates([bill], [sub], { sameAccount: () => true });
    expect(c).toHaveLength(1);
    expect(c[0].result.verdict).toBe('same');
  });

  it('a bill explicitly linked to a subscription is de-duped out of the forecast', () => {
    const sub = ri({ id: 'sub-1', sourceType: 'subscription', name: 'Netflix', amount: -18.99, anchorDate: addDays(ASOF, 5) });
    const mirror = ri({ id: 'bill-1', sourceType: 'bill', name: 'Netflix', amount: -18.99, anchorDate: addDays(ASOF, 5), links: { subscription_id: 'sub-1' } });
    const { kept, suppressed } = dedupeInputs([sub, mirror]);
    expect(kept.map(k => k.id)).toEqual(['sub-1']);
    expect(suppressed[0]).toMatchObject({ id: 'bill-1', reason: 'mirrors-subscription', keptId: 'sub-1' });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. Partial refunds
// ══════════════════════════════════════════════════════════════════════════════
describe('4. partial refunds', () => {
  const purchase = tx({ id: 'p', amount: -120, merchant_normalized: 'jb hi fi', date: '2026-07-01' });

  it('a single partial refund matches and is flagged partial', () => {
    const d = classifyRefund(tx({ id: 'r1', amount: 40, merchant_normalized: 'jb hi fi', date: '2026-07-05' }), [purchase]);
    expect(d.status).toBe('matched');
    if (d.status === 'matched') expect(d.partial).toBe(true);
  });

  it('two partials that together stay within the purchase both match', () => {
    const r1 = tx({ id: 'r1', amount: 40, transaction_type: 'refund', refund_of: 'p', merchant_normalized: 'jb hi fi', date: '2026-07-05' });
    const d2 = classifyRefund(tx({ id: 'r2', amount: 50, merchant_normalized: 'jb hi fi', date: '2026-07-09' }), [purchase, r1]);
    expect(d2.status).toBe('matched');                  // 40 + 50 ≤ 120
  });

  it('a partial that would exceed the remaining balance is sent to review, not guessed', () => {
    const r1 = tx({ id: 'r1', amount: 100, transaction_type: 'refund', refund_of: 'p', merchant_normalized: 'jb hi fi', date: '2026-07-05' });
    const d2 = classifyRefund(tx({ id: 'r2', amount: 50, merchant_normalized: 'jb hi fi', date: '2026-07-09' }), [purchase, r1]);
    expect(d2).toEqual({ status: 'review', reason: 'over_refund' });  // 100 + 50 > 120
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Split transactions
// ══════════════════════════════════════════════════════════════════════════════
describe('5. split transactions', () => {
  it('splits that sum to the parent magnitude are valid and count once', () => {
    const lines = [{ category: 'Groceries', amount: 140 }, { category: 'Household', amount: 70 }, { category: 'Work', amount: 40 }];
    const v = validateSplits(lines, -250);
    expect(v.ok).toBe(true);
    expect(v.remaining).toBe(0);
    const byCat = splitCategoryAmounts(lines as any);
    expect(Object.values(byCat).reduce((a, b) => a + b, 0)).toBe(250);
  });
  it('splits that do not sum to the parent are rejected', () => {
    expect(validateSplits([{ category: 'A', amount: 100 }, { category: 'B', amount: 100 }], -250).error).toBe('sum_mismatch');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 6. Duplicate statement imports
// ══════════════════════════════════════════════════════════════════════════════
describe('6. duplicate statement imports', () => {
  const manual = tx({ id: 'm', amount: -54.2, merchant: 'Woolworths', merchant_normalized: 'woolworths', date: '2026-08-10', source: 'manual' });

  it('a re-imported identical bank row is an EXACT match (dropped, not doubled)', () => {
    const synced = tx({ id: 's', amount: -54.2, merchant: 'Woolworths', merchant_normalized: 'woolworths', date: '2026-08-10', source: 'basiq' });
    expect(classifyManualAgainstSync(manual, [synced]).result).toBe('exact');
  });
  it('a genuinely separate later shop at the same store is NOT flagged as a duplicate', () => {
    const later = tx({ id: 's2', amount: -12.0, merchant: 'Woolworths', merchant_normalized: 'woolworths', date: '2026-08-25', source: 'basiq' });
    expect(classifyManualAgainstSync(manual, [later]).result).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 7. Transfer loops
// ══════════════════════════════════════════════════════════════════════════════
describe('7. transfer loops', () => {
  it('a round-trip A→B→A nets to zero for the household and each account', () => {
    const f = buildCashFlowForecast({
      asOf: ASOF,
      accounts: [{ accountId: 'A', name: 'Everyday', balance: 1000 }, { accountId: 'B', name: 'Savings', balance: 500 }],
      inputs: [
        ri({ id: 'ab', sourceType: 'recurring_series', name: 'To Savings', amount: -300, frequency: 'once', anchorDate: addDays(ASOF, 5), accountId: 'A', transfer: { counterpartAccountId: 'B' } }),
        ri({ id: 'ba', sourceType: 'recurring_series', name: 'Back to Everyday', amount: -300, frequency: 'once', anchorDate: addDays(ASOF, 10), accountId: 'B', transfer: { counterpartAccountId: 'A' } }),
      ],
      horizons: [30],
    });
    const h = f.horizons[0];
    expect(h.outflow).toBe(0);                          // transfers excluded from spend
    expect(h.projectedBalance).toBe(1500);              // household total unchanged
    const A = f.accounts.find(a => a.accountId === 'A')!;
    const B = f.accounts.find(a => a.accountId === 'B')!;
    expect(A.d30).toBe(1000);                           // back where it started
    expect(B.d30).toBe(500);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 8. Credit-card overpayments
// ══════════════════════════════════════════════════════════════════════════════
describe('8. credit-card overpayments', () => {
  it('paying MORE than owing still books the full credit and is balance-neutral (a transfer, not income)', () => {
    const leg = buildCardPaymentLeg({ cardId: 'card-1', amount: 500 /* owing only 300 */, pairId: 'pair', fromName: 'Everyday', date: ASOF, currency: 'AUD' });
    expect(leg.amount).toBe(500);
    expect(leg.is_transfer).toBe(true);
    expect(leg.source).toBe('unknown');                 // never re-reduced by a Basiq re-sync
    const asTxn = tx({ ...leg, id: 'leg' } as any);
    expect(isSpendTransaction(asTxn)).toBe(false);
    expect(incomeInflowAmount(asTxn)).toBe(0);          // an overpayment is not income
  });
  it('once a card payment is reconciled the popup is never raised again', () => {
    const pp: Pick<PendingPayment, 'status' | 'reconciled_transaction_id'>[] = [{ status: 'reconciled', reconciled_transaction_id: 'bank-1' }];
    expect(shouldPromptCardPayment('bank-1', pp, [])).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 9. Missed bills (overdue, still unpaid)
// ══════════════════════════════════════════════════════════════════════════════
describe('9. missed bills', () => {
  it('an overdue recurring bill still projects its NEXT future occurrence (not skipped, not looping)', () => {
    const occ = generateOccurrences({ anchorDate: daysAgo(4), frequency: 'monthly' }, ASOF, addDays(ASOF, 60));
    expect(occ.length).toBeGreaterThanOrEqual(1);
    expect(occ.every(d => d > ASOF)).toBe(true);        // only future dates
  });
  it('a one-off bill whose date has already passed produces no future event', () => {
    expect(generateOccurrences({ anchorDate: daysAgo(4), frequency: 'once' }, ASOF, addDays(ASOF, 60))).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 10. Changing subscriptions (price hikes)
// ══════════════════════════════════════════════════════════════════════════════
describe('10. changing subscriptions', () => {
  const sub = subFx({ id: 's', name: 'Spotify', amount: 11.99 });
  it('a charge within 2% still matches the tracked subscription', () => {
    expect(findMatchingSubscription({ merchant: 'Spotify', amount: 12.10 }, [sub])?.id).toBe('s');
  });
  it('a real price hike beyond tolerance no longer matches (re-detected as changed)', () => {
    expect(findMatchingSubscription({ merchant: 'Spotify', amount: 13.99 }, [sub])).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 11. Merchant renames
// ══════════════════════════════════════════════════════════════════════════════
describe('11. merchant renames', () => {
  it('the "different bills" decision key is stable across a display rename (anchored on original_name)', () => {
    const before = differentDecisionKey(billFx({ id: 'b', name: 'GLOFOXPAYMENT', amount: 60 }), subFx({ id: 's', name: 'GLOFOXPAYMENT', amount: 60 }));
    const after = differentDecisionKey(billFx({ id: 'b', name: 'Gym', original_name: 'GLOFOXPAYMENT', amount: 60 }), subFx({ id: 's', name: 'Gym', original_name: 'GLOFOXPAYMENT', amount: 60 }));
    expect(after).toBe(before);
  });
  it('the user-edited name wins as the canonical name over raw import text', () => {
    const name = preferredCanonicalName(billFx({ id: 'b', name: 'NETFLIX.COM', amount: 18.99 }), subFx({ id: 's', name: 'Netflix', original_name: 'NETFLIX.COM', amount: 18.99 }));
    expect(name).toBe('Netflix');
  });
  it('a renamed subscription still suppresses its raw detected pattern (via original_name)', () => {
    const txns = [
      tx({ id: 'g1', amount: -60, merchant: 'GLOFOXPAYMENT', date: '2026-05-10' }),
      tx({ id: 'g2', amount: -60, merchant: 'GLOFOXPAYMENT', date: '2026-06-10' }),
      tx({ id: 'g3', amount: -60, merchant: 'GLOFOXPAYMENT', date: '2026-07-10' }),
      tx({ id: 'g4', amount: -60, merchant: 'GLOFOXPAYMENT', date: '2026-08-10' }),
    ];
    const renamed = subFx({ id: 's', name: 'Gym', original_name: 'GLOFOXPAYMENT', amount: 60 });
    const patterns = detectRecurringPatterns(txns, [renamed]);
    expect(patterns.some(p => p.displayMerchant.toUpperCase().includes('GLOFOX'))).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 12. Cash withdrawals
// ══════════════════════════════════════════════════════════════════════════════
describe('12. cash withdrawals', () => {
  it('an ATM withdrawal booked as a transfer is excluded from spend but moves cash', () => {
    const atm = tx({ id: 'atm', amount: -200, merchant: 'ATM WITHDRAWAL', category: 'Transfer', is_transfer: true, transaction_type: 'transfer' });
    expect(isTransferTransaction(atm)).toBe(true);
    expect(isSpendTransaction(atm)).toBe(false);
    expect(totalSpend([atm])).toBe(0);
    expect(netMovement([atm])).toBe(-200);
  });
  it('a cash purchase categorised as real spend is counted once', () => {
    const cashBuy = tx({ id: 'c', amount: -35, merchant: 'Market Stall', category: 'Groceries' });
    expect(totalSpend([cashBuy])).toBe(35);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 13. Reimbursements
// ══════════════════════════════════════════════════════════════════════════════
describe('13. reimbursements', () => {
  it('a same-merchant reimbursement is matched and nets against the purchase', () => {
    const purchase = tx({ id: 'p', amount: -80, merchant_normalized: 'flight centre', date: '2026-07-01' });
    const d = classifyRefund(tx({ id: 'reimb', amount: 80, merchant_normalized: 'flight centre', date: '2026-07-15' }), [purchase]);
    expect(d.status).toBe('matched');
  });
  it('a reimbursement from a DIFFERENT payer is not auto-guessed (left for the user)', () => {
    const purchase = tx({ id: 'p', amount: -80, merchant_normalized: 'flight centre', date: '2026-07-01' });
    const d = classifyRefund(tx({ id: 'reimb', amount: 80, merchant_normalized: 'employer payroll', date: '2026-07-15' }), [purchase]);
    expect(d.status).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 14. Annual bills
// ══════════════════════════════════════════════════════════════════════════════
describe('14. annual bills', () => {
  it('an annual bill converts to a sane monthly-equivalent rate', () => {
    expect(monthlyEquivalent(-1200, 'annually')).toBe(100);
  });
  it('an annual bill due inside the horizon lands exactly ONCE, not twelve times', () => {
    const occ = generateOccurrences({ anchorDate: addDays(ASOF, 40), frequency: 'annually' }, ASOF, addDays(ASOF, 90));
    expect(occ).toEqual([addDays(ASOF, 40)]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 15. Leap-year / month-end dates
// ══════════════════════════════════════════════════════════════════════════════
describe('15. leap-year and month-end dates', () => {
  it('a 31st-of-month charge clamps in short months then RECOVERS to the 31st', () => {
    const occ = generateOccurrences({ anchorDate: '2026-01-31', frequency: 'monthly' }, '2026-01-31', '2026-04-30');
    expect(occ).toEqual(['2026-02-28', '2026-03-31', '2026-04-30']);
  });
  it('Jan 31 + 1 month hits Feb 29 in a leap year', () => {
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });
  it('a Feb-29 annual charge rolls to Feb 28 the following (non-leap) year', () => {
    expect(addMonths('2028-02-29', 12)).toBe('2029-02-28');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 16. Sparse history
// ══════════════════════════════════════════════════════════════════════════════
describe('16. sparse history', () => {
  it('one or two deposits are not enough to project a salary', () => {
    const s = (d: string): HistoryTxn => htxn({ date: d, amount: 2000, category: 'Income', merchantKey: 'acme' });
    expect(learnFromHistory({ asOf: ASOF, knownInputs: [], history: [s(daysAgo(14))] }).income).toHaveLength(0);
    expect(learnFromHistory({ asOf: ASOF, knownInputs: [], history: [s(daysAgo(28)), s(daysAgo(14))] }).income).toHaveLength(0);
  });
  it('a category with too few points is not projected', () => {
    const dining = (d: string): HistoryTxn => htxn({ date: d, amount: -40, category: 'Dining', merchantKey: 'cafe' });
    expect(learnFromHistory({ asOf: ASOF, knownInputs: [], history: [dining(daysAgo(20)), dining(daysAgo(10))] }).categories).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 17. Unusually large purchases
// ══════════════════════════════════════════════════════════════════════════════
describe('17. unusually large purchases', () => {
  it('a one-off splurge is treated as an outlier and does not inflate the steady rate', () => {
    const { kept, removed } = removeOutliers([40, 40, 40, 40, 40, 900]);
    expect(removed).toBe(1);
    expect(kept).not.toContain(900);
  });
  it('the learned category average ignores an abnormal spike', () => {
    const dining = (d: string, a: number): HistoryTxn => htxn({ date: d, amount: a, category: 'Dining', merchantKey: 'cafe' });
    const r = learnFromHistory({ asOf: ASOF, knownInputs: [], history: [
      dining(daysAgo(61), -40), dining(daysAgo(50), -40), dining(daysAgo(40), -40),
      dining(daysAgo(30), -40), dining(daysAgo(20), -40), dining(daysAgo(10), -40),
      dining(daysAgo(15), -900),
    ] });
    const cat = r.categories.find(c => c.category === 'Dining')!;
    expect(cat.removedOutliers).toBe(1);
    expect(cat.monthlyObserved).toBeLessThan(200);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 18. Negative balances (liquidity risk)
// ══════════════════════════════════════════════════════════════════════════════
describe('18. negative balances', () => {
  it('a large outflow against a thin balance surfaces a negative projected + lowest balance', () => {
    const f = buildCashFlowForecast({
      asOf: ASOF,
      accounts: [{ accountId: 'A', name: 'Everyday', balance: 100 }],
      inputs: [ri({ id: 'rent', sourceType: 'bill', name: 'Rent', amount: -2000, frequency: 'once', anchorDate: addDays(ASOF, 10), accountId: 'A' })],
      horizons: [30],
    });
    const h = f.horizons[0];
    expect(h.projectedBalance).toBe(-1900);
    expect(h.lowestBalance).toBe(-1900);
    expect(h.lowestDate).toBe(addDays(ASOF, 10));
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 19. Deleted linked transactions
// ══════════════════════════════════════════════════════════════════════════════
describe('19. deleted linked transactions', () => {
  it('a bill whose linked subscription was DELETED survives as the sole record (not silently dropped)', () => {
    const orphan = ri({ id: 'bill-1', sourceType: 'bill', name: 'Netflix', amount: -18.99, anchorDate: addDays(ASOF, 5), links: { subscription_id: 'sub-GONE' } });
    const { kept, suppressed } = dedupeInputs([orphan]);           // the sub is not in the input set
    expect(kept.map(k => k.id)).toEqual(['bill-1']);
    expect(suppressed).toHaveLength(0);
  });
  it('a refund whose original purchase no longer exists does not falsely match', () => {
    expect(classifyRefund(tx({ id: 'r', amount: 120, merchant_normalized: 'jb hi fi', date: '2026-08-10' }), []).status).toBe('none');
  });
  it('deleting a bank txn that settled a card surfaces the reconciled payment to reverse', () => {
    const payments: PendingPayment[] = [
      { status: 'reconciled', reconciled_transaction_id: 'bank-1' } as PendingPayment,
      { status: 'reconciled', reconciled_transaction_id: 'bank-OTHER' } as PendingPayment,
    ];
    const linked = linkedCardPayments('bank-1', payments);
    expect(linked).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 20. Conflicting user rules
// ══════════════════════════════════════════════════════════════════════════════
describe('20. conflicting user rules', () => {
  it('the highest-priority matching rule wins', () => {
    const lo = rule({ id: 'lo', priority: 1, conditions: { merchant_contains: 'ACME' }, actions: { category: 'Shopping' } });
    const hi = rule({ id: 'hi', priority: 5, conditions: { merchant_contains: 'ACME' }, actions: { category: 'Business' } });
    expect(applyRules(cand({ amount: -20 }), [lo, hi], 'u1')?.actions.category).toBe('Business');
  });
  it('among equal priorities the most recently created rule wins', () => {
    const older = rule({ id: 'o', priority: 2, created_at: '2026-01-01', conditions: { merchant_contains: 'ACME' }, actions: { category: 'Old' } });
    const newer = rule({ id: 'n', priority: 2, created_at: '2026-06-01', conditions: { merchant_contains: 'ACME' }, actions: { category: 'New' } });
    expect(applyRules(cand({ amount: -20 }), [older, newer], 'u1')?.actions.category).toBe('New');
  });
  it('a disabled rule is ignored even at higher priority', () => {
    const disabled = rule({ id: 'd', priority: 9, enabled: false, conditions: { merchant_contains: 'ACME' }, actions: { category: 'Nope' } });
    const active = rule({ id: 'a', priority: 1, conditions: { merchant_contains: 'ACME' }, actions: { category: 'Yes' } });
    expect(applyRules(cand({ amount: -20 }), [disabled, active], 'u1')?.actions.category).toBe('Yes');
  });
  it("another user's rule never applies", () => {
    const foreign = rule({ id: 'f', user_id: 'someone-else', priority: 9, conditions: { merchant_contains: 'ACME' }, actions: { category: 'Leak' } });
    expect(applyRules(cand({ amount: -20 }), [foreign], 'u1')).toBeNull();
  });
  it('an account-scoped rule stays scoped to its account', () => {
    const scoped = rule({ id: 's', priority: 5, conditions: { merchant_contains: 'ACME', account_id: 'acc-1' }, actions: { category: 'Scoped' } });
    expect(applyRules(cand({ amount: -20, account_id: 'acc-1' }), [scoped], 'u1')?.actions.category).toBe('Scoped');
    expect(applyRules(cand({ amount: -20, account_id: 'acc-2' }), [scoped], 'u1')).toBeNull();
  });
});
