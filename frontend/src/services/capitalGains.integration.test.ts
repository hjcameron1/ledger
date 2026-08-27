/**
 * Phase 5.4 — capital gains and investment income, end to end.
 *
 * The engines are unit-tested in isolation (utils/capitalGains.test.ts,
 * utils/dividendIncome.test.ts). These are the things they CANNOT prove on
 * their own — what only exists once the stores, the FY position and the tax
 * calculation are wired together:
 *
 *   • a sale recorded on the Investments page reaches the Tax page at all;
 *   • the net capital gain is inside assessable income, so it is actually taxed
 *     at the user's own marginal rate rather than a hard-coded one;
 *   • parcels and the opening loss survive a reload and belong to ONE user;
 *   • a dividend statement grosses up and credits the same figure once, and
 *     supersedes the number typed on the tax-paid card instead of adding to it.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { IncomeEntry, InvestmentSale } from '../types';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: (i: number) => [...mem.keys()][i] ?? null,
    get length() { return mem.size; },
  };
});

vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

import { useStore } from '../store';
import { calculateTax, cgtDS, dividendsDS, salesDS, taxCreditsDS, taxYearDS } from './dataService';
import { grossUpFor, emptyTaxCredits, type TaxCredits } from '../utils/taxCredits';
import { buildTaxSettlement, type TaxSettlement } from '../utils/taxSettlement';
import { buildOffsetPosition } from '../utils/taxOffsets';
import { emptyTaxProfile } from '../utils/taxProfile';

const ME = 'user-ME';
const OTHER = 'user-OTHER';

const income = (o: Partial<IncomeEntry> & { amount: number }): IncomeEntry => ({
  id: 'i1', user_id: ME, source: 'Acme Pty Ltd', currency: 'AUD', category: 'Salary',
  is_recurring: false, date: '2024-09-01', status: 'approved', ...o,
} as IncomeEntry);

const sale = (o: Partial<InvestmentSale> & { id: string }): InvestmentSale => ({
  user_id: ME, investment_id: null, name: 'Commonwealth Bank', ticker: 'CBA',
  asset_type: 'stock', market: 'ASX', quantity: 100, proceeds: 20_000, fees: 0,
  cost_basis: 0, acquired_date: null, sale_date: '2024-09-01', gain: 0,
  held_days: null, discount_eligible: false, currency: 'AUD', ...o,
} as InvestmentSale);

function seed(opts: { userId?: string; incomeEntries?: IncomeEntry[]; sales?: InvestmentSale[] } = {}) {
  useStore.setState({
    user: { id: opts.userId ?? ME, email: 'me@example.com' } as any,
    transactions: [],
    incomeEntries: opts.incomeEntries ?? [],
    investments: [],
    investmentSales: opts.sales ?? [],
    merchants: [], merchantAliases: [], customCategories: [], transactionRules: [],
  });
}

/** Exactly what the Tax page does, in the order it does it. */
function pageSettlement(fy: string, opts: { credits?: Partial<TaxCredits> } = {}): {
  settlement: TaxSettlement;
  position: ReturnType<typeof taxYearDS.build>;
  /** What the tax was actually assessed on — assessable income plus the gross-up. */
  taxableIncome: number;
} {
  const credits: TaxCredits = { ...emptyTaxCredits(), ...opts.credits };
  if (opts.credits) taxCreditsDS.save(fy, credits);
  const position = taxYearDS.build({ fy });
  const effectiveCredits: TaxCredits = position.income.dividends
    ? { ...credits, frankingCredits: position.income.dividends.effectiveFrankingCredit }
    : credits;
  const tax = calculateTax(false, {
    fy,
    total_income: position.assessableIncome + grossUpFor(effectiveCredits),
    tax_withheld: position.taxWithheld,
    total_deductions: position.deductibleExpenses,
  });
  const offsets = buildOffsetPosition({
    fy,
    taxableIncome: tax.total_income,
    incomeTax: tax.income_tax,
    profile: emptyTaxProfile(),
  });
  return {
    position,
    taxableIncome: tax.total_income,
    settlement: buildTaxSettlement({
      position,
      tax: {
        ratesAvailable: tax.rates_available,
        taxableIncome: tax.total_income,
        incomeTax: tax.income_tax,
        medicareLevy: tax.medicare_levy,
        studentLoanRepayment: tax.hecs_repayment,
        confidence: tax.rates_confidence,
        notes: tax.rates_notes,
      },
      credits: effectiveCredits,
      offsets,
    }),
  };
}

