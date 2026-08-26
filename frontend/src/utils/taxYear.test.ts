/**
 * Phase 5.1 — Australian tax-year position.
 *
 * Every FY here is written out explicitly (1 Jul → 30 Jun) so a boundary bug
 * shows up as a failing year, not a rounding difference.
 */
import { describe, it, expect } from 'vitest';
import type { Transaction, IncomeEntry, Property } from '../types';
import type { PayslipCore } from './payroll';
import type { ManualDeduction } from './taxDeductions';
import {
  buildTaxYearPosition,
  buildIncomeSummary,
  availableTaxYears,
  isBusinessIncomeTransaction,
  isLikelyDuplicateIncome,
  fyBounds,
  isDateInFY,
  shiftFY,
  formatFY,
} from './taxYear';
import { buildCapitalGainsPosition, type CapitalGainsPosition } from './capitalGains';
import type { DividendStatement } from './dividendIncome';
import { buildRentalPosition, type RentalPropertySettings } from './rentalProperty';

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

function deductibleTx(partial: Partial<Transaction> & { amount: number }): Transaction {
  return tx({ is_tax_deductible: true, deduction_category: 'Tools, equipment & assets', ...partial });
}

function md(partial: Partial<ManualDeduction> & { amount: number }): ManualDeduction {
  seq += 1;
  return {
    id: partial.id ?? `d${seq}`,
    name: 'Manual', category: 'Working from home',
    date: '2024-09-01', ...partial,
  };
}

function income(partial: Partial<IncomeEntry> & { amount: number }): IncomeEntry {
  seq += 1;
  return {
    id: partial.id ?? `i${seq}`,
    source: 'Acme Pty Ltd', currency: 'AUD', category: 'Salary',
    is_recurring: false, date: '2024-09-01', status: 'approved', ...partial,
  };
}

function payslip(partial: Partial<PayslipCore> & { gross_pay: number }): PayslipCore {
  seq += 1;
  return {
    id: partial.id ?? `p${seq}`,
    employer: 'Acme Pty Ltd', employment_type: 'full_time', pay_frequency: 'fortnightly',
    payment_date: '2024-09-01', net_pay: partial.gross_pay * 0.7,
    tax_withheld: 0, super_amount: 0, ...partial,
  };
}

/** Build a position with everything defaulted to empty. */
function position(input: {
  fy: string;
  transactions?: Transaction[];
  manualDeductions?: ManualDeduction[];
  incomeEntries?: IncomeEntry[];
  payslips?: PayslipCore[];
}) {
  return buildTaxYearPosition({
    fy: input.fy,
    transactions: input.transactions ?? [],
    manualDeductions: input.manualDeductions ?? [],
    incomeEntries: input.incomeEntries ?? [],
    payslips: input.payslips ?? [],
  });
}

// ─── 1 July – 30 June boundaries ─────────────────────────────────────────────

describe('financial-year boundaries', () => {
  it('runs 1 July to 30 June inclusive', () => {
    expect(fyBounds('2024-2025')).toEqual({ start: '2024-07-01', end: '2025-06-30' });
    expect(isDateInFY('2024-07-01', '2024-2025')).toBe(true);   // first day
    expect(isDateInFY('2025-06-30', '2024-2025')).toBe(true);   // last day
    expect(isDateInFY('2024-06-30', '2024-2025')).toBe(false);  // day before
    expect(isDateInFY('2025-07-01', '2024-2025')).toBe(false);  // day after
  });

  it('reads a plain date from the string, so no time zone can shift a boundary', () => {
    // `new Date('2024-07-01')` is UTC midnight, which reads back as 30 June in
    // any negative-offset zone. String comparison cannot drift.
    expect(isDateInFY('2024-07-01T00:00:00Z', '2024-2025')).toBe(true);
    expect(isDateInFY('2025-06-30T23:59:59Z', '2024-2025')).toBe(true);
  });

  it('rejects unusable dates rather than bucketing them somewhere', () => {
    expect(isDateInFY('', '2024-2025')).toBe(false);
    expect(isDateInFY(null, '2024-2025')).toBe(false);
    expect(isDateInFY('2024-07', '2024-2025')).toBe(false);
  });

  it('shifts and labels years', () => {
    expect(shiftFY('2024-2025', -1)).toBe('2023-2024');
    expect(shiftFY('2024-2025', 1)).toBe('2025-2026');
    expect(formatFY('2024-2025')).toBe('2024–25');
  });

  it('places income and deductions on the right side of 30 June', () => {
    const txns = [
      deductibleTx({ id: 'last-day', amount: -100, date: '2025-06-30' }),
      deductibleTx({ id: 'next-day', amount: -200, date: '2025-07-01' }),
    ];
    const entries = [
      income({ id: 'in-24', amount: 1000, date: '2025-06-30' }),
      income({ id: 'in-25', amount: 2000, date: '2025-07-01' }),
    ];

    const fy24 = position({ fy: '2024-2025', transactions: txns, incomeEntries: entries });
    expect(fy24.assessableIncome).toBe(1000);
    expect(fy24.deductibleExpenses).toBe(100);
    expect(fy24.estimatedTaxableIncome).toBe(900);

    const fy25 = position({ fy: '2025-2026', transactions: txns, incomeEntries: entries });
    expect(fy25.assessableIncome).toBe(2000);
    expect(fy25.deductibleExpenses).toBe(200);
    expect(fy25.estimatedTaxableIncome).toBe(1800);
  });
});

// ─── Multiple financial years ────────────────────────────────────────────────

