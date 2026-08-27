/**
 * INVESTMENT / NET-WORTH STRESS TEST — the two-year market simulation.
 *
 * Deterministic price and FX paths (see marketSim.ts) drive the REAL data
 * services day by day for two years — rallies, a crash, sideways markets and
 * volatile FX — while an independent truth ledger mirrors every action with
 * its own arithmetic. At every step the suite verifies:
 *
 *   • holding value = units × price × FX
 *   • the Investments page total, the Overview investments figure and the
 *     store portfolio total reconcile
 *   • net worth moves only by legitimate valuation/cash changes — no
 *     double counting, no unexplained drift
 *
 * Buys, sells, dividends, deposits, withdrawals, super contributions and a
 * mid-life new holding are all simulated. `pageMirrors: true` replays what the
 * Investments page itself does after every mutation (enrichAll → write back),
 * so both "user lives on Overview" and "user lives on Investments" worlds run.
 *
 * Convention (same as regressions.test.ts): correct behaviour is asserted
 * plainly; a defect found by this hunt is pinned with `it.fails` stating the
 * CORRECT behaviour, so the suite goes green the moment the defect is fixed.
 * F1–F7 below were found by this hunt and have since been FIXED (2026-08 cost
 * source-of-truth cleanup); their blocks now assert the correct behaviour
 * plainly and stand as permanent regressions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as never as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(), key: () => null, get length() { return mem.size; },
  };
});
const sync = vi.fn();
vi.mock('../services/syncQueue', () => ({
  syncWithRetry: (...a: unknown[]) => sync(...a),
  registerSyncSuccess: vi.fn(), retryPendingSync: vi.fn(),
}));

import {
  investmentsDS, superDS, salesDS, calculateNetWorth, moveOwnerBalance,
} from '../services/dataService';
import { buildNetWorthSeries } from '../utils/netWorthSeries';
import { useStore } from '../store';
import type { BankAccount, Investment } from '../types';
import {
  pricePath, fxPath, TWO_YEARS, SIM_DAYS, round2,
  TruthLedger, ViolationLog, type Regime, type TruthHolding,
} from './marketSim';

// ── The synthetic investor ───────────────────────────────────────────────────

const SIM = 'u-sim';
const BANK = 'acc-sim-everyday';
const LOAN = 'loan-sim-margin';

function seedSim(bankBalance: number, loanBalance = 0) {
  useStore.setState({
    user: {
      id: SIM, email: 'sim@example.test', name: 'Sim Vestor',
      currency_preference: 'AUD', theme: 'system', plan: 'premium',
      onboarding_complete: true,
    } as never,
    token: 'stress-token',
    dataOwnerId: SIM,
    households: [], householdMembers: [], householdInvitations: [],
    financeScope: 'personal', activeHouseholdId: null,
    accounts: [{
      id: BANK, user_id: SIM, name: 'Everyday', balance: bankBalance,
      institution: 'CBA', account_type: 'transaction', currency: 'AUD',
      is_manual: true, household_ids: [],
    } as unknown as BankAccount],
    creditCards: [], transactions: [], subscriptions: [],
    investments: [], investmentSales: [], superFunds: [], incomeEntries: [],
    bills: [], goals: [], goalContributions: [],
    loans: loanBalance > 0 ? [{
      id: LOAN, user_id: SIM, name: 'Margin loan', loan_type: 'personal',
      current_balance: loanBalance, original_amount: loanBalance,
      interest_rate: 8.5, minimum_repayment: 0, repayment_frequency: 'monthly',
      include_in_net_worth: true, household_ids: [],
    }] : [],
    loanEvents: [],
    properties: [], insurancePolicies: [], insurancePremiumHistory: [],
    budgets: [], recordShares: [], shareCodes: [], recurringSeries: [],
    transactionSplits: [], creditCardStatements: [], pendingPayments: [],
    ccPaymentPrompts: [], alertStates: [], budgetSettings: null,
    budgetLines: [], customCategories: [], merchants: [], merchantAliases: [],
    transactionRules: [], billSubExclusions: [], hiddenCategories: [],
    selectedCategories: null, categoryAliases: {}, notifications: [],
    netWorth: null, idMap: {}, pendingSyncQueue: [],
    basiqUserId: null,
  } as never);
}

// ── Portfolio specs ──────────────────────────────────────────────────────────

interface HoldingSpec {
  key: string; name: string; ticker?: string; market: string; asset_type: string;
  units: number; price0: number; seed: number; currency: 'AUD' | 'USD';
  cost0: number;               // native currency
  divPerUnitQ: number;         // quarterly dividend per unit, native ccy
  volScale?: number;           // crypto etc. move harder
  fixed?: boolean;             // cash / unpriced private: price never moves
}

interface PortfolioSpec {
  name: string;
  fxSeed: number;              // one AUD/USD path per portfolio
  bank0: number;
  super0: number | null;
  loan0?: number;              // static margin-loan debt, counted in net worth
  holdings: HoldingSpec[];
}

const PORTFOLIOS: PortfolioSpec[] = [
  {
    name: 'steady-AU', fxSeed: 11, bank0: 40_000, super0: null,
    holdings: [
      { key: 'vas', name: 'Vanguard Australian Shares', ticker: 'VAS', market: 'ASX', asset_type: 'etf', units: 1_400, price0: 101.4, seed: 101, currency: 'AUD', cost0: 112_000, divPerUnitQ: 0.95 },
      { key: 'cba', name: 'Commonwealth Bank', ticker: 'CBA', market: 'ASX', asset_type: 'stock', units: 300, price0: 178.2, seed: 102, currency: 'AUD', cost0: 28_500, divPerUnitQ: 2.30 },
      { key: 'cash', name: 'Brokerage cash', market: 'CASH', asset_type: 'cash', units: 1, price0: 15_000, seed: 103, currency: 'AUD', cost0: 15_000, divPerUnitQ: 0, fixed: true },
    ],
  },
  {
    name: 'global-USD', fxSeed: 23, bank0: 65_000, super0: null,
    holdings: [
      { key: 'vts', name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE', asset_type: 'etf', units: 400, price0: 310.5, seed: 201, currency: 'USD', cost0: 60_000, divPerUnitQ: 0.85 },
      { key: 'aapl', name: 'Apple', ticker: 'AAPL', market: 'NASDAQ', asset_type: 'stock', units: 120, price0: 232.7, seed: 202, currency: 'USD', cost0: 21_000, divPerUnitQ: 0.26 },
      { key: 'btc', name: 'Bitcoin', ticker: 'BTC', market: 'CRYPTO', asset_type: 'crypto', units: 0.85, price0: 148_000, seed: 203, currency: 'AUD', cost0: 42_000, divPerUnitQ: 0, volScale: 2.5 },
      { key: 'priv', name: 'Startup equity', market: 'PRIVATE', asset_type: 'private', units: 10_000, price0: 0, seed: 204, currency: 'AUD', cost0: 50_000, divPerUnitQ: 0, fixed: true },
    ],
  },
  {
    name: 'super-heavy', fxSeed: 37, bank0: 22_000, super0: 412_800,
    holdings: [
      { key: 'a200', name: 'Betashares A200', ticker: 'A200', market: 'ASX', asset_type: 'etf', units: 210, price0: 141.1, seed: 301, currency: 'AUD', cost0: 25_000, divPerUnitQ: 1.10 },
      { key: 'gold', name: 'Gold bullion', market: 'METAL', asset_type: 'precious_metal', units: 500, price0: 158, seed: 302, currency: 'AUD', cost0: 38_000, divPerUnitQ: 0 },
    ],
  },
  {
    // Geared hard enough that the crash takes net worth through zero — the
    // arithmetic must reconcile on the way down, at the bottom and back up.
    name: 'leveraged', fxSeed: 41, bank0: 8_000, super0: null, loan0: 420_000,
    holdings: [
      { key: 'ndq', name: 'Betashares Nasdaq 100', ticker: 'NDQ', market: 'ASX', asset_type: 'etf', units: 6_000, price0: 48.2, seed: 401, currency: 'AUD', cost0: 240_000, divPerUnitQ: 0.12 },
      { key: 'tsla', name: 'Tesla', ticker: 'TSLA', market: 'NASDAQ', asset_type: 'stock', units: 180, price0: 262.4, seed: 402, currency: 'USD', cost0: 40_000, divPerUnitQ: 0, volScale: 1.8 },
    ],
  },
];

const scaleVol = (regimes: Regime[], k: number): Regime[] =>
  regimes.map(r => ({ ...r, vol: r.vol * k }));

// ── The march ────────────────────────────────────────────────────────────────

interface MarchResult {
  log: ViolationLog;
  truth: TruthLedger;
  finalAppNw: number;
  minAppNw: number;
}

/**
 * Two years, day by day, through the real services.
 * `pageMirrors` replays the Investments page's own write-back
 * (enrichAll → setInvestments) after every mutating day, exactly as
 * pages/Investments.tsx:401-405 does.
 */