beforeEach(() => {
  localStorage.clear();
  seed();
});

// ─── Disposals reach the Tax page ────────────────────────────────────────────

describe('a sale recorded on Investments is a capital gain on Tax', () => {
  it('goes into the store, not a page-local list', () => {
    salesDS.record({
      investment_id: 'inv-1', name: 'Commonwealth Bank', ticker: 'CBA', asset_type: 'stock',
      market: 'ASX', quantity: 100, proceeds: 20_000, fees: 50, cost_basis: 12_000,
      acquired_date: '2020-01-01', sale_date: '2024-09-01', currency: 'AUD',
    });
    expect(salesDS.getAll()).toHaveLength(1);
    expect(useStore.getState().investmentSales[0].gain).toBe(7_950);
    expect(cgtDS.disposals()[0]).toMatchObject({
      label: 'Commonwealth Bank', ticker: 'CBA', proceeds: 20_000, fees: 50,
      costBase: 12_000, acquiredDate: '2020-01-01', saleDate: '2024-09-01',
    });
  });

  it('lands in assessable income after the discount, not before it', () => {
    seed({ sales: [sale({ id: 's1', cost_basis: 12_000, acquired_date: '2020-01-01' })] });
    const { position } = pageSettlement('2024-2025');
    expect(position.capitalGains!.grossGainsTotal).toBe(8_000);
    expect(position.capitalGains!.netCapitalGain).toBe(4_000);
    expect(position.assessableIncome).toBe(4_000);
    const line = position.income.lines.find(l => l.kind === 'capital-gain');
    expect(line).toMatchObject({ label: 'Net capital gain', amount: 4_000, excluded: false });
  });

  it('is taxed at the marginal rate the rest of the income puts it at', () => {
    seed({
      incomeEntries: [income({ id: 'i1', amount: 90_000, tax_withheld: 20_000 })],
      sales: [sale({ id: 's1', cost_basis: 12_000, acquired_date: '2020-01-01' })],
    });
    const { settlement, taxableIncome } = pageSettlement('2024-2025');
    // $90,000 salary + $4,000 net capital gain.
    expect(taxableIncome).toBe(94_000);
    const noGain = (() => {
      seed({ incomeEntries: [income({ id: 'i1', amount: 90_000, tax_withheld: 20_000 })] });
      return pageSettlement('2024-2025').settlement;
    })();
    // The gain costs 30% + 2% Medicare at this income — $1,280 on $4,000 — which
    // is a number no hard-coded rate dropdown could have produced.
    expect(settlement.liability.total! - noGain.liability.total!).toBe(1_280);
  });

  it('adds nothing at all in a year that made a net capital loss', () => {
    seed({
      incomeEntries: [income({ id: 'i1', amount: 90_000 })],
      sales: [sale({ id: 's1', proceeds: 5_000, cost_basis: 12_000, acquired_date: '2020-01-01' })],
    });
    const { position } = pageSettlement('2024-2025');
    expect(position.assessableIncome).toBe(90_000);
    expect(position.capitalGains!.carriedForward.ordinary).toBe(7_000);
    expect(position.notes.map(n => n.kind)).toContain('capital-loss');
  });

  it('carries that loss into the next year and reduces the gain there', () => {
    seed({
      sales: [
        sale({ id: 'loss', proceeds: 5_000, cost_basis: 12_000, acquired_date: '2020-01-01', sale_date: '2024-09-01' }),
        sale({ id: 'gain', ticker: 'BHP', name: 'BHP', proceeds: 25_000, cost_basis: 12_000, acquired_date: '2020-01-01', sale_date: '2025-09-01' }),
      ],
    });
    const next = taxYearDS.build({ fy: '2025-2026' });
    expect(next.capitalGains!.broughtForward.ordinary).toBe(7_000);
    // 13,000 − 7,000 = 6,000, halved.
    expect(next.capitalGains!.netCapitalGain).toBe(3_000);
    expect(next.assessableIncome).toBe(3_000);
  });

  it('puts a year with nothing but a sale in it on the FY switcher', () => {
    seed({ sales: [sale({ id: 's1', sale_date: '2022-11-01' })] });
    expect(taxYearDS.financialYears()).toContain('2022-2023');
  });

  it('removing a mis-entered disposal takes the gain with it', () => {
    seed({ sales: [sale({ id: 's1', cost_basis: 12_000, acquired_date: '2020-01-01' })] });
    expect(taxYearDS.build({ fy: '2024-2025' }).assessableIncome).toBe(4_000);
    salesDS.remove('s1');
    expect(taxYearDS.build({ fy: '2024-2025' }).assessableIncome).toBe(0);
  });
});