describe('multiple financial years', () => {
  const txns = [
    deductibleTx({ id: 'a', amount: -500, date: '2023-11-01' }),   // FY23-24
    deductibleTx({ id: 'b', amount: -300, date: '2024-10-01' }),   // FY24-25
    deductibleTx({ id: 'c', amount: -900, date: '2025-08-01' }),   // FY25-26
  ];
  const entries = [
    income({ id: 'y1', amount: 60_000, date: '2023-12-01', tax_withheld: 12_000 }),
    income({ id: 'y2', amount: 80_000, date: '2024-12-01', tax_withheld: 18_000 }),
    income({ id: 'y3', amount: 95_000, date: '2025-12-01', tax_withheld: 22_000 }),
  ];
  const manual = [
    md({ id: 'm1', amount: 200, date: '2023-11-15' }),
    md({ id: 'm2', amount: 400, date: '2024-11-15' }),
  ];

  it('keeps each year independent — one FY never leaks into another', () => {
    const y1 = position({ fy: '2023-2024', transactions: txns, incomeEntries: entries, manualDeductions: manual });
    const y2 = position({ fy: '2024-2025', transactions: txns, incomeEntries: entries, manualDeductions: manual });
    const y3 = position({ fy: '2025-2026', transactions: txns, incomeEntries: entries, manualDeductions: manual });

    expect(y1.assessableIncome).toBe(60_000);
    expect(y1.deductibleExpenses).toBe(700);        // 500 tx + 200 manual
    expect(y1.estimatedTaxableIncome).toBe(59_300);
    expect(y1.taxWithheld).toBe(12_000);

    expect(y2.assessableIncome).toBe(80_000);
    expect(y2.deductibleExpenses).toBe(700);        // 300 tx + 400 manual
    expect(y2.estimatedTaxableIncome).toBe(79_300);

    expect(y3.assessableIncome).toBe(95_000);
    expect(y3.deductibleExpenses).toBe(900);
    expect(y3.estimatedTaxableIncome).toBe(94_100);
  });

  it('reports the FY bounds it used', () => {
    const y2 = position({ fy: '2024-2025' });
    expect(y2.start).toBe('2024-07-01');
    expect(y2.end).toBe('2025-06-30');
  });

  it('lists every year that has anything in it, newest first', () => {
    expect(availableTaxYears({
      transactions: txns,
      manualDeductions: manual,
      incomeEntries: entries,
      payslips: [payslip({ gross_pay: 100, payment_date: '2022-08-01' })],
    })).toEqual(['2025-2026', '2024-2025', '2023-2024', '2022-2023']);
  });

  it('returns a zeroed position for a year with nothing in it', () => {
    const empty = position({ fy: '2019-2020', transactions: txns, incomeEntries: entries });
    expect(empty.assessableIncome).toBe(0);
    expect(empty.deductibleExpenses).toBe(0);
    expect(empty.estimatedTaxableIncome).toBe(0);
    expect(empty.income.lines).toEqual([]);
  });
});

// ─── Income changes ──────────────────────────────────────────────────────────

describe('income changes', () => {
  it('tracks a raise across years, and deductions bite in the year they fall', () => {
    const entries = [
      income({ id: 'a', amount: 70_000, date: '2024-08-01' }),
      income({ id: 'b', amount: 90_000, date: '2025-08-01' }),  // raise, next FY
    ];
    const before = position({ fy: '2024-2025', incomeEntries: entries });
    const after = position({ fy: '2025-2026', incomeEntries: entries });
    expect(after.assessableIncome - before.assessableIncome).toBe(20_000);
  });

  it('adds a second income source within one year', () => {
    const entries = [
      income({ id: 'a', amount: 70_000, date: '2024-08-01', category: 'Salary' }),
      income({ id: 'b', amount: 5_000, date: '2025-02-01', category: 'Dividends', source: 'CBA' }),
    ];
    const p = position({ fy: '2024-2025', incomeEntries: entries });
    expect(p.assessableIncome).toBe(75_000);
    expect(p.income.groups.map(g => [g.category, g.total])).toEqual([
      ['Salary', 70_000],
      ['Dividends', 5_000],
    ]);
  });

  it('never lets deductions push taxable income below zero', () => {
    const p = position({
      fy: '2024-2025',
      incomeEntries: [income({ amount: 1_000, date: '2024-08-01' })],
      manualDeductions: [md({ amount: 5_000, date: '2024-08-01' })],
    });
    expect(p.assessableIncome).toBe(1_000);
    expect(p.deductibleExpenses).toBe(5_000);
    expect(p.estimatedTaxableIncome).toBe(0);
  });

  it('excludes pending income but keeps it visible with a reason', () => {
    const p = position({
      fy: '2024-2025',
      incomeEntries: [
        income({ id: 'ok', amount: 50_000, date: '2024-08-01', tax_withheld: 9_000 }),
        income({ id: 'maybe', amount: 4_000, date: '2024-09-01', status: 'pending', tax_withheld: 500 }),
      ],
    });
    expect(p.assessableIncome).toBe(50_000);
    expect(p.taxWithheld).toBe(9_000);              // pending withholding excluded too
    const pending = p.income.excluded.find(l => l.id === 'maybe');
    expect(pending?.excludedReason).toBe('pending');
    expect(pending?.amount).toBe(4_000);            // still shown
    expect(p.notes.some(n => n.kind === 'pending-income')).toBe(true);
  });

  it('takes employment income from payslips, with the withholding behind it', () => {
    const p = position({
      fy: '2024-2025',
      payslips: [
        payslip({ gross_pay: 3_000, tax_withheld: 800, payment_date: '2024-08-01' }),
        payslip({ gross_pay: 3_000, tax_withheld: 800, payment_date: '2024-08-15' }),
      ],
    });
    expect(p.assessableIncome).toBe(6_000);
    expect(p.taxWithheld).toBe(1_600);
    expect(p.income.employment).toBe(6_000);
  });

  it('prefers a payslip YTD figure over summing slips (it already accumulates)', () => {
    const p = position({
      fy: '2024-2025',
      payslips: [
        payslip({ gross_pay: 3_000, tax_withheld: 800, payment_date: '2024-08-01' }),
        payslip({ gross_pay: 3_000, tax_withheld: 800, payment_date: '2025-06-01', ytd_gross: 78_000, ytd_tax: 20_800 }),
      ],
    });
    expect(p.assessableIncome).toBe(78_000);
    expect(p.taxWithheld).toBe(20_800);
  });
});

