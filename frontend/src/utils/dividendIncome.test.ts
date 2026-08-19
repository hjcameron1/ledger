/**
 * Phase 5.4 — dividends and franking credits.
 *
 * The whole point of this engine is that one dividend has two records and must
 * be counted once, so most of what is tested here is what it REFUSES to add.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDividendPosition,
  cashDividendOf,
  isDividendCategory,
  isLikelySameDividend,
  maxFrankingCreditFor,
  normaliseDividendStatement,
  type DividendIncomeCandidate,
  type DividendStatement,
} from './dividendIncome';

const statement = (o: Partial<DividendStatement> & { id: string }): DividendStatement => ({
  investmentId: null,
  label: 'Commonwealth Bank',
  ticker: 'CBA',
  paymentDate: '2024-09-25',
  frankedAmount: 700,
  unfrankedAmount: 0,
  frankingCredit: 300,
  withheld: 0,
  ...o,
});

const line = (o: Partial<DividendIncomeCandidate> & { key: string }): DividendIncomeCandidate => ({
  label: 'Commonwealth Bank dividend',
  category: 'Dividends',
  date: '2024-09-25',
  amount: 700,
  excluded: false,
  ...o,
});

const build = (o: {
  statements?: DividendStatement[];
  incomeLines?: DividendIncomeCandidate[];
  manualFrankingCredit?: number;
  fy?: string;
}) => buildDividendPosition({
  fy: o.fy ?? '2024-2025',
  statements: o.statements ?? [],
  incomeLines: o.incomeLines,
  manualFrankingCredit: o.manualFrankingCredit,
});

// ─── The arithmetic on the statement ─────────────────────────────────────────

describe('the figures off a statement', () => {
  it('cash is franked plus unfranked, and the gross-up adds the credit', () => {
    const p = build({ statements: [statement({ id: 's1', frankedAmount: 700, unfrankedAmount: 100, frankingCredit: 300 })] });
    expect(p.cashDividends).toBe(800);
    expect(p.frankingCredit).toBe(300);
    expect(p.grossedUpTotal).toBe(1_100);
  });

  it('a fully franked dividend at 30% carries 30/70 of the franked amount', () => {
    expect(maxFrankingCreditFor(700)).toBe(300);
    expect(maxFrankingCreditFor(1_000)).toBe(428.57);
    expect(cashDividendOf({ frankedAmount: 700, unfrankedAmount: 50 })).toBe(750);
  });

  it('flags a credit no 30%-franked dividend could carry', () => {
    const p = build({ statements: [statement({ id: 's1', frankedAmount: 700, frankingCredit: 400 })] });
    expect(p.lines[0].overFrankedBy).toBe(100);
    const w = p.warnings.find(x => x.kind === 'over-franked');
    expect(w?.severity).toBe('warn');
    expect(w?.amount).toBe(100);
  });

  it('does not flag a base rate entity franking at 25%', () => {
    // $750 franked at 25% carries $250 — well under the 30% ceiling.
    const p = build({ statements: [statement({ id: 's1', frankedAmount: 750, frankingCredit: 250 })] });
    expect(p.lines[0].overFrankedBy).toBeNull();
    expect(p.warnings.map(w => w.kind)).not.toContain('over-franked');
  });

  it('coerces whatever came out of storage', () => {
    const s = normaliseDividendStatement(
      { paymentDate: '2024-09-25T00:00:00Z', frankedAmount: '700', unfrankedAmount: -5, frankingCredit: NaN, ticker: 'cba' },
      'id-1',
    );
    expect(s).toMatchObject({
      id: 'id-1', label: 'Dividend', ticker: 'CBA', paymentDate: '2024-09-25',
      frankedAmount: 700, unfrankedAmount: 0, frankingCredit: 0,
    });
  });

  it('recognises the categories Ledger files dividends under', () => {
    expect(isDividendCategory('Dividends')).toBe(true);
    expect(isDividendCategory('dividend income')).toBe(true);
    expect(isDividendCategory('Salary')).toBe(false);
  });
});

// ─── Not counting the same money twice ───────────────────────────────────────

describe('the cash is counted once — by the record that actually saw it', () => {
  it('steps aside when an income line already carries the cash', () => {
    const p = build({
      statements: [statement({ id: 's1' })],
      incomeLines: [line({ key: 'e:1' })],
    });
    expect(p.lines[0].matchedIncomeKey).toBe('e:1');
    expect(p.lines[0].addsIncome).toBe(false);
    expect(p.additionalAssessableIncome).toBe(0);
    // …but the franking credit is still real, and still counted.
    expect(p.frankingCredit).toBe(300);
    expect(p.warnings.map(w => w.kind)).toContain('matched-to-income');
  });

  it('adds the cash when nothing else counts it', () => {
    const p = build({ statements: [statement({ id: 's1' })], incomeLines: [] });
    expect(p.lines[0].addsIncome).toBe(true);
    expect(p.additionalAssessableIncome).toBe(700);
    const w = p.warnings.find(x => x.kind === 'cash-not-in-income');
    expect(w?.amount).toBe(700);
  });

  it('matches within ten days, not to the exact day the registry paid', () => {
    expect(isLikelySameDividend(statement({ id: 's' }), line({ key: 'a', date: '2024-10-02' }))).toBe(true);
    expect(isLikelySameDividend(statement({ id: 's' }), line({ key: 'a', date: '2024-10-20' }))).toBe(false);
  });

  it('will not match on the date alone — the cash has to agree to the cent', () => {
    expect(isLikelySameDividend(statement({ id: 's' }), line({ key: 'a', amount: 700.01 }))).toBe(false);
  });

  it('needs a corroborating signal, not just an amount and a date', () => {
    const unrelated = line({ key: 'a', category: 'Salary', label: 'Acme Pty Ltd' });
    expect(isLikelySameDividend(statement({ id: 's' }), unrelated)).toBe(false);
    // The ticker in the description is enough.
    expect(isLikelySameDividend(statement({ id: 's' }), { ...unrelated, label: 'CBA payment' })).toBe(true);
  });

  it('never lets two statements claim the same income line', () => {
    const p = build({
      statements: [statement({ id: 's1' }), statement({ id: 's2' })],
      incomeLines: [line({ key: 'e:1' })],
    });
    const added = p.lines.filter(l => l.addsIncome);
    expect(added).toHaveLength(1);
    expect(p.additionalAssessableIncome).toBe(700);
  });

  it('ignores an income line that was itself excluded from the totals', () => {
    const p = build({
      statements: [statement({ id: 's1' })],
      incomeLines: [line({ key: 'e:1', excluded: true })],
    });
    expect(p.lines[0].addsIncome).toBe(true);
  });

  it('points out dividend income with no statement, where a credit is going begging', () => {
    const p = build({
      statements: [statement({ id: 's1', paymentDate: '2024-09-25', frankedAmount: 700 })],
      incomeLines: [line({ key: 'e:1' }), line({ key: 'e:2', amount: 250, date: '2025-03-01' })],
    });
    const w = p.warnings.find(x => x.kind === 'income-without-statement');
    expect(w?.count).toBe(1);
    expect(w?.amount).toBe(250);
  });
});

describe('statements supersede the single figure on the tax-paid card', () => {
  it('replaces it rather than adding to it', () => {
    const p = build({
      statements: [statement({ id: 's1', frankingCredit: 300 })],
      manualFrankingCredit: 500,
    });
    expect(p.effectiveFrankingCredit).toBe(300);
    expect(p.supersededManualFranking).toBe(500);
    const w = p.warnings.find(x => x.kind === 'manual-franking-superseded');
    expect(w?.severity).toBe('warn');
    expect(w?.amount).toBe(500);
  });

  it('is only a note, not a warning, when the two agree', () => {
    const p = build({ statements: [statement({ id: 's1', frankingCredit: 300 })], manualFrankingCredit: 300 });
    expect(p.warnings.find(x => x.kind === 'manual-franking-superseded')?.severity).toBe('info');
  });

  it('falls back to the manual figure when there are no statements', () => {
    const p = build({ statements: [], manualFrankingCredit: 500 });
    expect(p.effectiveFrankingCredit).toBe(500);
    expect(p.supersededManualFranking).toBeNull();
  });

  it('is superseded by statements in THIS year only', () => {
    // A statement from last year does not silence this year's figure.
    const p = build({
      fy: '2024-2025',
      statements: [statement({ id: 's1', paymentDate: '2023-09-25' })],
      manualFrankingCredit: 500,
    });
    expect(p.lines).toHaveLength(0);
    expect(p.effectiveFrankingCredit).toBe(500);
  });
});

// ─── Financial-year boundaries ───────────────────────────────────────────────

describe('a statement belongs to the year it was PAID in', () => {
  it('30 June is the old year and 1 July is the new one', () => {
    const both = [
      statement({ id: 'june', paymentDate: '2024-06-30' }),
      statement({ id: 'july', paymentDate: '2024-07-01' }),
    ];
    expect(build({ fy: '2023-2024', statements: both }).lines.map(l => l.statementId)).toEqual(['june']);
    expect(build({ fy: '2024-2025', statements: both }).lines.map(l => l.statementId)).toEqual(['july']);
  });

  it('counts an undated statement in no year at all, and says so', () => {
    const p = build({ statements: [statement({ id: 's1', paymentDate: '' })] });
    expect(p.lines).toHaveLength(0);
    expect(p.grossedUpTotal).toBe(0);
    const w = p.warnings.find(x => x.kind === 'undated-statement');
    expect(w?.severity).toBe('warn');
  });
});

// ─── Withholding ─────────────────────────────────────────────────────────────

describe('TFN amounts withheld', () => {
  it('travel with the statement when the statement is what adds the income', () => {
    const p = build({ statements: [statement({ id: 's1', withheld: 350 })] });
    expect(p.withheld).toBe(350);
    expect(p.lines[0].addsIncome).toBe(true);
    expect(p.warnings.map(w => w.kind)).not.toContain('withholding-not-credited');
  });

  it('are named rather than credited twice when the cash is already recorded', () => {
    const p = build({
      statements: [statement({ id: 's1', withheld: 350 })],
      incomeLines: [line({ key: 'e:1' })],
    });
    const w = p.warnings.find(x => x.kind === 'withholding-not-credited');
    expect(w?.severity).toBe('warn');
    expect(w?.amount).toBe(350);
  });
});

describe('an empty year', () => {
  it('is all zeros and warns about nothing', () => {
    const p = build({});
    expect(p).toMatchObject({
      cashDividends: 0, frankingCredit: 0, grossedUpTotal: 0,
      additionalAssessableIncome: 0, supersededManualFranking: null, effectiveFrankingCredit: 0,
    });
    expect(p.warnings).toEqual([]);
  });
});