// ─── Parcels ─────────────────────────────────────────────────────────────────

describe('parcels change the answer, and survive a reload', () => {
  it('a partial sale out of two parcels discounts only the older half', () => {
    seed({ sales: [sale({ id: 's1', quantity: 80, proceeds: 1_600, cost_basis: 1_120, acquired_date: null })] });
    // Without parcels: no acquisition date, so no discount at all.
    expect(taxYearDS.build({ fy: '2024-2025' }).capitalGains!.netCapitalGain).toBe(480);

    cgtDS.addParcel({
      investmentId: null, label: 'Commonwealth Bank', ticker: 'CBA', assetType: 'stock',
      quantity: 50, costBase: 500, acquiredDate: '2022-01-01',
    });
    cgtDS.addParcel({
      investmentId: null, label: 'Commonwealth Bank', ticker: 'CBA', assetType: 'stock',
      quantity: 50, costBase: 900, acquiredDate: '2024-06-01',
    });
    const p = taxYearDS.build({ fy: '2024-2025' }).capitalGains!;
    expect(p.grossGains.discount).toBe(500);
    expect(p.grossGains.other).toBe(60);
    expect(p.netCapitalGain).toBe(310);
  });

  it('persists under a user-scoped key and reads back after a reload', () => {
    cgtDS.addParcel({
      investmentId: 'inv-1', label: 'CBA', ticker: 'CBA', assetType: 'stock',
      quantity: 10, costBase: 500, acquiredDate: '2021-05-05',
    });
    expect(localStorage.getItem('ledger-cgt-user-ME')).toContain('2021-05-05');
    seed(); // fresh store, same user — as a reload would be
    expect(cgtDS.parcels()).toHaveLength(1);
    expect(cgtDS.parcelsFor('inv-1')).toHaveLength(1);
  });

  it('edits and deletes hit the same record', () => {
    const p = cgtDS.addParcel({
      investmentId: null, label: 'CBA', ticker: 'CBA', assetType: 'stock',
      quantity: 10, costBase: 500, acquiredDate: null,
    });
    cgtDS.updateParcel(p.id, { acquiredDate: '2021-05-05' });
    expect(cgtDS.parcels()[0].acquiredDate).toBe('2021-05-05');
    cgtDS.removeParcel(p.id);
    expect(cgtDS.parcels()).toEqual([]);
  });

  it('degrades a corrupt bucket to no parcels rather than a wrong cost base', () => {
    localStorage.setItem('ledger-cgt-user-ME', '{not json');
    expect(cgtDS.parcels()).toEqual([]);
    expect(cgtDS.opening()).toBeNull();
  });

  it('suggests a starting parcel from a holding, with no acquisition date invented', () => {
    useStore.setState({
      investments: [{
        id: 'inv-1', name: 'CBA', ticker: 'CBA', market: 'ASX', asset_type: 'stock',
        shares_owned: 100, cost_basis: 9_000, current_price: 120, current_value: 12_000,
        currency: 'AUD', native_currency: 'AUD', is_dividend_paying: true,
      }] as any,
    });
    expect(cgtDS.suggestParcel('inv-1')).toEqual({
      investmentId: 'inv-1', label: 'CBA', ticker: 'CBA', assetType: 'stock',
      quantity: 100, costBase: 9_000, acquiredDate: null,
    });
    expect(cgtDS.suggestParcel('nope')).toBeNull();
  });
});

