import { describe, it, expect } from 'vitest';
import type { Transaction } from '../types';
import {
  buildDeductionView,
  deductibleTransactionsForFY,
  manualDeductionsForFY,
  availableFinancialYears,
  addManualDeduction,
  updateManualDeduction,
  removeManualDeduction,
  setDeductionLink,
  dismissDuplicate,
  isLikelyDuplicate,
  UNCATEGORISED_DEDUCTION,
  type ManualDeduction,
} from './taxDeductions';

let seq = 0;
function tx(partial: Partial<Transaction> & { amount: number }): Transaction {
  seq += 1;
  return {
    id: partial.id ?? `t${seq}`,
    user_id: 'u1', account_id: 'acc', account_type: 'bank',
    date: '2024-09-01', merchant: 'Officeworks', currency: 'AUD',
    category: 'Uncategorised', category_source: 'auto', confidence: 0.1,
    is_duplicate_flagged: false, is_subscription: false, ...partial,
  };
}

function md(partial: Partial<ManualDeduction> & { amount: number }): ManualDeduction {
  seq += 1;
  return {
    id: partial.id ?? `d${seq}`,
    name: 'Manual', category: 'Working from home',
    date: '2024-09-01', ...partial,
  };
}

// FY 2024-2025 = 1 Jul 2024 → 30 Jun 2025.

describe('financial-year filtering', () => {
  it('buckets transactions and manual deductions by their date, not by insertion', () => {
    const txns = [
      tx({ id: 'a', amount: -100, is_tax_deductible: true, date: '2024-09-01' }), // FY24-25
      tx({ id: 'b', amount: -200, is_tax_deductible: true, date: '2025-06-30' }), // FY24-25 (last day)
      tx({ id: 'c', amount: -300, is_tax_deductible: true, date: '2025-07-01' }), // FY25-26 (first day)
      tx({ id: 'd', amount: -400, is_tax_deductible: false, date: '2024-09-01' }), // not deductible
    ];
    expect(deductibleTransactionsForFY(txns, '2024-2025').map(t => t.id)).toEqual(['a', 'b']);
    expect(deductibleTransactionsForFY(txns, '2025-2026').map(t => t.id)).toEqual(['c']);

    const manual = [
      md({ id: 'm1', amount: 50, date: '2024-12-01' }),   // FY24-25
      md({ id: 'm2', amount: 60, date: '2025-08-01' }),   // FY25-26
    ];
    expect(manualDeductionsForFY(manual, '2024-2025').map(d => d.id)).toEqual(['m1']);
    expect(manualDeductionsForFY(manual, '2025-2026').map(d => d.id)).toEqual(['m2']);
  });

  it('lists available financial years newest-first from both sources', () => {
    const txns = [
      tx({ amount: -1, is_tax_deductible: true, date: '2023-08-01' }),
      tx({ amount: -1, is_tax_deductible: false, date: '2026-08-01' }), // excluded — not deductible
    ];
    const manual = [md({ amount: 1, date: '2025-08-01' })];
    expect(availableFinancialYears(txns, manual)).toEqual(['2025-2026', '2023-2024']);
  });
});