// ─── Income double counting ──────────────────────────────────────────────────

describe('income is never counted twice', () => {
  it('drops a payslip-derived income entry when the payslip totals already carry it', () => {
    const p = position({
      fy: '2024-2025',
      payslips: [payslip({ gross_pay: 3_000, tax_withheld: 800, payment_date: '2024-08-01' })],
      incomeEntries: [income({ id: 'mirror', amount: 3_000, date: '2024-08-01', reference_number: 'payslip:abc', tax_withheld: 800 })],
    });
    expect(p.assessableIncome).toBe(3_000);     // not 6,000
    expect(p.taxWithheld).toBe(800);            // not 1,600
    const mirrored = p.income.excluded.find(l => l.id === 'mirror');
    expect(mirrored?.excludedReason).toBe('counted-in-payslip');
    expect(mirrored?.duplicateOf).toBe('Acme Pty Ltd');
  });

  it('keeps a payslip-derived entry when its payslip is gone (nothing else counts it)', () => {
    const p = position({
      fy: '2024-2025',
      payslips: [],
      incomeEntries: [income({ id: 'orphan', amount: 3_000, date: '2024-08-01', reference_number: 'payslip:abc' })],
    });
    expect(p.assessableIncome).toBe(3_000);
    expect(p.income.excluded).toEqual([]);
  });

  it('counts business income tagged on a transaction', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [tx({ id: 'b1', amount: 2_200, date: '2024-09-10', merchant: 'Client Co', transaction_type: 'income', entity: 'business' })],
    });
    expect(p.assessableIncome).toBe(2_200);
    expect(p.business.income).toBe(2_200);
    expect(p.personal.income).toBe(0);
  });

  it('never treats a bare positive transaction as income', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        tx({ id: 'x', amount: 5_000, date: '2024-09-10', merchant: 'Mystery deposit' }),
        tx({ id: 'y', amount: 5_000, date: '2024-09-10', transaction_type: 'income' }), // no entity ⇒ personal, not picked up
      ],
    });
    expect(p.assessableIncome).toBe(0);
    expect(isBusinessIncomeTransaction(tx({ amount: 5_000, transaction_type: 'income' }))).toBe(false);
  });

  it('flags a business-income transaction that mirrors an approved income entry', () => {
    const p = position({
      fy: '2024-2025',
      incomeEntries: [income({ id: 'e1', amount: 2_200, date: '2024-09-10', source: 'Client Co', category: 'Freelance/Contractor' })],
      transactions: [tx({ id: 'b1', amount: 2_200, date: '2024-09-11', merchant: 'Client Co', transaction_type: 'income', entity: 'business' })],
    });
    expect(p.assessableIncome).toBe(2_200);     // counted once
    const dropped = p.income.excluded.find(l => l.id === 'b1');
    expect(dropped?.excludedReason).toBe('possible-duplicate');
    expect(dropped?.duplicateOf).toBe('e1');
    expect(p.notes.some(n => n.kind === 'duplicate')).toBe(true);
  });

  it('keeps two genuinely separate receipts of the same size', () => {
    const p = position({
      fy: '2024-2025',
      incomeEntries: [income({ id: 'e1', amount: 2_200, date: '2024-09-10', source: 'Client Co', category: 'Freelance/Contractor' })],
      transactions: [
        // Different payer, different week — nothing corroborates a match.
        tx({ id: 'b1', amount: 2_200, date: '2024-11-20', merchant: 'Other Client', transaction_type: 'income', entity: 'business', category: 'Consulting' }),
      ],
    });
    expect(p.assessableIncome).toBe(4_400);
    expect(p.income.excluded).toEqual([]);
  });

  it('one income entry can only absorb one transaction', () => {
    const p = position({
      fy: '2024-2025',
      incomeEntries: [income({ id: 'e1', amount: 1_000, date: '2024-09-10', source: 'Client Co', category: 'Freelance/Contractor' })],
      transactions: [
        tx({ id: 'b1', amount: 1_000, date: '2024-09-10', merchant: 'Client Co', transaction_type: 'income', entity: 'business' }),
        tx({ id: 'b2', amount: 1_000, date: '2024-09-11', merchant: 'Client Co', transaction_type: 'income', entity: 'business' }),
      ],
    });
    // The entry covers one of them; the second is a real, separate receipt.
    expect(p.assessableIncome).toBe(2_000);
    expect(p.income.excluded.map(l => l.id)).toEqual(['b1']);
  });

  it('ignores transfers and refunds tagged as business income', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        tx({ id: 'tr', amount: 900, date: '2024-09-10', transaction_type: 'income', entity: 'business', is_transfer: true }),
        tx({ id: 'rf', amount: 400, date: '2024-09-10', transaction_type: 'refund', entity: 'business' }),
      ],
    });
    expect(p.assessableIncome).toBe(0);
  });

  it('duplicate income detection needs amount, date AND a corroborating signal', () => {
    const e = income({ amount: 1_000, date: '2024-09-10', source: 'Client Co', category: 'Freelance/Contractor' });
    const match = tx({ amount: 1_000, date: '2024-09-11', merchant: 'Client Co', transaction_type: 'income', entity: 'business' });
    expect(isLikelyDuplicateIncome(e, match)).toBe(true);
    expect(isLikelyDuplicateIncome(e, tx({ ...match, amount: 1_000.01 }))).toBe(false);   // cents differ
    expect(isLikelyDuplicateIncome(e, tx({ ...match, date: '2024-09-20' }))).toBe(false); // too far apart
    expect(isLikelyDuplicateIncome(e, tx({ ...match, merchant: 'Someone Else', category: 'Consulting' }))).toBe(false);
  });
});