describe('losses brought in from a lodged return', () => {
  it('reduce this year and every year after it', () => {
    seed({ sales: [sale({ id: 's1', proceeds: 25_000, cost_basis: 12_000, acquired_date: '2020-01-01' })] });
    cgtDS.setOpening({ fy: '2024-2025', ordinary: 5_000, collectable: 0 });
    // 13,000 − 5,000 = 8,000, halved.
    expect(taxYearDS.build({ fy: '2024-2025' }).capitalGains!.netCapitalGain).toBe(4_000);
  });

  it('are never applied to a year before the one they were measured at', () => {
    seed({ sales: [sale({ id: 's1', proceeds: 25_000, cost_basis: 12_000, acquired_date: '2020-01-01', sale_date: '2023-09-01' })] });
    cgtDS.setOpening({ fy: '2024-2025', ordinary: 5_000, collectable: 0 });
    const p = taxYearDS.build({ fy: '2023-2024' }).capitalGains!;
    expect(p.broughtForward.ordinary).toBe(0);
    expect(p.netCapitalGain).toBe(6_500);
  });

  it('clear back to nothing', () => {
    cgtDS.setOpening({ fy: '2024-2025', ordinary: 5_000, collectable: 0 });
    cgtDS.setOpening(null);
    expect(cgtDS.opening()).toBeNull();
  });
});

// ─── Dividends ───────────────────────────────────────────────────────────────

describe('a dividend statement grosses up and credits the same figure', () => {
  const addStatement = () => dividendsDS.add({
    investmentId: null, label: 'Commonwealth Bank', ticker: 'CBA',
    paymentDate: '2024-09-25', frankedAmount: 700, unfrankedAmount: 0,
    frankingCredit: 300, withheld: 0, foreignTaxPaid: 0, sourceCountry: null,
  });

  it('adds the cash when nothing else recorded it, and the credit on top', () => {
    addStatement();
    const { position, settlement, taxableIncome } = pageSettlement('2024-2025');
    expect(position.assessableIncome).toBe(700);
    // 700 cash + 300 credit — the ATO assesses the grossed-up amount.
    expect(taxableIncome).toBe(1_000);
    expect(settlement.credits.components.map(c => c.key)).toContain('frankingCredits');
    expect(settlement.otherCredits).toBe(300);
  });

  it('counts the cash ONCE when an income entry already has it', () => {
    seed({
      incomeEntries: [income({
        id: 'i1', amount: 700, source: 'Commonwealth Bank', category: 'Dividends', date: '2024-09-26',
      })],
    });
    addStatement();
    const { position, taxableIncome } = pageSettlement('2024-2025');
    expect(position.assessableIncome).toBe(700);
    expect(taxableIncome).toBe(1_000);
    const statementLine = position.income.lines.find(l => l.kind === 'dividend');
    expect(statementLine).toMatchObject({ excluded: true, excludedReason: 'counted-in-income' });
    expect(position.income.dividends!.additionalAssessableIncome).toBe(0);
  });

  it('supersedes the figure typed on the tax-paid card instead of adding to it', () => {
    addStatement();
    const { settlement, position, taxableIncome } = pageSettlement('2024-2025', { credits: { frankingCredits: 500 } });
    expect(position.income.dividends!.supersededManualFranking).toBe(500);
    expect(position.income.dividends!.effectiveFrankingCredit).toBe(300);
    // Not 800, and not 500 — the statements are what is counted.
    expect(settlement.otherCredits).toBe(300);
    expect(taxableIncome).toBe(1_000);
  });

  it('leaves the manual figure alone when there are no statements', () => {
    const { settlement, taxableIncome } = pageSettlement('2024-2025', { credits: { frankingCredits: 500 } });
    expect(settlement.otherCredits).toBe(500);
    expect(taxableIncome).toBe(500);
  });

  it('buckets a statement by its payment date, and survives a reload', () => {
    dividendsDS.add({
      investmentId: null, label: 'CBA', ticker: 'CBA', paymentDate: '2024-06-30',
      frankedAmount: 100, unfrankedAmount: 0, frankingCredit: 42.86, withheld: 0, foreignTaxPaid: 0, sourceCountry: null,
    });
    dividendsDS.add({
      investmentId: null, label: 'CBA', ticker: 'CBA', paymentDate: '2024-07-01',
      frankedAmount: 200, unfrankedAmount: 0, frankingCredit: 85.71, withheld: 0, foreignTaxPaid: 0, sourceCountry: null,
    });
    expect(dividendsDS.forFY('2023-2024').map(s => s.frankedAmount)).toEqual([100]);
    expect(dividendsDS.forFY('2024-2025').map(s => s.frankedAmount)).toEqual([200]);
    seed();
    expect(dividendsDS.getAll()).toHaveLength(2);
    expect(localStorage.getItem('ledger-dividends-user-ME')).toContain('2024-07-01');
  });

  it('deletes cleanly', () => {
    const s = addStatement();
    dividendsDS.remove(s.id);
    expect(dividendsDS.getAll()).toEqual([]);
  });

  it('puts a year with nothing but a dividend in it on the FY switcher', () => {
    dividendsDS.add({
      investmentId: null, label: 'CBA', ticker: 'CBA', paymentDate: '2021-11-01',
      frankedAmount: 100, unfrankedAmount: 0, frankingCredit: 42.86, withheld: 0, foreignTaxPaid: 0, sourceCountry: null,
    });
    expect(taxYearDS.financialYears()).toContain('2021-2022');
  });
});