describe('buildDeductionView — grouping + totals', () => {
  it('merges both sources, groups by category, and totals per group and overall', () => {
    const txns = [
      tx({ id: 'a', amount: -110, is_tax_deductible: true, deduction_category: 'Tools, equipment & assets', merchant: 'Officeworks' }),
      tx({ id: 'b', amount: -40, is_tax_deductible: true, deduction_category: 'Phone, data & internet', merchant: 'Telstra' }),
    ];
    const manual = [
      md({ id: 'm1', amount: 90, category: 'Tools, equipment & assets', name: 'USB hub' }),
      md({ id: 'm2', amount: 300, category: 'Working from home', name: 'WFH hours' }),
    ];
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });

    expect(view.total).toBe(540);            // 110 + 40 + 90 + 300
    expect(view.manualTotal).toBe(390);      // 90 + 300
    expect(view.transactionTotal).toBe(150); // 110 + 40
    expect(view.lineCount).toBe(4);

    // groups sorted by total desc: WFH 300, Tools 200, Phone 40
    expect(view.groups.map(g => [g.category, g.total])).toEqual([
      ['Working from home', 300],
      ['Tools, equipment & assets', 200],
      ['Phone, data & internet', 40],
    ]);
  });

  it('uses abs() of a negative transaction amount and links each tx line back to its source', () => {
    const view = buildDeductionView({
      transactions: [tx({ id: 'a', amount: -123.45, is_tax_deductible: true, merchant: 'JB Hi-Fi' })],
      manualDeductions: [],
      fy: '2024-2025',
    });
    const line = view.groups[0].lines[0];
    expect(line.amount).toBe(123.45);
    expect(line.source).toBe('transaction');
    expect(line.transactionId).toBe('a');
    expect(line.merchant).toBe('JB Hi-Fi');
  });

  it('files a category-less deduction under Uncategorised', () => {
    const view = buildDeductionView({
      transactions: [tx({ amount: -10, is_tax_deductible: true, deduction_category: null })],
      manualDeductions: [md({ amount: 5, category: '' })],
      fy: '2024-2025',
    });
    expect(view.groups.map(g => g.category)).toEqual([UNCATEGORISED_DEDUCTION]);
    expect(view.groups[0].total).toBe(15);
  });

  it('excludes out-of-FY items from the view entirely', () => {
    const view = buildDeductionView({
      transactions: [tx({ amount: -100, is_tax_deductible: true, date: '2025-07-01' })], // FY25-26
      manualDeductions: [md({ amount: 50, date: '2025-07-01' })],                          // FY25-26
      fy: '2024-2025',
    });
    expect(view.total).toBe(0);
    expect(view.groups).toEqual([]);
  });
});

describe('duplicate prevention — a linked manual deduction supersedes its transaction', () => {
  it('drops the linked transaction line so the expense is counted once', () => {
    const txns = [
      tx({ id: 'a', amount: -200, is_tax_deductible: true, deduction_category: 'Self-education', merchant: 'Udemy' }),
      tx({ id: 'b', amount: -50, is_tax_deductible: true, deduction_category: 'Self-education', merchant: 'Book Depository' }),
    ];
    const manual = [
      // Represents transaction 'a' — same expense, entered manually and linked.
      md({ id: 'm1', amount: 200, category: 'Self-education', name: 'Online course', source_transaction_id: 'a' }),
    ];
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });

    // 'a' must NOT appear as its own transaction line.
    const txLineIds = view.groups.flatMap(g => g.lines).filter(l => l.source === 'transaction').map(l => l.id);
    expect(txLineIds).toEqual(['b']);
    expect(view.linkedTransactionIds).toEqual(['a']);

    // Total is 200 (manual, once) + 50 (tx b) — NOT 200 + 200 + 50.
    expect(view.total).toBe(250);
    expect(view.manualTotal).toBe(200);
    expect(view.transactionTotal).toBe(50);

    const linkedLine = view.groups.flatMap(g => g.lines).find(l => l.id === 'm1')!;
    expect(linkedLine.linked).toBe(true);
    expect(linkedLine.transactionId).toBe('a'); // still links back to its source
  });

  it('re-counts a genuinely distinct transaction once the link is removed', () => {
    // The manual entry is clearly a DIFFERENT expense (different category + name),
    // only joined by an explicit link — removing it must restore both as separate.
    const txns = [tx({ id: 'a', amount: -200, is_tax_deductible: true, deduction_category: 'Self-education', merchant: 'Udemy' })];
    let manual = [md({ id: 'm1', amount: 200, category: 'Working from home', name: 'WFH running costs', source_transaction_id: 'a', date: '2024-11-15' })];

    // Linked: only the manual line counts → 200.
    expect(buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' }).total).toBe(200);

    // Remove the link → the manual entry and the transaction are now separate
    // (and they don't look alike, so the heuristic leaves them both counted).
    manual = setDeductionLink(manual, 'm1', null);
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });
    expect(view.total).toBe(400);
    expect(view.linkedTransactionIds).toEqual([]);
    expect(view.suspectedDuplicates).toEqual([]);
  });

  it('downgrades an unlinked look-alike from a hard link to a suspected duplicate (still counted once)', () => {
    const txns = [tx({ id: 'a', amount: -200, is_tax_deductible: true, deduction_category: 'Self-education', merchant: 'Udemy', date: '2024-09-01' })];
    let manual = [md({ id: 'm1', amount: 200, category: 'Self-education', name: 'Udemy course', date: '2024-09-01', source_transaction_id: 'a' })];

    // Explicitly linked → tx dropped, counted once, no review flag.
    let view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });
    expect(view.total).toBe(200);
    expect(view.suspectedDuplicates).toEqual([]);

    // Unlink identical-looking records → heuristic catches them, still 200 but now flagged.
    manual = setDeductionLink(manual, 'm1', null);
    view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });
    expect(view.total).toBe(200);
    expect(view.linkedTransactionIds).toEqual([]);
    expect(view.suspectedDuplicates.map(s => [s.manualId, s.transactionId])).toEqual([['m1', 'a']]);
  });
});

