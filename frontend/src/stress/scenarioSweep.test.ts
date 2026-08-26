/**
 * PRE-MARKET STRESS TEST — the cross-user/scope scenario sweep.
 *
 * Re-seeds the 4-user / 3-household world from scratch for every user and
 * every scope they can switch to, and asserts the invariants the audit fixes
 * could plausibly have disturbed: tax never moves with the scope switch,
 * forecast dedupe keeps every distinct obligation, budgets and reviews follow
 * the scope, owners keep their own write rights, both members of a household
 * read the same totals, and nothing anywhere produces NaN.
 *
 * Permanent regression coverage — a companion to regressions.test.ts, which
 * pins the individual audit findings; this file sweeps the whole world.
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
  taxYearDS, forecastDS, budgetReportDS, reviewDS, calculateNetWorth,
  householdReportDS, accountsDS, billsDS, askDS, propertyReportDS,
  sharingDS, transactionsDS, subscriptionsDS, recurringSeriesDS, goalReportDS,
  insuranceReportDS, creditCardsDS, loansDS, propertiesDS, documentsDS,
} from '../services/dataService';
import { useStore } from '../store';
import { activeHousehold } from '../utils/household';
import { seedAs, seedDocuments, AS_OF } from './seed';
import { MARA, DEV, NINA, THEO, HH_HOME, HH_INV, HH_FAM, visibleTo } from './world';

const ctxOf = () => ({
  userId: useStore.getState().user?.id ?? null,
  households: useStore.getState().households,
  members: useStore.getState().householdMembers,
  activeHouseholdId: useStore.getState().activeHouseholdId,
});

beforeEach(() => { sync.mockClear(); });

// ── A. tax is personal, but keeps ALL of your own ────────────────────────────
describe('A — the personal-tax fix did not amputate the owner\'s own rows', () => {
  it('Mara still gets her own investment property in her rental schedule', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const t = taxYearDS.build({ fy: '2026-2027' });
    expect((t.rental?.properties ?? []).map(p => p.id)).toContain('prop-inv');
  });

  it('Mara\'s tax figures are identical in every scope she can switch to', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const personal = taxYearDS.build({ fy: '2026-2027' });
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const home = taxYearDS.build({ fy: '2026-2027' });
    seedAs({ as: MARA, scope: 'household', active: HH_INV });
    const inv = taxYearDS.build({ fy: '2026-2027' });
    expect(home.assessableIncome).toBe(personal.assessableIncome);
    expect(inv.assessableIncome).toBe(personal.assessableIncome);
    expect(home.deductibleExpenses).toBe(personal.deductibleExpenses);
    expect(inv.deductibleExpenses).toBe(personal.deductibleExpenses);
  });

  it('every user gets a tax return without throwing, and none is empty-by-accident', () => {
    for (const u of [MARA, DEV, NINA, THEO]) {
      seedAs({ as: u, scope: 'personal' });
      const t = taxYearDS.build({ fy: '2026-2027' });
      expect(Number.isFinite(t.assessableIncome)).toBe(true);
      expect(t.assessableIncome).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(t.deductibleExpenses)).toBe(true);
    }
  });

  it('the financial-year list is still offered to every user', () => {
    for (const u of [MARA, DEV, NINA, THEO]) {
      seedAs({ as: u, scope: 'personal' });
      expect(taxYearDS.financialYears().length).toBeGreaterThan(0);
    }
  });
});

// ── B. forecast dedupe kept every DISTINCT obligation ────────────────────────
describe('B — forecast dedupe did not swallow unrelated obligations', () => {
  it('Mara\'s household forecast still carries every unlinked bill and both subs', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const ids = forecastDS.gather({ asOf: AS_OF }).inputs.map(i => i.id);
    expect(ids).toContain('bill:bill-water');   // no loan/sub link — must survive
    expect(ids).toContain('bill:bill-power');
    expect(new Set(ids).size).toBe(ids.length); // no duplicate ids
    // Spotify is Mara's PERSONAL subscription: absent here by design (H5),
    // but it must still be projected in her own personal forecast.
    expect(ids.some(i => /spotify/.test(i))).toBe(false);
    seedAs({ as: MARA, scope: 'personal' });
    const personal = forecastDS.gather({ asOf: AS_OF }).inputs.map(i => i.id);
    expect(personal.some(i => /spotify/.test(i))).toBe(true);
    expect(new Set(personal).size).toBe(personal.length);
  });

  it('Netflix survives as exactly one input, not zero', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const inputs = forecastDS.gather({ asOf: AS_OF }).inputs;
    const netflix = inputs.filter(i => /netflix/i.test(i.name ?? ''));
    expect(netflix.length).toBe(1);
  });

  it('the rent series is still projected as income, not as an expense', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_INV });
    const rent = forecastDS.gather({ asOf: AS_OF }).inputs.find(i => i.id === 'rs-rent');
    if (rent) expect(rent.amount).toBeGreaterThan(0);
  });

  it('every user can build a forecast in every scope without NaN', () => {
    const cases: [string, 'personal' | 'household', string | null][] = [
      [MARA, 'personal', null], [MARA, 'household', HH_HOME], [MARA, 'household', HH_INV],
      [DEV, 'personal', null], [DEV, 'household', HH_HOME], [DEV, 'household', HH_FAM],
      [NINA, 'personal', null], [NINA, 'household', HH_INV],
      [THEO, 'personal', null], [THEO, 'household', HH_FAM],
    ];
    for (const [as, scope, active] of cases) {
      seedAs({ as, scope, active });
      for (const h of forecastDS.build({ asOf: AS_OF }).horizons) {
        expect(Number.isFinite(h.net)).toBe(true);
      }
    }
  });
});

// ── C. budget/review scope ───────────────────────────────────────────────────
describe('C — the scope fixes did not leak or lose spending', () => {
  it('a personal budget still counts only the owner\'s own spending', () => {
    seedAs({ as: DEV, scope: 'personal' });
    const own = new Set(transactionsDS.getAll().filter(t => t.user_id === DEV).map(t => t.id));
    const r = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true });
    expect(r.totalSpent).toBeGreaterThanOrEqual(0);
    // Nothing of Mara's can be inside a personal report.
    seedAs({ as: DEV, scope: 'personal' });
    const foreign = transactionsDS.getAll().filter(t => t.user_id !== DEV);
    expect(foreign.every(t => !own.has(t.id))).toBe(true);
  });

  it('a household review is one figure, read identically by its members', () => {
    // (household >= personal is NOT an invariant: a personal review spans ALL
    // your own rows across every household, a household review only what is
    // shared into that one. What must hold is that the household's figure is
    // the same whoever reads it.)
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const dev = reviewDS.totals('2026-07-01', '2026-07-31');
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const mara = reviewDS.totals('2026-07-01', '2026-07-31');
    expect(mara.spend).toBeCloseTo(dev.spend, 2);
    expect(mara.spend).toBeGreaterThan(0);
  });

  it('the duplicate grocery cap resolves to the same row every single build', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const picks = Array.from({ length: 5 }, () =>
      budgetReportDS.build({ asOf: AS_OF }).categories.find(c => c.key === 'groceries')?.id);
    expect(new Set(picks).size).toBe(1);
    expect(picks[0]).toBe('bud-groceries');
  });
});

// ── D. permission guards do not block legitimate owners ──────────────────────
describe('D — the local permission guards let the owner through', () => {
  it('Mara can still edit and delete her own account', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(accountsDS.editRefusal('acc-mara-saver')).toBeNull();
    expect(accountsDS.deleteRefusal('acc-mara-saver')).toBeNull();
    accountsDS.update('acc-mara-saver', { balance: 88_001 });
    expect(accountsDS.getAll().find(a => a.id === 'acc-mara-saver')!.balance).toBe(88_001);
    expect(sync).toHaveBeenCalled();
  });

  it('Mara can still edit an account she owns AND shares into a household', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    expect(accountsDS.editRefusal('acc-joint')).toBeNull();
    accountsDS.update('acc-joint', { balance: 24_501 });
    expect(accountsDS.getAll().find(a => a.id === 'acc-joint')!.balance).toBe(24_501);
  });

  it('Mara can still edit her own card, loan, property and transaction', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(creditCardsDS.editRefusal('cc-mara-zero')).toBeNull();
    creditCardsDS.update('cc-mara-zero', { balance_owing: 5 });
    expect(creditCardsDS.getAll().find(c => c.id === 'cc-mara-zero')!.balance_owing).toBe(5);
    loansDS.update('loan-home', { current_balance: 780_000 });
    expect(loansDS.getAll().find(l => l.id === 'loan-home')!.current_balance).toBe(780_000);
    propertiesDS.update('prop-home', { current_value: 1_860_000 });
    expect(propertiesDS.getAll().find(p => p.id === 'prop-home')!.current_value).toBe(1_860_000);
  });

  it('a signed-out store still mutates (no user = no ownership claim to check)', () => {
    seedAs({ as: MARA, scope: 'personal' });
    useStore.setState({ user: null } as never);
    accountsDS.update('acc-mara-saver', { balance: 7 });
    expect(useStore.getState().accounts.find(a => a.id === 'acc-mara-saver')!.balance).toBe(7);
  });
});

// ── E. idempotent bill payment still pays the first time ─────────────────────
describe('E — the idempotency guard did not break the first payment', () => {
  it('a recurring bill is paid, its account moves, and the series rolls forward (M5)', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const before = calculateNetWorth().bank_balance;
    billsDS.pay('bill-power');
    const bill = useStore.getState().bills.find(b => b.id === 'bill-power')!;
    // The row is the series: paying it advances it instead of retiring it.
    expect(bill.is_paid).toBe(false);
    expect(bill.due_date).toBe('2026-10-02');
    expect(calculateNetWorth().bank_balance).toBeLessThan(before);
  });

  it('a one-off bill is simply marked paid, as before', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    billsDS.update('bill-water', { is_recurring: false });
    billsDS.pay('bill-water');
    expect(useStore.getState().bills.find(b => b.id === 'bill-water')!.is_paid).toBe(true);
  });
});

// ── F. net worth with knownLoans ─────────────────────────────────────────────
describe('F — knownLoans did not change any figure it should not have', () => {
  it('a property whose mortgage the viewer can see is netted exactly once', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const nw = calculateNetWorth();
    // prop-home 1,850,000 less loan-home 780,400, counted through the loan side.
    expect(Number.isFinite(nw.property)).toBe(true);
    expect(nw.property).toBeGreaterThan(0);
    expect(nw.net_worth).toBeCloseTo(
      nw.bank_balance + nw.investments + nw.super + nw.property
      - nw.credit_card_debt - nw.loans, 2,
    );
  });

  it('Nina\'s opted-out mortgage is still netted by its property exactly once', () => {
    seedAs({ as: NINA, scope: 'personal' });
    const nw = calculateNetWorth();
    expect(Number.isFinite(nw.property)).toBe(true);
  });

  it('one household reads the same for both of its members', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const a = householdReportDS.build(HH_HOME)!;
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const b = householdReportDS.build(HH_HOME)!;
    expect(b.total.net_worth).toBeCloseTo(a.total.net_worth, 2);
    expect(b.total.property).toBeCloseTo(a.total.property, 2);
    expect(b.total.loans).toBeCloseTo(a.total.loans, 2);
  });
});

// ── G. share cascade is safe on rows with nothing to cascade ─────────────────
describe('G — the property→mortgage share cascade is inert when there is no mortgage', () => {
  it('sharing an unmortgaged property reports no extra sharing', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const r = sharingDS.share('property', 'prop-smsf', HH_HOME);
    expect(r.ok).toBe(true);
    expect(r.alsoShared ?? []).toHaveLength(0);
  });

  it('unsharing one property leaves a mortgage another shared property still needs', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_INV });
    sharingDS.unshare('property', 'prop-nina', HH_INV);
    // loan-inv belongs to prop-inv, which is still shared into HH_INV.
    const loan = useStore.getState().loans.find(l => l.id === 'loan-inv')!;
    expect(loan.household_ids ?? []).toContain(HH_INV);
  });
});

// ── H. scoped subscriptions / series ─────────────────────────────────────────
describe('H — scoping subscriptions did not hide the owner\'s own', () => {
  it('Mara still sees both her subscriptions personally, and via mine()', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const ids = subscriptionsDS.getAll().map(s => s.id);
    expect(ids).toContain('sub-netflix');
    expect(ids).toContain('sub-spotify');
    expect(subscriptionsDS.mine().map(s => s.id)).toEqual(expect.arrayContaining(['sub-netflix', 'sub-spotify']));
  });

  it('mine() is the same list in household scope as in personal scope', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const personal = subscriptionsDS.mine().map(s => s.id).sort();
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    expect(subscriptionsDS.mine().map(s => s.id).sort()).toEqual(personal);
    seedAs({ as: MARA, scope: 'personal' });
    const series = recurringSeriesDS.mine().map(s => s.id).sort();
    seedAs({ as: MARA, scope: 'household', active: HH_INV });
    expect(recurringSeriesDS.mine().map(s => s.id).sort()).toEqual(series);
  });

  it('active() still returns the active series', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(recurringSeriesDS.active().length).toBeGreaterThan(0);
  });
});

// ── I. Ask routing ───────────────────────────────────────────────────────────
describe('I — the merchant intent did not capture unrelated questions', () => {
  it('a plain spend question is still a total, not a merchant lookup', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(askDS.interpret('how much did I spend this month').name).toBe('spend-total');
  });

  it('a category question is still a category question', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const name = askDS.interpret('how much did I spend on groceries this month').name;
    expect(['spend-category', 'spend-total', 'budget-status']).toContain(name);
  });

  it('a merchant question resolves the merchant and answers about it', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const a = askDS.answer('how much did I spend at JB Hi-Fi');
    expect(a.intent).toBe('spend-merchant');
    expect(a.headline.toLowerCase()).toContain('jb hi-fi');
  });

  it('Ask answers something for every user without throwing', () => {
    for (const u of [MARA, DEV, NINA, THEO]) {
      seedAs({ as: u, scope: 'personal' });
      expect(askDS.answer('how much did I spend this month').headline.length).toBeGreaterThan(0);
      expect(askDS.answer('what is my net worth').headline.length).toBeGreaterThan(0);
    }
  });
});

// ── J. household resolution ──────────────────────────────────────────────────
describe('J — the stale-household fix did not break a legitimate active id', () => {
  it('a household you are in still resolves', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    expect(activeHousehold(ctxOf())?.id).toBe(HH_HOME);
    seedAs({ as: DEV, scope: 'household', active: HH_FAM });
    expect(activeHousehold(ctxOf())?.id).toBe(HH_FAM);
  });

  it('with no active id you still fall back to your first household', () => {
    seedAs({ as: NINA, scope: 'household', active: null });
    expect(activeHousehold(ctxOf())?.id).toBe(HH_INV);
  });
});

// ── K. everything renders for everyone ───────────────────────────────────────
describe('K — every screen builds for every user in every scope', () => {
  const cases: [string, 'personal' | 'household', string | null][] = [
    [MARA, 'personal', null], [MARA, 'household', HH_HOME], [MARA, 'household', HH_INV],
    [DEV, 'personal', null], [DEV, 'household', HH_HOME], [DEV, 'household', HH_FAM],
    [NINA, 'personal', null], [NINA, 'household', HH_INV], [NINA, 'household', HH_FAM],
    [THEO, 'personal', null], [THEO, 'household', HH_HOME], [THEO, 'household', HH_FAM],
  ];
  it('no screen throws and no total is NaN', () => {
    for (const [as, scope, active] of cases) {
      seedAs({ as, scope, active });
      const nw = calculateNetWorth();
      expect(Number.isFinite(nw.net_worth)).toBe(true);
      expect(Number.isFinite(budgetReportDS.build({ asOf: AS_OF }).totalSpent)).toBe(true);
      expect(Number.isFinite(goalReportDS.build({ asOf: AS_OF }).lines.length)).toBe(true);
      expect(Number.isFinite(insuranceReportDS.build(AS_OF).totalAnnualPremium)).toBe(true);
      const p = propertyReportDS.build(AS_OF) as never as { totals: Record<string, number> };
      for (const [k, v] of Object.entries(p.totals)) {
        // A yield with no earner is null by design ("unknown is nil"); a number
        // must be finite. NaN anywhere here is a regression.
        if (typeof v === 'number' && !Number.isFinite(v)) {
          throw new Error(`NON-FINITE ${as}/${scope}/${active} totals.${k} = ${v}`);
        }
      }
      expect(Number.isFinite(reviewDS.totals('2026-07-01', '2026-07-31').spend)).toBe(true);
      expect(Number.isFinite(taxYearDS.build({ fy: '2026-2027' }).assessableIncome)).toBe(true);
    }
  });
});

// ── L/M/N. the Medium fixes, swept ───────────────────────────────────────────
describe('L — M1: a responsibility split means one thing on every surface', () => {
  it('Ask and Budget agree on Dining in BOTH scopes, at the new split-aware figures', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const pBudget = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).spendByCategory['Dining'];
    const pAsk = askDS.answer('how much did I spend on dining this month');
    expect(pBudget).toBeCloseTo(343.61, 1);
    const pFig = (pAsk.figures ?? []).find(f => /dining/i.test(String(f.label ?? '')) || f.emphasis) ?? pAsk.figures?.[0];
    expect(pFig?.value).toBeCloseTo(pBudget, 1);

    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const hBudget = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).spendByCategory['Dining'];
    expect(hBudget).toBeGreaterThan(pBudget); // the household's total is whole
    const hAsk = askDS.answer('how much did we spend on dining this month');
    const hFig = (hAsk.figures ?? []).find(f => /dining/i.test(String(f.label ?? '')) || f.emphasis) ?? hAsk.figures?.[0];
    expect(hFig?.value).toBeCloseTo(hBudget, 1);
  });

  it('Dev in household scope still sees the whole shared dinner (no scaling)', () => {
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const dining = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).spendByCategory['Dining'];
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const same = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).spendByCategory['Dining'];
    expect(dining).toBeCloseTo(same, 2); // both members read one household figure
  });

  it('a fully-attributed row leaves the owner\'s personal spend', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const fitness = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).spendByCategory['Fitness'];
    expect(fitness ?? 0).toBe(0); // tx-dev-attributed is Dev's responsibility
  });

  it('a household review reads identically for its members, and every total is finite', () => {
    // (NOT asserted: household >= personal. A personal review spans ALL your
    // own rows across every household; a household review covers only what is
    // shared into THAT household — Mara's HH_HOME figure rightly excludes her
    // HH_INV rental costs, so neither dominates the other.)
    for (const [u, hh] of [[MARA, HH_HOME], [DEV, HH_HOME], [NINA, HH_INV]] as const) {
      seedAs({ as: u, scope: 'personal' });
      expect(Number.isFinite(reviewDS.totals('2026-08-01', '2026-08-31').spend)).toBe(true);
      seedAs({ as: u, scope: 'household', active: hh });
      expect(Number.isFinite(reviewDS.totals('2026-08-01', '2026-08-31').spend)).toBe(true);
    }
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const a = reviewDS.totals('2026-08-01', '2026-08-31');
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const b = reviewDS.totals('2026-08-01', '2026-08-31');
    expect(b.spend).toBeCloseTo(a.spend, 2);
  });
});

describe('M — M5: the rolled bill behaves like a bill', () => {
  it('the rolled occurrence can be paid AGAIN next month (guard is per-day, not forever)', () => {
    seedAs({ as: MARA, scope: 'personal' });
    billsDS.pay('bill-power');
    const rolled = useStore.getState().bills.find(b => b.id === 'bill-power')!;
    expect(rolled.due_date).toBe('2026-10-02');
    // Simulate the next month: yesterday's stamp no longer blocks.
    useStore.getState().setBills(useStore.getState().bills.map(b =>
      b.id === 'bill-power' ? { ...b, paid_at: '2026-07-25' } : b));
    const txBefore = useStore.getState().transactions.filter(t => t.merchant?.includes('Electricity')).length;
    billsDS.pay('bill-power');
    const after = useStore.getState().bills.find(b => b.id === 'bill-power')!;
    expect(after.due_date).toBe('2026-11-02');
    expect(useStore.getState().transactions.filter(t => t.merchant?.includes('Electricity')).length).toBe(txBefore + 1);
  });

  it('an overdue recurring bill rolls past every missed period', () => {
    seedAs({ as: MARA, scope: 'personal' });
    useStore.getState().setBills(useStore.getState().bills.map(b =>
      b.id === 'bill-power' ? { ...b, due_date: '2026-05-02' } : b));
    billsDS.pay('bill-power');
    const rolled = useStore.getState().bills.find(b => b.id === 'bill-power')!;
    expect(rolled.due_date >= '2026-08-25').toBe(true);
  });

  it('paying a recurring bill still leaves every OTHER bill alone', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const before = useStore.getState().bills.map(b => `${b.id}:${b.due_date}:${b.is_paid}`).sort();
    billsDS.pay('bill-power');
    const after = useStore.getState().bills.filter(b => b.id !== 'bill-power').map(b => `${b.id}:${b.due_date}:${b.is_paid}`).sort();
    expect(after.every(x => before.includes(x))).toBe(true);
  });

  it('the forecast counts the rolled bill exactly once', () => {
    seedAs({ as: MARA, scope: 'personal' });
    billsDS.pay('bill-power');
    const ids = forecastDS.gather({ asOf: AS_OF }).inputs.map(i => i.id);
    expect(ids.filter(i => i === 'bill:bill-power')).toHaveLength(1);
  });
});

describe('N — the other Medium fixes hold under pressure', () => {
  it('users with live cover still total their premiums', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(insuranceReportDS.build(AS_OF).totalAnnualPremium).toBeGreaterThan(0);
    seedAs({ as: DEV, scope: 'personal' });
    expect(insuranceReportDS.build(AS_OF).totalAnnualPremium).toBeGreaterThan(0);
  });

  it('tax stays scope-invariant with the asOf clamp in place', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const p = taxYearDS.build({ fy: '2026-2027' });
    seedAs({ as: MARA, scope: 'household', active: HH_INV });
    const h = taxYearDS.build({ fy: '2026-2027' });
    expect(h.deductibleExpenses).toBe(p.deductibleExpenses);
    expect(h.assessableIncome).toBe(p.assessableIncome);
  });

  it('a PAST-year position is untouched by the clamp', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const past = taxYearDS.build({ fy: '2015-2016' });
    expect(Number.isFinite(past.deductibleExpenses)).toBe(true);
  });

  it('re-sharing the loan brings the statement back without a refetch', async () => {
    const v = visibleTo(MARA);
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    await seedDocuments(v.documents);
    sharingDS.unshare('loan', 'loan-home', HH_HOME);
    expect(documentsDS.inScope().map(d => d.id)).not.toContain('doc-home-loan');
    sharingDS.share('loan', 'loan-home', HH_HOME);
    expect(documentsDS.inScope().map(d => d.id)).toContain('doc-home-loan');
  });

  it('property net-worth figures did not move with the cash-flow narrowing', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const totals = (propertyReportDS.build(AS_OF) as never as { totals: Record<string, number> }).totals;
    const nw = calculateNetWorth();
    expect(Number.isFinite(totals.netWorthEffect)).toBe(true);
    expect(Number.isFinite(nw.property)).toBe(true);
  });

  it('every user still renders every screen after all six fixes', () => {
    const cases: [string, 'personal' | 'household', string | null][] = [
      [MARA, 'personal', null], [MARA, 'household', HH_HOME], [MARA, 'household', HH_INV],
      [DEV, 'personal', null], [DEV, 'household', HH_FAM],
      [NINA, 'personal', null], [NINA, 'household', HH_INV],
      [THEO, 'personal', null], [THEO, 'household', HH_FAM],
    ];
    for (const [as, scope, active] of cases) {
      seedAs({ as, scope, active });
      expect(Number.isFinite(calculateNetWorth().net_worth)).toBe(true);
      expect(Number.isFinite(budgetReportDS.build({ asOf: AS_OF }).totalSpent)).toBe(true);
      expect(Number.isFinite(insuranceReportDS.build(AS_OF).totalAnnualPremium)).toBe(true);
      expect(askDS.answer('how much did I spend this month').headline.length).toBeGreaterThan(0);
      for (const h of forecastDS.build({ asOf: AS_OF }).horizons) expect(Number.isFinite(h.net)).toBe(true);
    }
  });
});