// ─── One user's investments are one user's ───────────────────────────────────

describe('nothing leaks between users', () => {
  it('parcels, opening losses and statements are all user-scoped', () => {
    cgtDS.addParcel({
      investmentId: null, label: 'CBA', ticker: 'CBA', assetType: 'stock',
      quantity: 10, costBase: 500, acquiredDate: '2021-05-05',
    });
    cgtDS.setOpening({ fy: '2024-2025', ordinary: 5_000, collectable: 0 });
    dividendsDS.add({
      investmentId: null, label: 'CBA', ticker: 'CBA', paymentDate: '2024-09-25',
      frankedAmount: 700, unfrankedAmount: 0, frankingCredit: 300, withheld: 0, foreignTaxPaid: 0, sourceCountry: null,
    });

    seed({ userId: OTHER });
    expect(cgtDS.parcels()).toEqual([]);
    expect(cgtDS.opening()).toBeNull();
    expect(dividendsDS.getAll()).toEqual([]);

    seed({ userId: ME });
    expect(cgtDS.parcels()).toHaveLength(1);
    expect(cgtDS.opening()?.ordinary).toBe(5_000);
    expect(dividendsDS.getAll()).toHaveLength(1);
  });

  it('a second user writing does not disturb the first', () => {
    cgtDS.addParcel({
      investmentId: null, label: 'CBA', ticker: 'CBA', assetType: 'stock',
      quantity: 10, costBase: 500, acquiredDate: '2021-05-05',
    });
    seed({ userId: OTHER });
    cgtDS.addParcel({
      investmentId: null, label: 'BHP', ticker: 'BHP', assetType: 'stock',
      quantity: 99, costBase: 9_999, acquiredDate: '2023-01-01',
    });
    expect(cgtDS.parcels().map(p => p.ticker)).toEqual(['BHP']);
    seed({ userId: ME });
    expect(cgtDS.parcels().map(p => p.ticker)).toEqual(['CBA']);
  });

  it("a disposal belongs to whoever's store it is in", () => {
    seed({ userId: ME, sales: [sale({ id: 's1', cost_basis: 12_000, acquired_date: '2020-01-01' })] });
    expect(taxYearDS.build({ fy: '2024-2025' }).capitalGains!.netCapitalGain).toBe(4_000);
    seed({ userId: OTHER });
    expect(taxYearDS.build({ fy: '2024-2025' }).capitalGains!.netCapitalGain).toBe(0);
  });
});