function march(spec: PortfolioSpec, pageMirrors: boolean): MarchResult {
  const loan0 = spec.loan0 ?? 0;
  seedSim(spec.bank0, loan0);
  const truth = new TruthLedger();
  const log = new ViolationLog();
  const fx = fxPath(spec.fxSeed, 1.52);

  truth.deposit(BANK, spec.bank0);
  let minAppNw = Infinity;

  // Day 0 — build the portfolio through the real create path.
  for (const h of spec.holdings) {
    const path = h.fixed ? null : pricePath(h.seed, h.price0, scaleVol(TWO_YEARS, h.volScale ?? 1));
    const rec = investmentsDS.add({
      name: h.name, ticker: h.ticker, market: h.market, asset_type: h.asset_type,
      shares_owned: h.units, cost_basis: h.cost0,
      native_currency: h.currency, cost_basis_currency: h.currency,
      conversion_rate: h.currency === 'USD' ? fx[0] : 1,
      is_dividend_paying: h.divPerUnitQ > 0, current_price: h.price0,
    });
    truth.holdings.set(h.key, {
      id: rec.id, key: h.key, units: h.units, path, fixedPrice: h.price0,
      fx: h.currency === 'USD' ? fx : null, costNative: h.cost0,
      dividendPerUnit: h.divPerUnitQ,
    });
  }

  let superId: string | null = null;
  let superBal = 0;
  if (spec.super0 != null) {
    superBal = spec.super0;
    superId = superDS.add({
      fund_name: 'Sim Super', balance: superBal,
      employer_contributions: 0, personal_contributions: 0,
      include_in_investments: true, include_in_net_worth: true,
    } as never).id;
    truth.superBalance = superBal;
  }
  const superGrowth = pricePath(spec.fxSeed * 13 + 5, 100, TWO_YEARS);

  const mirror = () => {
    if (!pageMirrors) return;
    const { all } = investmentsDS.enrichAll();
    useStore.getState().setInvestments(all as never);
  };
  mirror();

  const priceOf = (t: TruthHolding, day: number) => (t.path ? t.path[day] : t.fixedPrice);
  const fxOf = (t: TruthHolding, day: number) => (t.fx ? t.fx[day] : 1);
  // Sim day → calendar date. Day 0 = 2024-09-02, so day 730 lands in Sep 2026.
  const isoDay = (day: number) =>
    new Date(Date.UTC(2024, 8, 2) + day * 86_400_000).toISOString().slice(0, 10);

  /** Replays pages/Investments.tsx handleSell EXACTLY (lines 421-459), plus the
   *  user banking the net proceeds — the app records the disposal but moves no
   *  cash itself, so a faithful user books the deposit as a manual credit. */
  const sellLikeThePage = (t: TruthHolding, qty: number, fees: number, day: number) => {
    const inv = investmentsDS.getAll().investments.find(i => i.id === t.id)!;
    const origQty = inv.shares_owned || 0;
    const q = Math.min(qty, origQty) || origQty;
    const fraction = origQty > 0 ? q / origQty : 1;
    const totalCostPref = inv.display_cost ?? inv.cost_basis;
    const costSold = round2(totalCostPref * fraction);
    const proceeds = round2(q * priceOf(t, day) * fxOf(t, day));

    salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: q,
      proceeds, fees, cost_basis: costSold,
      acquired_date: isoDay(0), sale_date: isoDay(day), currency: 'AUD',
    });
    if (q >= origQty - 1e-9) {
      investmentsDS.remove(inv.id, true);
      truth.holdings.delete(t.key);
    } else {
      investmentsDS.update(inv.id, {
        shares_owned: parseFloat((origQty - q).toFixed(8)),
        cost_basis: round2(inv.cost_basis * (1 - fraction)),
      });
      t.units = parseFloat((t.units - q).toFixed(8));
      t.costNative = round2(t.costNative * (1 - fraction));
    }
    const banked = round2(proceeds - fees);
    moveOwnerBalance(BANK, 'bank', banked);
    truth.deposit(BANK, banked);
  };

  for (let day = 1; day <= SIM_DAYS; day++) {
    // ── Market: every priced holding gets today's close (and FX for USD rows),
    // through the same update the edit modal uses.
    for (const t of truth.holdings.values()) {
      if (!t.path) continue;
      investmentsDS.update(t.id, {
        current_price: t.path[day],
        ...(t.fx ? { conversion_rate: t.fx[day] } : {}),
      });
    }

    // ── Cash flows.
    if (day % 14 === 6) { moveOwnerBalance(BANK, 'bank', 3_100); truth.deposit(BANK, 3_100); }
    if (day % 30 === 22) { moveOwnerBalance(BANK, 'bank', -2_400); truth.deposit(BANK, -2_400); }

    // ── Quarterly dividends, converted at today's FX, banked.
    if (day % 91 === 45) {
      for (const t of truth.holdings.values()) {
        if (t.dividendPerUnit <= 0) continue;
        const div = round2(t.units * t.dividendPerUnit * fxOf(t, day));
        moveOwnerBalance(BANK, 'bank', div);
        truth.deposit(BANK, div);
      }
    }

    // ── Super: monthly market growth, quarterly contribution.
    if (superId) {
      if (day % 30 === 15) {
        const g = superGrowth[day] / superGrowth[day - 30 < 0 ? 0 : day - 30];
        superBal = round2(superBal * g);
        superDS.update(superId, { balance: superBal });
        truth.superBalance = superBal;
      }
      if (day % 91 === 60) {
        superBal = round2(superBal + 2_750);
        superDS.update(superId, { balance: superBal });
        truth.superBalance = superBal;
      }
    }

    // ── Buys: 25 more units of the first holding, brokerage $9.50. The stored
    // cost basis is LOCKED in AUD (converted once at each purchase's rate), so a
    // buy adds today's AUD cost to the row's existing AUD cost — never a
    // native-currency total that would be revalued later.
    if (day === 100 || day === 420 || day === 500) {
      const t = truth.holdings.get(spec.holdings[0].key);
      if (t) {
        const q = 25;
        const costNative = round2(q * priceOf(t, day));
        const costAud = round2(costNative * fxOf(t, day));
        t.units += q;
        t.costNative = round2(t.costNative + costNative);
        const row = useStore.getState().investments.find(i => i.id === t.id)!;
        investmentsDS.update(t.id, { shares_owned: t.units, cost_basis: round2(row.cost_basis + costAud) });
        moveOwnerBalance(BANK, 'bank', -(costAud + 9.5));
        truth.deposit(BANK, -(costAud + 9.5));
      }
    }

    // ── Sells: 30% of the second holding mid-sideways; all of it post-crash.
    if (day === 250) {
      const t = truth.holdings.get(spec.holdings[1].key);
      if (t) sellLikeThePage(t, t.units * 0.3, 19.95, day);
    }
    if (day === 460) {
      const t = truth.holdings.get(spec.holdings[1].key);
      if (t) sellLikeThePage(t, t.units, 19.95, day);
    }

    // ── A new holding bought mid-simulation.
    if (day === 300 && spec.name === 'steady-AU') {
      const path = pricePath(999, 62.4, TWO_YEARS);
      const cost = round2(80 * path[day]);
      const rec = investmentsDS.add({
        name: 'Global ETF', ticker: 'VGS', market: 'ASX', asset_type: 'etf',
        shares_owned: 80, cost_basis: cost, native_currency: 'AUD',
        is_dividend_paying: false, current_price: path[day],
      });
      truth.holdings.set('vgs', {
        id: rec.id, key: 'vgs', units: 80, path, fixedPrice: path[day],
        fx: null, costNative: cost, dividendPerUnit: 0,
      });
      moveOwnerBalance(BANK, 'bank', -(cost + 9.5));
      truth.deposit(BANK, -(cost + 9.5));
    }

    mirror();

    // ── Invariants, every single day.
    const { investments: enriched, portfolio_total: pageTotal } = investmentsDS.getAll();

    for (const t of truth.holdings.values()) {
      const row = enriched.find(i => i.id === t.id);
      if (!row) { log.all.push({ day, kind: 'missing-holding', detail: t.key, diff: 0 }); continue; }
      log.check(day, `value:${t.key}`, row.display_value ?? NaN, truth.holdingValue(t, day), 0.011, t.key);
    }
    if (enriched.length !== truth.holdings.size) {
      log.all.push({ day, kind: 'holding-count', detail: `app=${enriched.length} truth=${truth.holdings.size}`, diff: enriched.length - truth.holdings.size });
    }

    const truthInv = truth.investmentsTotal(day);
    log.check(day, 'page-total', pageTotal, truthInv, 0.25);

    const nw = calculateNetWorth();
    log.check(day, 'overview-investments', nw.investments, truthInv, 0.25);
    log.check(day, 'overview-bank', nw.bank_balance, round2(truth.bankTotal()), 0.02);
    log.check(day, 'overview-super', nw.super, truth.superBalance, 0.01);
    log.check(day, 'overview-loans', nw.loans, loan0, 0.005);
    log.check(day, 'net-worth', nw.net_worth, round2(truth.netWorth(day) - loan0), 0.5);
    log.check(day, 'page-vs-overview', pageTotal, nw.investments, 0.25);
    if (nw.net_worth < minAppNw) minAppNw = nw.net_worth;
  }

  return { log, truth, finalAppNw: calculateNetWorth().net_worth, minAppNw };
}