// ─── Deductions: categories, business/personal, partial claims ───────────────

describe('deductions', () => {
  it('groups by category with a share of the total', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'a', amount: -600, date: '2024-08-01', deduction_category: 'Tools, equipment & assets' }),
        deductibleTx({ id: 'b', amount: -300, date: '2024-09-01', deduction_category: 'Phone, data & internet' }),
        deductibleTx({ id: 'c', amount: -100, date: '2024-10-01', deduction_category: 'Phone, data & internet' }),
      ],
    });
    expect(p.deductibleExpenses).toBe(1_000);
    expect(p.deductionCategories.map(c => [c.category, c.total, c.lineCount, c.share])).toEqual([
      ['Tools, equipment & assets', 600, 1, 60],
      ['Phone, data & internet', 400, 2, 40],
    ]);
  });

  it('splits business and personal, defaulting an untagged claim to personal', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'biz', amount: -1_000, date: '2024-08-01', entity: 'business' }),
        deductibleTx({ id: 'per', amount: -400, date: '2024-08-02', entity: 'personal' }),
        deductibleTx({ id: 'unk', amount: -100, date: '2024-08-03' }),   // untagged
      ],
      incomeEntries: [income({ amount: 90_000, date: '2024-08-01' })],
    });
    expect(p.deductibleExpenses).toBe(1_500);
    expect(p.business.deductions).toBe(1_000);
    expect(p.personal.deductions).toBe(500);            // 400 + the untagged 100
    expect(p.business.income).toBe(0);
    expect(p.business.net).toBe(-1_000);
    expect(p.personal.net).toBe(89_500);
  });

  it('gives a manual deduction the entity of the transaction it is linked to', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [deductibleTx({ id: 'src', amount: -900, date: '2024-08-01', entity: 'business' })],
      manualDeductions: [md({ id: 'm1', amount: 540, date: '2024-08-01', source_transaction_id: 'src' })],
    });
    expect(p.business.deductions).toBe(540);
    expect(p.personal.deductions).toBe(0);
  });

  it('an explicit entity on the manual record beats the linked transaction', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [deductibleTx({ id: 'src', amount: -900, date: '2024-08-01', entity: 'business' })],
      manualDeductions: [md({ id: 'm1', amount: 540, date: '2024-08-01', source_transaction_id: 'src', entity: 'personal' })],
    });
    expect(p.personal.deductions).toBe(540);
    expect(p.business.deductions).toBe(0);
  });

  // PARTIAL DEDUCTIONS: the expense is $900, only 60% is work use. The user
  // records a $540 manual claim linked to the $900 transaction — the link stops
  // the full $900 being claimed as well.
  it('claims only the apportioned part of a partly-deductible expense', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [deductibleTx({ id: 'src', amount: -900, date: '2024-08-01' })],
      manualDeductions: [md({ id: 'm1', amount: 540, date: '2024-08-01', source_transaction_id: 'src', name: '60% work use' })],
    });
    expect(p.deductibleExpenses).toBe(540);
    expect(p.deductions.linkedTransactionIds).toEqual(['src']);
    // The transaction is represented by the manual line, not listed twice.
    expect(p.deductions.groups.flatMap(g => g.lines).map(l => l.key)).toEqual(['m:m1']);
  });

  it('flags an unlinked duplicate and counts it once, without deleting it', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [deductibleTx({ id: 'src', amount: -250, date: '2024-08-01', merchant: 'Officeworks desk', deduction_category: 'Working from home' })],
      manualDeductions: [md({ id: 'm1', amount: 250, date: '2024-08-02', name: 'Officeworks desk', category: 'Working from home' })],
    });
    expect(p.deductibleExpenses).toBe(250);              // not 500
    expect(p.deductions.suspectedDuplicates).toHaveLength(1);
    const lines = p.deductions.groups.flatMap(g => g.lines);
    expect(lines.map(l => l.key).sort()).toEqual(['m:m1', 't:src']);   // both still visible
    expect(lines.find(l => l.key === 't:src')?.excluded).toBe(true);
    expect(p.notes.some(n => n.kind === 'duplicate')).toBe(true);
  });

  it('reports a claim with no category so it can be fixed', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [deductibleTx({ id: 'a', amount: -80, date: '2024-08-01', deduction_category: null })],
    });
    expect(p.deductionCategories[0].category).toBe('Uncategorised');
    expect(p.notes.some(n => n.kind === 'uncategorised')).toBe(true);
  });
});

// ─── Refunds ─────────────────────────────────────────────────────────────────