describe('heuristic duplicate detection — unlinked same expense counted once', () => {
  // The bug: a $12 deductible transaction AND a $12 manual deduction for the same
  // expense, with no explicit link, both counted → $24. It must resolve to $12.
  it('excludes the look-alike transaction from totals and flags the pair (was $24, now $12)', () => {
    const txns = [tx({ id: 'a', amount: -12, is_tax_deductible: true, deduction_category: 'Self-education', merchant: 'Udemy', date: '2024-09-01' })];
    const manual = [md({ id: 'm1', amount: 12, category: 'Self-education', name: 'Online course', date: '2024-09-01' })];
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });

    expect(view.total).toBe(12);           // counted once, not 24
    expect(view.manualTotal).toBe(12);
    expect(view.transactionTotal).toBe(0); // the tx line is excluded

    // Both records survive — nothing deleted; the tx line is present but flagged + excluded.
    const txLine = view.groups.flatMap(g => g.lines).find(l => l.source === 'transaction')!;
    expect(txLine.suspectedDuplicate).toBe(true);
    expect(txLine.excluded).toBe(true);
    expect(txLine.duplicateOf).toBe('m1');

    const manualLine = view.groups.flatMap(g => g.lines).find(l => l.source === 'manual')!;
    expect(manualLine.suspectedDuplicate).toBe(true);
    expect(manualLine.excluded).toBe(false); // the manual line is the one that counts
    expect(manualLine.duplicateOf).toBe('a');

    expect(view.suspectedDuplicates).toEqual([
      { manualId: 'm1', transactionId: 'a', amount: 12, name: 'Online course', category: 'Self-education', merchant: 'Udemy', date: '2024-09-01' },
    ]);
    // The flagged tx line does not inflate its category group total.
    const group = view.groups.find(g => g.category === 'Self-education')!;
    expect(group.total).toBe(12);
  });

  it('is order-independent — manual→transaction and transaction→manual give the same result', () => {
    // Two pairs where naive first-come matching could pair records crosswise
    // depending on insertion order; internal sorting must make order irrelevant.
    const t1 = tx({ id: 'a', amount: -30, is_tax_deductible: true, deduction_category: 'Self-education', merchant: 'Udemy', date: '2024-09-01' });
    const t2 = tx({ id: 'b', amount: -30, is_tax_deductible: true, deduction_category: 'Self-education', merchant: 'Coursera', date: '2024-09-02' });
    const m1 = md({ id: 'm1', amount: 30, category: 'Self-education', name: 'Course A', date: '2024-09-01' });
    const m2 = md({ id: 'm2', amount: 30, category: 'Self-education', name: 'Course B', date: '2024-09-02' });

    const forward = buildDeductionView({ transactions: [t1, t2], manualDeductions: [m1, m2], fy: '2024-2025' });
    const reverse = buildDeductionView({ transactions: [t2, t1], manualDeductions: [m2, m1], fy: '2024-2025' });

    expect(forward.total).toBe(60);   // 2×30 counted once each
    expect(reverse.total).toBe(60);
    expect(forward.suspectedDuplicates).toEqual(reverse.suspectedDuplicates);
    // Pairing is by date (m1↔a on the 1st, m2↔b on the 2nd) regardless of input order.
    expect([...forward.suspectedDuplicates].sort((x, y) => x.manualId.localeCompare(y.manualId))
      .map(s => [s.manualId, s.transactionId])).toEqual([['m1', 'a'], ['m2', 'b']]);
  });

  it('matches on description/merchant overlap even when categories differ', () => {
    const txns = [tx({ id: 'a', amount: -80, is_tax_deductible: true, deduction_category: 'Other work-related', merchant: 'Officeworks Chatswood', date: '2024-05-05' })];
    const manual = [md({ id: 'm1', amount: 80, category: 'Tools, equipment & assets', name: 'Officeworks standing desk', date: '2024-05-06' })];
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2023-2024' });
    expect(view.total).toBe(80);
    expect(view.suspectedDuplicates.map(s => s.transactionId)).toEqual(['a']);
  });

  it('stays conservative — different amount, far dates, or no corroboration are NOT duplicates', () => {
    // amount differs
    expect(isLikelyDuplicate(md({ amount: 12 }), tx({ amount: -13, is_tax_deductible: true }))).toBe(false);
    // amount + category match but dates are 10 days apart
    expect(isLikelyDuplicate(
      md({ amount: 50, category: 'Self-education', date: '2024-09-01' }),
      tx({ amount: -50, is_tax_deductible: true, deduction_category: 'Self-education', date: '2024-09-11' }),
    )).toBe(false);
    // amount + date match but different category AND no shared description token
    expect(isLikelyDuplicate(
      md({ amount: 50, category: 'Other work-related', name: 'Gym membership', date: '2024-09-01' }),
      tx({ amount: -50, is_tax_deductible: true, deduction_category: 'Phone, data & internet', merchant: 'Telstra', date: '2024-09-01' }),
    )).toBe(false);
    // a genuine match returns true
    expect(isLikelyDuplicate(
      md({ amount: 50, category: 'Self-education', date: '2024-09-01' }),
      tx({ amount: -50, is_tax_deductible: true, deduction_category: 'Self-education', date: '2024-09-02' }),
    )).toBe(true);
  });

  it('two distinct same-amount pairs match one-to-one, not crosswise', () => {
    const txns = [
      tx({ id: 'a', amount: -50, is_tax_deductible: true, deduction_category: 'Self-education', date: '2024-09-01' }),
      tx({ id: 'b', amount: -50, is_tax_deductible: true, deduction_category: 'Self-education', date: '2024-09-01' }),
    ];
    const manual = [
      md({ id: 'm1', amount: 50, category: 'Self-education', name: 'Course one', date: '2024-09-01' }),
      md({ id: 'm2', amount: 50, category: 'Self-education', name: 'Course two', date: '2024-09-01' }),
    ];
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });
    expect(view.total).toBe(100);                 // 2×50 counted once each, not 200
    expect(view.suspectedDuplicates).toHaveLength(2);
    // each transaction is claimed by exactly one distinct manual
    const claimedByTx = new Map(view.suspectedDuplicates.map(s => [s.transactionId, s.manualId]));
    expect(new Set(claimedByTx.values()).size).toBe(2);
  });

  it('an explicit link takes precedence — the tx is dropped, not flagged as a suspected duplicate', () => {
    const txns = [tx({ id: 'a', amount: -12, is_tax_deductible: true, deduction_category: 'Self-education', date: '2024-09-01' })];
    const manual = [md({ id: 'm1', amount: 12, category: 'Self-education', date: '2024-09-01', source_transaction_id: 'a' })];
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });
    expect(view.total).toBe(12);
    expect(view.suspectedDuplicates).toEqual([]);          // handled by the explicit link
    expect(view.linkedTransactionIds).toEqual(['a']);
    expect(view.groups.flatMap(g => g.lines).some(l => l.source === 'transaction')).toBe(false); // dropped
  });

  it('"keep both" (dismissDuplicate) suppresses detection so both records count again', () => {
    const txns = [tx({ id: 'a', amount: -12, is_tax_deductible: true, deduction_category: 'Self-education', date: '2024-09-01' })];
    let manual = [md({ id: 'm1', amount: 12, category: 'Self-education', name: 'Online course', date: '2024-09-01' })];

    // Detected as a duplicate → counted once.
    expect(buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' }).total).toBe(12);

    // User says they're genuinely separate → both count.
    manual = dismissDuplicate(manual, 'm1', 'a');
    const view = buildDeductionView({ transactions: txns, manualDeductions: manual, fy: '2024-2025' });
    expect(view.total).toBe(24);
    expect(view.suspectedDuplicates).toEqual([]);
    expect(view.groups.flatMap(g => g.lines).every(l => !l.excluded)).toBe(true);
  });
});