// ── The runs ─────────────────────────────────────────────────────────────────

beforeEach(() => { sync.mockClear(); });

describe.each(PORTFOLIOS.map(p => [p.name, p] as const))(
  'two-year daily march — %s',
  (_name, spec) => {
    it('holds every invariant when the user lives on Overview (no page write-back)', () => {
      const { log } = march(spec, false);
      expect(log.all, `\n${log.report()}`).toEqual([]);
    });

    it('holds every invariant when the Investments page mirrors after each day', () => {
      const { log } = march(spec, true);
      expect(log.all, `\n${log.report()}`).toEqual([]);
    });

    it('is deterministic — same seed, same final net worth to the cent', () => {
      const a = march(spec, false);
      const b = march(spec, false);
      expect(b.finalAppNw).toBe(a.finalAppNw);
    });
  },
);

describe('the crash must be survivable arithmetic', () => {
  it('the leveraged portfolio really does cross zero — and reconciles anyway', () => {
    const { log, minAppNw } = march(PORTFOLIOS[3], false);
    expect(log.all, `\n${log.report()}`).toEqual([]);
    // If gearing never took the total negative, the scenario isn't testing the
    // zero crossing — tighten the loan, don't weaken this.
    expect(minAppNw).toBeLessThan(0);
  });
});