describe('refunds', () => {
  it('a full refund cancels the deduction it reverses', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'buy', amount: -400, date: '2024-08-01', merchant: 'JB Hi-Fi' }),
        tx({ id: 'back', amount: 400, date: '2024-08-20', merchant: 'JB Hi-Fi', transaction_type: 'refund', refund_of: 'buy' }),
      ],
    });
    expect(p.deductibleExpenses).toBe(0);
    expect(p.deductions.refundedTotal).toBe(400);
    const line = p.deductions.groups[0].lines[0];
    expect(line.amount).toBe(400);        // gross claim still shown
    expect(line.netAmount).toBe(0);       // but nothing counts
  });

  it('a partial refund reduces the claim by exactly what came back', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'buy', amount: -400, date: '2024-08-01' }),
        tx({ id: 'back', amount: 150, date: '2024-08-20', transaction_type: 'refund', refund_of: 'buy' }),
      ],
    });
    expect(p.deductibleExpenses).toBe(250);
    expect(p.deductions.refundedTotal).toBe(150);
  });

  it('sums multiple part-refunds of one expense', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'buy', amount: -400, date: '2024-08-01' }),
        tx({ id: 'r1', amount: 100, date: '2024-08-10', transaction_type: 'refund', refund_of: 'buy' }),
        tx({ id: 'r2', amount: 120, date: '2024-08-20', transaction_type: 'refund', refund_of: 'buy' }),
      ],
    });
    expect(p.deductibleExpenses).toBe(180);
  });

  it('never lets an over-refund turn into a negative deduction', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'buy', amount: -400, date: '2024-08-01' }),
        tx({ id: 'back', amount: 900, date: '2024-08-20', transaction_type: 'refund', refund_of: 'buy' }),
      ],
    });
    expect(p.deductibleExpenses).toBe(0);
  });

  // A $900 expense claimed at 60% ($540). A $300 refund gives back a third of
  // the expense, so a third of the CLAIM ($180) has to go — not the full $300.
  it('apportions a refund against a partial claim', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'src', amount: -900, date: '2024-08-01' }),
        tx({ id: 'back', amount: 300, date: '2024-08-20', transaction_type: 'refund', refund_of: 'src' }),
      ],
      manualDeductions: [md({ id: 'm1', amount: 540, date: '2024-08-01', source_transaction_id: 'src' })],
    });
    expect(p.deductibleExpenses).toBe(360);   // 540 − (300 × 60%)
  });

  it('nets a refund against the manual line of a suspected-duplicate pair, once', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'src', amount: -250, date: '2024-08-01', merchant: 'Officeworks desk', deduction_category: 'Working from home' }),
        tx({ id: 'back', amount: 100, date: '2024-08-15', transaction_type: 'refund', refund_of: 'src' }),
      ],
      manualDeductions: [md({ id: 'm1', amount: 250, date: '2024-08-02', name: 'Officeworks desk', category: 'Working from home' })],
    });
    expect(p.deductibleExpenses).toBe(150);      // 250 claimed once, less the 100 back
    expect(p.deductions.refundedTotal).toBe(100);
  });

  it('does not reach back into an earlier year — it reports the recoupment instead', () => {
    const txns = [
      deductibleTx({ id: 'buy', amount: -400, date: '2024-08-01', merchant: 'JB Hi-Fi' }),   // FY24-25
      tx({ id: 'back', amount: 400, date: '2025-09-01', merchant: 'JB Hi-Fi', transaction_type: 'refund', refund_of: 'buy' }), // FY25-26
    ];
    const claimed = position({ fy: '2024-2025', transactions: txns });
    expect(claimed.deductibleExpenses).toBe(400);        // the filed year is untouched
    expect(claimed.deductions.recoupedFromOtherFY).toEqual([]);

    const received = position({ fy: '2025-2026', transactions: txns });
    expect(received.deductions.recoupedFromOtherFY).toEqual([
      expect.objectContaining({ refundId: 'back', originalTransactionId: 'buy', claimedFY: '2024-2025', amount: 400 }),
    ]);
    expect(received.notes.some(n => n.kind === 'recouped')).toBe(true);
    expect(received.deductibleExpenses).toBe(0);
  });

  it('ignores an inflow that is not a matched refund', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'buy', amount: -400, date: '2024-08-01' }),
        tx({ id: 'mystery', amount: 400, date: '2024-08-20' }),                          // no type
        tx({ id: 'loose', amount: 400, date: '2024-08-21', transaction_type: 'refund' }), // unmatched
      ],
    });
    expect(p.deductibleExpenses).toBe(400);
  });
});

// ─── The estimate handed to the tax calculation ──────────────────────────────