describe('dismissDuplicate — persistence semantics', () => {
  it('records the tx id immutably, is idempotent, and no-ops on unknown/blank input', () => {
    const before = [md({ id: 'm1', amount: 12 }), md({ id: 'm2', amount: 20 })];
    const after = dismissDuplicate(before, 'm1', 't1');
    expect(before[0].not_duplicate_of).toBeUndefined();      // original untouched
    expect(after.find(d => d.id === 'm1')!.not_duplicate_of).toEqual(['t1']);
    expect(after.find(d => d.id === 'm2')).toEqual(before[1]); // sibling unchanged

    // idempotent — dismissing the same pair twice keeps a single entry
    expect(dismissDuplicate(after, 'm1', 't1').find(d => d.id === 'm1')!.not_duplicate_of).toEqual(['t1']);
    // a second distinct tx appends
    expect(dismissDuplicate(after, 'm1', 't2').find(d => d.id === 'm1')!.not_duplicate_of).toEqual(['t1', 't2']);
    // unknown id and blank tx id are no-ops
    expect(dismissDuplicate(before, 'missing', 't1')).toEqual(before);
    expect(dismissDuplicate(before, 'm1', '  ')).toEqual(before);
  });
});

describe('pure list mutators — persistence semantics (what deductionsDS writes)', () => {
  it('adds immutably with injected id/created_at and normalises a blank link to null', () => {
    const before: ManualDeduction[] = [];
    const after = addManualDeduction(before, { name: 'Desk', amount: 250, category: 'Tools, equipment & assets', date: '2024-10-01', source_transaction_id: '   ' }, { id: 'new1', now: '2024-10-02T00:00:00Z' });
    expect(before).toEqual([]); // original untouched
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: 'new1', name: 'Desk', amount: 250, created_at: '2024-10-02T00:00:00Z', source_transaction_id: null });
  });

  it('updates a record by id and leaves the rest untouched', () => {
    const list = [md({ id: 'a', amount: 10 }), md({ id: 'b', amount: 20 })];
    const after = updateManualDeduction(list, 'b', { amount: 25, name: 'Fixed' });
    expect(after.find(d => d.id === 'b')).toMatchObject({ amount: 25, name: 'Fixed' });
    expect(after.find(d => d.id === 'a')).toEqual(list[0]); // unchanged
    expect(updateManualDeduction(list, 'missing', { amount: 99 })).toEqual(list); // no-op on unknown id
  });

  it('sets and clears the transaction link', () => {
    const list = [md({ id: 'a', amount: 10 })];
    const linked = setDeductionLink(list, 'a', 't99');
    expect(linked[0].source_transaction_id).toBe('t99');
    expect(setDeductionLink(linked, 'a', null)[0].source_transaction_id).toBeNull();
    // updateManualDeduction also normalises a link edit
    expect(updateManualDeduction(linked, 'a', { source_transaction_id: '' })[0].source_transaction_id).toBeNull();
  });

  it('removes a record by id', () => {
    const list = [md({ id: 'a', amount: 10 }), md({ id: 'b', amount: 20 })];
    expect(removeManualDeduction(list, 'a').map(d => d.id)).toEqual(['b']);
    expect(removeManualDeduction(list, 'missing')).toHaveLength(2);
  });
});