describe('every mutation the march made is durable (synced), so a reload converges', () => {
  it('prices, buys, sells, cash moves and super changes all enqueue sync ops', () => {
    march(PORTFOLIOS[2], false); // super-heavy: exercises super.update too
    const kinds = new Set(sync.mock.calls.map(c => c[0]));
    expect(kinds).toContain('investment.create');
    expect(kinds).toContain('investment.update');
    expect(kinds).toContain('investment.delete');
    expect(kinds).toContain('sale.create');
    expect(kinds).toContain('account.adjust');
    expect(kinds).toContain('super.update');
  });
});

describe('portfolio-total churn — incremental add/remove must not drift', () => {
  // add() increments the store total and remove() decrements it (rather than
  // recomputing), so a long churn of creates and deletes is where float drift
  // would accumulate if the two legs ever disagreed.
  it('forty add/remove cycles land the store total back on zero', () => {
    seedSim(10_000);
    for (let i = 0; i < 40; i++) {
      const rec = investmentsDS.add({
        name: `Churn ${i}`, ticker: `C${i}`, market: 'NYSE', asset_type: 'stock',
        shares_owned: 7 + i * 0.3, cost_basis: 1_000 + i * 33.33,
        native_currency: 'USD', cost_basis_currency: 'USD',
        conversion_rate: 1.4 + (i % 9) * 0.037, current_price: 87.65 + i * 1.01,
      });
      investmentsDS.remove(rec.id);
    }
    // Restated: there was a `store.portfolioTotal` mirror of this figure,
    // asserted here alongside it. It was persisted, written from five places and
    // read by no screen — a second total that could only ever be wrong — so it
    // was deleted. The one total is the one every screen already computed.
    expect(investmentsDS.getAll().portfolio_total).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  FINDINGS — defects this hunt surfaced (F1–F7), all FIXED in the 2026-08 cost
//  source-of-truth cleanup. Each block asserts the correct behaviour plainly
//  and stands as a permanent regression.
// ═════════════════════════════════════════════════════════════════════════════

/** One enriched-in-store holding, the shape a server bootstrap (or the
 *  Investments page's own write-back) leaves behind: display_value and
 *  display_cost present on the stored row. */
function addAndMirror(data: Parameters<typeof investmentsDS.add>[0]): Investment {
  const rec = investmentsDS.add(data);
  const { all } = investmentsDS.enrichAll();
  useStore.getState().setInvestments(all as never);
  return useStore.getState().investments.find(i => i.id === rec.id)!;
}

describe('F1 — a bare price update must reach the Overview net worth', () => {
  // WAS: calculateNetWorth preferred a stored display_value, so a row stamped by
  // a bootstrap or the page's write-back kept its old value in net worth after a
  // bare update — two screens, two answers. FIXED: netWorthFrom derives every
  // holding's value from current_value × conversion_rate; a stamp is never an
  // authority.
  it('Overview investments equals the Investments page total after update()', () => {
    seedSim(10_000);
    const row = addAndMirror({
      name: 'Vanguard Australian Shares', ticker: 'VAS', market: 'ASX',
      asset_type: 'etf', shares_owned: 100, cost_basis: 8_000,
      native_currency: 'AUD', current_price: 100,
    });
    expect(row.display_value).toBe(10_000); // the server-shaped precondition

    investmentsDS.update(row.id, { current_price: 200 }); // no page visit

    const pageTotal = investmentsDS.getAll().portfolio_total;   // 20,000
    const overview = calculateNetWorth().investments;
    expect(pageTotal).toBeCloseTo(20_000, 2);
    expect(overview).toBeCloseTo(pageTotal, 2);
  });
});

describe('F2 — a partial sale must not double the remaining cost basis', () => {
  // WAS: enrichLocalInvestment trusted a present display_cost over the row's own
  // cost_basis, so the stale stamp priced the remainder against the FULL
  // pre-sale cost all session. FIXED: enrichment derives cost from the locked
  // cost_basis alone; a stored display_cost is never read.
  it('after selling half, the remainder\'s P&L uses half the cost', () => {
    seedSim(10_000);
    const row = addAndMirror({
      name: 'Commonwealth Bank', ticker: 'CBA', market: 'ASX',
      asset_type: 'stock', shares_owned: 100, cost_basis: 10_000,
      native_currency: 'AUD', current_price: 150,
    });
    expect(row.display_cost).toBe(10_000); // server-shaped precondition

    // Replay handleSell (pages/Investments.tsx:421-459) for 50 of 100 units.
    const inv = investmentsDS.getAll().investments.find(i => i.id === row.id)!;
    const fraction = 50 / 100;
    salesDS.record({
      investment_id: inv.id, name: inv.name, ticker: inv.ticker ?? null,
      asset_type: inv.asset_type, market: inv.market, quantity: 50,
      proceeds: 7_500, fees: 19.95,
      cost_basis: round2((inv.display_cost ?? inv.cost_basis) * fraction),
      acquired_date: '2024-01-15', sale_date: '2026-08-01', currency: 'AUD',
    });
    investmentsDS.update(inv.id, {
      shares_owned: 50, cost_basis: round2(inv.cost_basis * (1 - fraction)),
    });

    const after = investmentsDS.getAll().investments.find(i => i.id === row.id)!;
    // 50 × $150 = $7,500 value against $5,000 of remaining cost → +$2,500.
    // The stale display_cost of $10,000 reports it as −$2,500 instead.
    expect(after.verification?.profit_loss).toBeCloseTo(2_500, 2);
  });
});

describe('F3 — deleting a super fund must be durable', () => {
  // WAS: superDS.remove deleted locally and synced nothing ("No delete endpoint
  // yet"), so the fund resurrected on the next bootstrap. FIXED: super.delete
  // sync op + DELETE /investments/super/:id.
  it('superDS.remove enqueues a sync op', () => {
    seedSim(10_000);
    const fund = superDS.add({
      fund_name: 'Doomed Super', balance: 250_000,
      employer_contributions: 0, personal_contributions: 0,
      include_in_investments: true, include_in_net_worth: true,
    } as never);
    sync.mockClear();

    superDS.remove(fund.id);

    expect(useStore.getState().superFunds).toHaveLength(0);   // locally gone…
    expect(sync).toHaveBeenCalled();                          // …and durably gone
  });
});

describe('F4 — P&L must not depend on when the Investments page was last open', () => {
  // WAS: the write-back stamped display_cost at that day's rate and enrichment
  // trusted the stamp forever, so the same row showed two different profits
  // depending on whether the page had been visited. FIXED: the cost is locked
  // in AUD at acquisition (add() converts once at the purchase-time rate) and
  // enrichment derives from it — both worlds now read the same historical cost,
  // whatever the rate does afterwards.
  it('the same holding shows the same P&L with or without a prior page visit', () => {
    const mk = () => investmentsDS.add({
      name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE',
      asset_type: 'etf', shares_owned: 400, cost_basis: 60_000,
      native_currency: 'USD', cost_basis_currency: 'USD',
      conversion_rate: 1.52, current_price: 310.5,
    });

    // Visited: page write-back ran BEFORE the FX move.
    seedSim(10_000);
    const a = addAndMirror({
      name: 'Vanguard Total US', ticker: 'VTS', market: 'NYSE',
      asset_type: 'etf', shares_owned: 400, cost_basis: 60_000,
      native_currency: 'USD', cost_basis_currency: 'USD',
      conversion_rate: 1.52, current_price: 310.5,
    });
    investmentsDS.update(a.id, { conversion_rate: 1.30 });
    const plVisited = investmentsDS.getAll().investments
      .find(i => i.id === a.id)!.verification!.profit_loss;

    // Never visited: no write-back, FX move lands on the raw row.
    seedSim(10_000);
    const b = mk();
    investmentsDS.update(b.id, { conversion_rate: 1.30 });
    const plFresh = investmentsDS.getAll().investments
      .find(i => i.id === b.id)!.verification!.profit_loss;

    expect(plVisited).toBeCloseTo(plFresh, 2);
  });
});

describe('F5 — a net worth of exactly zero is a value, not missing data', () => {
  // WAS: buildNetWorthSeries guarded on TRUTHY liveNetWorth, so assets exactly
  // covering debts read as "no data" — a $0 change and a chart that never
  // reached today. FIXED: "not loaded" is spelled null; 0 is plotted and
  // measured like any other reading.
  it('falling from $500 to $0.00 reports a −$500 change, ending at zero', () => {
    const nowMs = new Date('2026-08-27T00:00:00Z').getTime();
    const s = buildNetWorthSeries({
      adjusted: null,
      history: [{ recorded_at: '2026-08-01T00:00:00Z', value: 500 }],
      liveNetWorth: 0,
      excludeStructural: false,
      nowMs,
    });
    expect(s.amount).toBe(-500);
    expect(s.points[s.points.length - 1].y).toBe(0);
  });
});

describe('F6 — recovering from negative net worth must not read as a loss', () => {
  // WAS: pct divided by a signed startValue, sign-flipping every percentage for
  // the whole stretch a geared user spent underwater. FIXED: percentages are
  // measured against |startValue| so they always point the same way as the
  // dollar change.
  it('the % change and the $ change point the same way', () => {
    const nowMs = new Date('2026-08-27T00:00:00Z').getTime();
    const s = buildNetWorthSeries({
      adjusted: null,
      history: [{ recorded_at: '2026-08-01T00:00:00Z', value: -10_000 }],
      liveNetWorth: -5_000,
      excludeStructural: false,
      nowMs,
    });
    expect(s.amount).toBe(5_000);
    expect(Math.sign(s.pct ?? 0)).toBe(Math.sign(s.amount));
  });
});

describe('F7 — the sale row\'s CGT discount flag uses anniversaries, not days', () => {
  // WAS: discount_eligible tested held_days > 365, which across a leap day
  // discounted an exactly-twelve-month hold the ATO does not. FIXED: the row
  // (salesDS.record, the backend POST /sales and the SellModal preview) all use
  // the CGT engine's own `ownedTwelveMonths` anniversary test; held_days stays
  // a display-only day count.
  it('a leap-spanning exactly-12-month hold is not discount eligible', () => {
    seedSim(10_000);
    const sale = salesDS.record({
      name: 'Leap Co', ticker: 'LEAP', asset_type: 'stock', market: 'ASX',
      quantity: 100, proceeds: 20_000, fees: 10, cost_basis: 10_000,
      acquired_date: '2024-02-01', sale_date: '2025-02-01', currency: 'AUD',
    });
    expect(sale.held_days).toBe(366);
    expect(sale.discount_eligible).toBe(false);
  });
});