describe('estimated taxable income', () => {
  it('is assessable income less deductions, across all sources at once', () => {
    const p = position({
      fy: '2024-2025',
      payslips: [payslip({ gross_pay: 60_000, tax_withheld: 13_000, payment_date: '2025-06-01', ytd_gross: 60_000, ytd_tax: 13_000 })],
      incomeEntries: [
        income({ id: 'div', amount: 1_500, date: '2024-11-01', category: 'Dividends', source: 'CBA' }),
        income({ id: 'pend', amount: 800, date: '2024-12-01', status: 'pending' }),
      ],
      transactions: [
        tx({ id: 'biz', amount: 4_000, date: '2024-10-01', merchant: 'Client Co', transaction_type: 'income', entity: 'business' }),
        deductibleTx({ id: 'gear', amount: -1_200, date: '2024-09-01', entity: 'business' }),
        tx({ id: 'back', amount: 200, date: '2024-09-20', transaction_type: 'refund', refund_of: 'gear' }),
      ],
      manualDeductions: [md({ id: 'wfh', amount: 300, date: '2025-03-01' })],
    });

    expect(p.assessableIncome).toBe(65_500);          // 60,000 + 1,500 + 4,000 (pending excluded)
    expect(p.deductibleExpenses).toBe(1_300);         // (1,200 − 200) + 300
    expect(p.estimatedTaxableIncome).toBe(64_200);
    expect(p.taxWithheld).toBe(13_000);
    expect(p.business).toEqual({ income: 4_000, deductions: 1_000, net: 3_000 });
    expect(p.personal).toEqual({ income: 61_500, deductions: 300, net: 61_200 });
  });

  it('income and deduction totals always equal the sum of their drill-down lines', () => {
    const p = position({
      fy: '2024-2025',
      payslips: [payslip({ gross_pay: 5_000, tax_withheld: 1_000, payment_date: '2024-08-01' })],
      incomeEntries: [income({ id: 'd', amount: 700, date: '2024-11-01', category: 'Dividends' })],
      transactions: [
        deductibleTx({ id: 'a', amount: -120, date: '2024-08-01' }),
        deductibleTx({ id: 'b', amount: -80, date: '2024-09-01', deduction_category: 'Self-education' }),
      ],
      manualDeductions: [md({ id: 'm', amount: 60, date: '2024-10-01' })],
    });

    const incomeFromGroups = p.income.groups.reduce((s, g) => s + g.total, 0);
    expect(incomeFromGroups).toBe(p.assessableIncome);
    const deductionsFromGroups = p.deductionCategories.reduce((s, c) => s + c.total, 0);
    expect(deductionsFromGroups).toBe(p.deductibleExpenses);
    // …and each group equals the sum of its own counted lines.
    for (const g of p.income.groups) {
      expect(g.lines.filter(l => !l.excluded).reduce((s, l) => s + l.amount, 0)).toBeCloseTo(g.total, 2);
      expect(g.business + g.personal).toBeCloseTo(g.total, 2);
    }
    for (const g of p.deductions.groups) {
      expect(g.lines.filter(l => !l.excluded).reduce((s, l) => s + l.netAmount, 0)).toBeCloseTo(g.total, 2);
      expect(g.business + g.personal).toBeCloseTo(g.total, 2);
    }
  });

  it('every line carries a drill-down handle back to its source', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'gear', amount: -120, date: '2024-08-01' }),
        tx({ id: 'biz', amount: 900, date: '2024-08-05', transaction_type: 'income', entity: 'business' }),
      ],
      manualDeductions: [md({ id: 'm1', amount: 60, date: '2024-10-01' })],
    });
    const deductionLines = p.deductions.groups.flatMap(g => g.lines);
    expect(deductionLines.find(l => l.id === 'gear')?.transactionId).toBe('gear');
    expect(deductionLines.find(l => l.id === 'm1')?.transactionId).toBeNull();  // standalone
    expect(p.income.lines.find(l => l.id === 'biz')?.transactionId).toBe('biz');
  });

  it('notes that deductions have nothing to reduce when no income is recorded', () => {
    const p = position({ fy: '2024-2025', manualDeductions: [md({ amount: 300, date: '2024-08-01' })] });
    expect(p.notes.some(n => n.kind === 'no-income')).toBe(true);
  });
});

describe('buildIncomeSummary', () => {
  it('honours the shared transfer-exclusion set', () => {
    const t = tx({ id: 'x', amount: 1_000, date: '2024-09-01', transaction_type: 'income', entity: 'business' });
    const included = buildIncomeSummary({ fy: '2024-2025', incomeEntries: [], payslips: [], transactions: [t] });
    expect(included.total).toBe(1_000);

    const excluded = buildIncomeSummary({
      fy: '2024-2025', incomeEntries: [], payslips: [], transactions: [t],
      excludeIds: new Set(['x']),
    });
    expect(excluded.total).toBe(0);
    expect(excluded.excluded[0].excludedReason).toBe('transfer');
  });
});

// ─── Phase 5.4 — investment income joins the position ────────────────────────

describe('the net capital gain is income, and arrives as one line', () => {
  // The seam only reads `fy`, `netCapitalGain` and how many events there were,
  // so an otherwise-real position with those three overridden keeps this test
  // about the SEAM rather than re-testing the CGT rules next door.
  const gain = (netCapitalGain: number, events = 1): CapitalGainsPosition => ({
    ...buildCapitalGainsPosition({ fy: '2024-2025', events: [], broughtForward: null }),
    netCapitalGain,
    events: Array.from({ length: events }, (_, i) => ({ disposalId: `d${i}` })),
  } as unknown as CapitalGainsPosition);

  it('shows up as assessable income under its own category', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      capitalGains: gain(4_000, 2),
    });
    expect(p.assessableIncome).toBe(4_000);
    expect(p.estimatedTaxableIncome).toBe(4_000);
    const line = p.income.lines.find(l => l.kind === 'capital-gain');
    expect(line).toMatchObject({
      category: 'Net capital gain',
      amount: 4_000,
      // Dated 30 June: the return carries it as a year's figure, not an event's.
      date: '2025-06-30',
      detail: '2 disposals, after losses and the CGT discount',
    });
    expect(p.income.groups.map(g => g.category)).toContain('Net capital gain');
  });

  it('adds no line at all when the year netted to nothing', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      capitalGains: gain(0),
    });
    expect(p.income.lines.filter(l => l.kind === 'capital-gain')).toEqual([]);
    expect(p.assessableIncome).toBe(0);
  });

  it('is absent entirely when no CGT position was supplied', () => {
    expect(position({ fy: '2024-2025' }).capitalGains).toBeNull();
  });
});

describe('a dividend statement is counted once, alongside the income summary', () => {
  const statement = (o: Partial<DividendStatement> & { id: string }): DividendStatement => ({
    investmentId: null, label: 'Commonwealth Bank', ticker: 'CBA',
    paymentDate: '2024-09-25', frankedAmount: 700, unfrankedAmount: 0,
    frankingCredit: 300, withheld: 0, ...o,
  });

  it('adds the cash when no income line carries it', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      dividendStatements: [statement({ id: 's1' })],
    });
    expect(p.assessableIncome).toBe(700);
    expect(p.income.dividends!.frankingCredit).toBe(300);
    expect(p.income.lines.find(l => l.kind === 'dividend')).toMatchObject({
      category: 'Dividends', amount: 700, excluded: false,
    });
  });

  it('steps aside — visibly — when an income entry already has it', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], payslips: [],
      incomeEntries: [income({ id: 'i1', amount: 700, source: 'Commonwealth Bank', category: 'Dividends', date: '2024-09-25' })],
      dividendStatements: [statement({ id: 's1' })],
    });
    expect(p.assessableIncome).toBe(700);
    const line = p.income.lines.find(l => l.kind === 'dividend')!;
    expect(line.excluded).toBe(true);
    expect(line.excludedReason).toBe('counted-in-income');
    expect(line.duplicateOf).toBe('e:i1');
    expect(p.income.excluded).toContain(line);
  });

  it('groups the statement with the dividend income it stood beside', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], payslips: [],
      incomeEntries: [income({ id: 'i1', amount: 700, source: 'Commonwealth Bank', category: 'Dividends', date: '2024-09-25' })],
      dividendStatements: [statement({ id: 's1' })],
    });
    const group = p.income.groups.find(g => g.category === 'Dividends')!;
    expect(group.lines).toHaveLength(2);
    expect(group.total).toBe(700);
  });

  it('reconciles the manual franking figure even with no statements at all', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      manualFrankingCredit: 500,
    });
    expect(p.income.dividends!.effectiveFrankingCredit).toBe(500);
    expect(p.income.dividends!.supersededManualFranking).toBeNull();
  });

  it('has no dividend position when there is nothing to reconcile', () => {
    expect(position({ fy: '2024-2025' }).income.dividends).toBeNull();
  });
});

describe('the FY switcher offers a year whose only event was an investment one', () => {
  it('takes sale and dividend dates alongside everything else', () => {
    const years = availableTaxYears({
      transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      extraDates: ['2022-11-01', '2024-07-01', null, 'nonsense'],
    });
    expect(years).toEqual(['2024-2025', '2022-2023']);
  });
});

// ─── Phase 5.5 — the rental schedule inside the FY position ──────────────────

describe('rental properties in the FY position', () => {
  const prop = (o: Partial<Property> & { id: string }): Property => ({
    user_id: 'u1', name: 'Bondi', property_type: 'investment',
    purchase_price: 800_000, purchase_date: '2018-03-01', current_value: 1_000_000,
    ownership_percent: 100, rent_match_terms: ['ray white'],
    property_expenses: [{ id: 'e1', name: 'Strata', kind: 'strata', match_terms: ['strata plus'] }],
    ...o,
  } as Property);

  const rental = (o: {
    property?: Property;
    transactions?: Transaction[];
    linked?: string[];
    settings?: RentalPropertySettings | null;
  } = {}) => buildRentalPosition({
    fy: '2024-2025',
    asOf: '2025-06-30',
    manuallyLinkedTransactionIds: o.linked,
    properties: [{
      property: o.property ?? prop({ id: 'p1' }),
      transactions: o.transactions ?? [
        tx({ id: 'rent1', amount: 24_000, date: '2024-12-01', merchant: 'Ray White', category: 'Rent' }),
        tx({ id: 'strata1', amount: -4_000, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' }),
      ],
      loan: null,
      settings: o.settings ?? null,
    }],
  });

  it('puts the rent in assessable income as its own line', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      rental: rental(),
    });
    const line = p.income.lines.find(l => l.kind === 'rent')!;
    expect(line.category).toBe('Rent');
    expect(line.amount).toBe(24_000);
    expect(p.assessableIncome).toBe(24_000);
  });

  it('puts the rental costs in the ONE deductions total', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      rental: rental(),
    });
    expect(p.deductibleExpenses).toBe(4_000);
    expect(p.deductions.externalTotal).toBe(4_000);
    expect(p.estimatedTaxableIncome).toBe(20_000);
  });

  it('lets a rental LOSS reduce other income, unlike a capital loss', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], payslips: [],
      incomeEntries: [income({ id: 'i1', amount: 90_000 })],
      rental: rental({
        transactions: [
          tx({ id: 'rent1', amount: 12_000, date: '2024-12-01', merchant: 'Ray White', category: 'Rent' }),
          tx({ id: 'strata1', amount: -30_000, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' }),
        ],
      }),
    });
    expect(p.assessableIncome).toBe(102_000);
    expect(p.deductibleExpenses).toBe(30_000);
    expect(p.estimatedTaxableIncome).toBe(72_000);
    expect(p.rental!.netRentalLoss).toBe(18_000);
  });

  it('notes the loss, because it is added back for the other income tests', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      rental: rental({
        transactions: [tx({ id: 'strata1', amount: -30_000, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' })],
      }),
    });
    const note = p.notes.find(n => n.kind === 'rental-loss')!;
    expect(note.amount).toBe(30_000);
  });

  it('counts a rental cost the user ALSO ticked as tax deductible exactly once', () => {
    const strata = tx({
      id: 'strata1', amount: -4_000, date: '2024-08-01', merchant: 'Strata Plus',
      category: 'Bills', is_tax_deductible: true, deduction_category: 'Other',
    });
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [strata], manualDeductions: [], incomeEntries: [], payslips: [],
      rental: rental({
        transactions: [
          tx({ id: 'rent1', amount: 24_000, date: '2024-12-01', merchant: 'Ray White', category: 'Rent' }),
          strata,
        ],
      }),
    });
    expect(p.deductibleExpenses).toBe(4_000);
    const suppressed = p.deductions.groups
      .flatMap(g => g.lines)
      .find(l => l.id === 'strata1')!;
    expect(suppressed.excluded).toBe(true);
    expect(suppressed.excludedReason).toBe('counted-in-rental');
    expect(p.deductions.countedInRental).toEqual(['strata1']);
  });

  it('steps aside when a manual deduction is explicitly linked to the payment', () => {
    const strata = tx({
      id: 'strata1', amount: -4_000, date: '2024-08-01', merchant: 'Strata Plus',
      category: 'Bills', is_tax_deductible: true,
    });
    const p = buildTaxYearPosition({
      fy: '2024-2025',
      transactions: [strata],
      manualDeductions: [md({ id: 'd1', amount: 4_000, name: 'Strata', source_transaction_id: 'strata1', date: '2024-08-01' })],
      incomeEntries: [], payslips: [],
      rental: rental({ transactions: [strata], linked: ['strata1'] }),
    });
    // Claimed once, by the manual line the user made themselves.
    expect(p.deductibleExpenses).toBe(4_000);
    expect(p.deductions.externalTotal).toBe(0);
    expect(p.deductions.manualTotal).toBe(4_000);
  });

  it('suppresses a rent transaction the user also tagged as business income', () => {
    const rent = tx({
      id: 'rent1', amount: 24_000, date: '2024-12-01', merchant: 'Ray White',
      category: 'Rent', transaction_type: 'income', entity: 'business',
    });
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [rent], manualDeductions: [], incomeEntries: [], payslips: [],
      rental: rental({ transactions: [rent] }),
    });
    expect(p.assessableIncome).toBe(24_000);
    const dropped = p.income.excluded.find(l => l.id === 'rent1')!;
    expect(dropped.excludedReason).toBe('counted-in-rental');
  });

  it('suppresses an income entry that is the same rent typed in by hand', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], payslips: [],
      incomeEntries: [income({ id: 'i1', amount: 24_000, source: 'Rent — Bondi', category: 'Rent', date: '2024-12-02' })],
      rental: rental(),
    });
    expect(p.assessableIncome).toBe(24_000);
    expect(p.income.excluded.find(l => l.id === 'i1')!.excludedReason).toBe('counted-in-rental');
  });

  it('leaves an income entry that is NOT the rent alone', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], payslips: [],
      incomeEntries: [income({ id: 'i1', amount: 24_000, source: 'Acme Pty Ltd', category: 'Salary' })],
      rental: rental(),
    });
    expect(p.assessableIncome).toBe(48_000);
  });

  it('has no rental position when no properties were supplied', () => {
    expect(position({ fy: '2024-2025' }).rental).toBeNull();
    expect(position({ fy: '2024-2025' }).income.rental).toBeNull();
  });

  it('never reports an apportioned rental cost as a refund', () => {
    // The gap between what was paid and what is claimed is an ownership share,
    // not money that came back. Calling it a refund would make the year's
    // refund total say something untrue.
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      rental: buildRentalPosition({
        fy: '2024-2025',
        asOf: '2025-06-30',
        properties: [{
          property: prop({ id: 'p1', ownership_percent: 50 }),
          transactions: [tx({ id: 'strata1', amount: -4_000, date: '2024-08-01', merchant: 'Strata Plus', category: 'Bills' })],
          loan: null,
          settings: { recordedBasis: 'whole', apportionment: { mode: 'full', percent: 100, daysRented: 0, daysPrivate: 0 }, ruleDeductiblePercent: {}, byFY: {} },
        }],
      }),
    });
    expect(p.deductibleExpenses).toBe(2_000);
    expect(p.deductions.refundedTotal).toBe(0);
  });

  it('files each rental heading under its own deduction category', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025', transactions: [], manualDeductions: [], incomeEntries: [], payslips: [],
      rental: rental(),
    });
    expect(p.deductionCategories.map(c => c.category)).toContain('Rent: Body corporate fees');
  });
});


// ─── M3 — the position stops at today ────────────────────────────────────────
//
// A tax return is a record of what HAPPENED. A transaction dated next week is
// a plan, not a claim — it stays listed (flagged 'future') and counts nothing
// until its day arrives. With no asOf (a settled past year) nothing is clamped.
describe('the position stops at today', () => {
  it('a future-dated deductible transaction is listed but claims nothing', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025',
      transactions: [
        deductibleTx({ id: 'spent', amount: -300, date: '2024-08-01' }),
        deductibleTx({ id: 'planned', amount: -420, date: '2024-09-02' }),
      ],
      manualDeductions: [], incomeEntries: [], payslips: [],
      asOf: '2024-08-25',
    });
    expect(p.deductibleExpenses).toBe(300);
    const planned = p.deductions.groups.flatMap(g => g.lines).find(l => l.id === 'planned')!;
    expect(planned.excluded).toBe(true);
    expect(planned.excludedReason).toBe('future');
  });

  it('a future-dated manual deduction and income entry wait for their day too', () => {
    const p = buildTaxYearPosition({
      fy: '2024-2025',
      transactions: [],
      manualDeductions: [
        { id: 'm1', name: 'Union fees', amount: 90, category: 'Other', date: '2024-12-01' } as ManualDeduction,
      ],
      incomeEntries: [
        income({ id: 'e1', amount: 1_000, date: '2024-12-05', status: 'approved' }),
      ],
      payslips: [],
      asOf: '2024-08-25',
    });
    expect(p.deductibleExpenses).toBe(0);
    expect(p.assessableIncome).toBe(0);
    expect(p.income.excluded.find(l => l.id === 'e1')?.excludedReason).toBe('future');
  });

  it('without asOf nothing is clamped — a settled year reads whole', () => {
    const p = position({
      fy: '2024-2025',
      transactions: [deductibleTx({ id: 'late', amount: -420, date: '2025-06-01' })],
    });
    expect(p.deductibleExpenses).toBe(420);
  });
});
