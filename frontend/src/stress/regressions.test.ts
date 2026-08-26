/**
 * PRE-MARKET STRESS TEST — the regression suite.
 *
 * Every test here asserts the CORRECT behaviour. The suite began life with the
 * defect blocks marked `it.fails`; every finding — Critical, High and Medium —
 * has since been fixed and every marker removed, so the whole file is now a
 * plain regression suite: each block names the defect it pins shut, the users
 * it affected and the invariant that must keep holding.
 *
 * The rule that governed the fixes still governs edits here: an assertion
 * states the correct behaviour and is never weakened to go green. A baseline
 * figure may be restated only when an UPSTREAM fix legitimately changed the
 * correct answer, with a comment saying which fix and why.
 *
 * The companion file scenarioSweep.test.ts sweeps the same world across every
 * user and scope; this one pins the individual findings.
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
  taxYearDS, forecastDS, budgetReportDS, goalReportDS, reviewDS, calculateNetWorth,
  householdReportDS, accountsDS, billsDS, askDS, propertyReportDS, insuranceReportDS,
  sharingDS, transactionsDS, documentsDS, subscriptionsDS, recurringSeriesDS,
} from '../services/dataService';
import { useStore } from '../store';
import { canEdit } from '../utils/household';
import { seedAs, seedDocuments, AS_OF } from './seed';
import { MARA, DEV, NINA, THEO, HH_HOME, HH_INV, HH_FAM, visibleTo } from './world';

const ctxOf = () => ({
  userId: useStore.getState().user?.id ?? null,
  households: useStore.getState().households,
  members: useStore.getState().householdMembers,
  activeHouseholdId: useStore.getState().activeHouseholdId,
});

beforeEach(() => { sync.mockClear(); });

// ═════════════════════════════════════════════════════════════════════════════
//  CRITICAL
// ═════════════════════════════════════════════════════════════════════════════

describe('C1 — a tax return must contain only its own owner\'s transactions', () => {
  it('Nina\'s deductions exclude Mara\'s rental costs', () => {
    seedAs({ as: NINA, scope: 'personal' });
    const t = taxYearDS.build({ fy: '2026-2027' });
    // Nina's only deductible transaction is her own $89.99 Adobe subscription.
    // $4,517 of Mara's strata/council/interest is reaching her return.
    expect(t.deductibleExpenses).toBeCloseTo(89.99, 2);
  });

  it('Dev\'s deductions exclude Mara\'s Officeworks purchase', () => {
    seedAs({ as: DEV, scope: 'personal' });
    expect(taxYearDS.build({ fy: '2026-2027' }).deductibleExpenses).toBe(0);
  });

  it('Mara\'s deductions exclude Nina\'s software subscription', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const t = taxYearDS.build({ fy: '2026-2027' });
    // 4,517 of rental costs. Nina's 89.99 must not be here — and since M3 the
    // 420 of work equipment isn't either: it is dated 2026-09-02, eight days
    // ahead, and the position stops at today.
    expect(t.deductibleExpenses).toBeCloseTo(4_517, 2);
  });

  it('a tax return does not move when the Personal/Household switch moves', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const personal = taxYearDS.build({ fy: '2026-2027' });
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const household = taxYearDS.build({ fy: '2026-2027' });
    expect(household.assessableIncome).toBe(personal.assessableIncome);
    expect(household.deductibleExpenses).toBe(personal.deductibleExpenses);
  });

  it('another member\'s property never enters your rental schedule', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_INV });
    const ids = (taxYearDS.build({ fy: '2026-2027' }).rental?.properties ?? []).map(p => p.id);
    expect(ids).not.toContain('prop-nina');
  });
});

describe('C2 — the forecast must count each obligation once', () => {
  it('a bill mirroring a loan repayment is suppressed', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const f = forecastDS.build({ asOf: AS_OF });
    expect(f.suppressed.map(s => s.id)).toContain('bill:bill-mortgage');
  });

  it('a bill mirroring a subscription is suppressed', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const f = forecastDS.build({ asOf: AS_OF });
    expect(f.suppressed.map(s => s.id)).toContain('bill:bill-netflix');
  });

  it('the mortgage is projected once a month, not twice', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const f = forecastDS.build({ asOf: AS_OF });
    const sept = f.events.filter(e => e.date.startsWith('2026-09') && Math.abs(e.amount) === 4_800);
    expect(sept).toHaveLength(1);
  });

  it('Netflix is projected once a month, not three times', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const f = forecastDS.build({ asOf: AS_OF });
    const sept = f.events.filter(e => e.date.startsWith('2026-09') && /netflix/i.test(e.name));
    expect(sept).toHaveLength(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  HIGH
// ═════════════════════════════════════════════════════════════════════════════

describe('H1 — the household budget is the household\'s', () => {
  it('a household-shared budget produces a line for every member', () => {
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const r = budgetReportDS.build({ asOf: AS_OF });
    // Mara's Groceries and Dining caps are shared into HH_HOME.
    expect(r.categories.map(c => c.key).sort()).toEqual(['dining', 'groceries']);
  });

  it('household category spend counts every member\'s spending', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const mara = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true });
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const dev = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true });
    // One household, one figure — whoever is looking.
    expect(mara.spendByCategory['Groceries']).toBeCloseTo(dev.spendByCategory['Groceries'], 2);
  });

  it('the same category is not "over" for one member and "under" for the other', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const personal = budgetReportDS.build({ asOf: AS_OF }).categories.find(c => c.key === 'groceries');
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const household = budgetReportDS.build({ asOf: AS_OF }).categories.find(c => c.key === 'groceries');
    expect(household?.status).toBe(personal?.status);
  });
});

describe('H2 — a household you are not in must never answer as another household', () => {
  it('asking for a household you are not in returns nothing, not someone else\'s money', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_FAM });   // Mara is not in HH_FAM
    // householdReportDS refuses (returns null); calculateNetWorth answers with HH_HOME.
    expect(householdReportDS.build(HH_FAM)).toBeNull();
    expect(calculateNetWorth().net_worth).toBe(0);
  });

  it('being removed from a household does not silently swap you into another one', () => {
    seedAs({ as: THEO, scope: 'household', active: HH_HOME });
    const before = calculateNetWorth().net_worth;
    useStore.setState({
      householdMembers: useStore.getState().householdMembers.map(m =>
        m.household_id === HH_HOME && m.user_id === THEO ? { ...m, status: 'removed' } : m),
    } as never);
    const after = calculateNetWorth().net_worth;
    // It currently jumps to HH_FAM's $41.7m. It should show nothing at all.
    expect(after).not.toBe(before);
    expect(after).toBe(0);
  });
});

describe('H3 — a shared goal shows one figure to everybody', () => {
  it('both members see the same progress on a shared goal', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const mara = goalReportDS.build({ asOf: AS_OF }).lines.find(l => l.id === 'goal-holiday');
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const dev = goalReportDS.build({ asOf: AS_OF }).lines.find(l => l.id === 'goal-holiday');
    expect(mara?.saved).toBe(dev?.saved);
  });
});

describe('H4 — the Review screen follows the scope switch', () => {
  it('a household review reports the household\'s spending', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const personal = reviewDS.totals('2026-07-01', '2026-07-31');
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const household = reviewDS.totals('2026-07-01', '2026-07-31');
    // HH_HOME in July holds both partners' spending; it cannot equal one partner's.
    expect(household.spend).not.toBe(personal.spend);
  });
});

describe('H5 — the forecast follows the scope switch and is the same for everyone in it', () => {
  it('personal subscriptions do not appear in a household forecast', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const ids = forecastDS.gather({ asOf: AS_OF }).inputs.map(i => i.id);
    // sub-spotify is Mara's personal subscription; it is in no household.
    expect(ids).not.toContain('sub:sub-spotify');
  });

  it('a personal recurring series does not appear in a household forecast', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const ids = forecastDS.gather({ asOf: AS_OF }).inputs.map(i => i.id);
    // rs-rent runs on an HH_INV account and is Mara's own series.
    expect(ids).not.toContain('series:rs-rent');
  });

  it('one household has one forecast, whoever is looking at it', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const mara = forecastDS.build({ asOf: AS_OF }).horizons[0];
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const dev = forecastDS.build({ asOf: AS_OF }).horizons[0];
    expect(mara.inflow).toBeCloseTo(dev.inflow, 2);
    expect(mara.outflow).toBeCloseTo(dev.outflow, 2);
  });
});

describe('H6 — the client must refuse a write the server will refuse', () => {
  it('the permission engine itself knows a viewer may not edit', () => {
    seedAs({ as: THEO, scope: 'household', active: HH_HOME });
    const joint = useStore.getState().accounts.find(a => a.id === 'acc-joint')!;
    expect(canEdit(joint, ctxOf())).toBe(false);
  });

  it('a viewer editing a shared account changes nothing and queues nothing', () => {
    seedAs({ as: THEO, scope: 'household', active: HH_HOME });
    accountsDS.update('acc-joint', { balance: 1 });
    expect(useStore.getState().accounts.find(a => a.id === 'acc-joint')?.balance).toBe(24_500);
    expect(sync.mock.calls.map(c => c[0])).not.toContain('account.update');
  });

  it('a viewer cannot delete a shared account off their own screen', () => {
    seedAs({ as: THEO, scope: 'household', active: HH_HOME });
    accountsDS.remove('acc-joint');
    expect(useStore.getState().accounts.find(a => a.id === 'acc-joint')).toBeTruthy();
    expect(sync.mock.calls.map(c => c[0])).not.toContain('account.delete');
  });

  it('a member cannot delete the owner\'s shared account (delete is owner-only)', () => {
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    accountsDS.remove('acc-joint');
    expect(useStore.getState().accounts.find(a => a.id === 'acc-joint')).toBeTruthy();
    expect(sync.mock.calls.map(c => c[0])).not.toContain('account.delete');
  });

  it('a view-only direct grant cannot rewrite the owner\'s balance', () => {
    seedAs({ as: NINA, scope: 'personal' });
    accountsDS.update('acc-mara-saver', { balance: 0 });
    expect(useStore.getState().accounts.find(a => a.id === 'acc-mara-saver')?.balance).toBe(88_000);
  });
});

describe('H7 — paying a bill is idempotent', () => {
  it('marking the same bill paid twice charges the account once', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const before = calculateNetWorth().bank_balance;
    billsDS.pay('bill-power');
    billsDS.pay('bill-power');
    expect(calculateNetWorth().bank_balance).toBe(before - 340);
    expect(useStore.getState().transactions.filter(t => t.merchant?.includes('Electricity'))).toHaveLength(1);
  });
});

describe('H8 — a household must not lose a mortgage it can see the house for', () => {
  it('a shared property whose mortgage is not shared does not read as owned outright', () => {
    seedAs({ as: NINA, scope: 'household', active: HH_INV });
    const r = householdReportDS.build(HH_INV)!;
    // The shopfront is $430k with $96k owing. The household counts the asset and
    // not the debt, so it is $96,000 too rich.
    const ninaLine = r.members.find(m => m.userId === NINA)!;
    expect(ninaLine.netWorth.property).toBe(334_000);
  });

  it('one property contributes the same figure on every screen', () => {
    seedAs({ as: NINA, scope: 'personal' });
    const personal = calculateNetWorth().property;
    seedAs({ as: NINA, scope: 'household', active: HH_INV });
    const inHousehold = householdReportDS.build(HH_INV)!.members.find(m => m.userId === NINA)!.netWorth.property;
    expect(inHousehold).toBe(personal);
  });
});

describe('H9 — a property whose loan row is gone must say so', () => {
  it('a broken property→loan link is surfaced, not silently treated as no debt', () => {
    seedAs({ as: DEV, scope: 'personal' });
    const report = propertyReportDS.build(AS_OF) as never as { rows: Record<string, unknown>[] };
    const row = report.rows.find(r => r.id === 'prop-dev-orphan')!;
    // The property points at `loan-deleted`. Goals report broken links; property does not.
    expect((row as { loanLinkBroken?: boolean }).loanLinkBroken).toBe(true);
  });
});

describe('H10 — Ask Ledger answers the question it was asked', () => {
  it('a merchant question is answered about that merchant', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const a = askDS.answer('how much did I spend at JB Hi-Fi');
    const lead = (a.figures ?? [])[0];
    // JB Hi-Fi net of the refund is $0. It currently answers with total spend.
    expect(lead?.value).not.toBe(5_380.26);
  });

  it('a loan-balance question is answered from the loan, not the bills list', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const a = askDS.answer('what do I owe on the home mortgage');
    expect((a.figures ?? []).some(f => f.value === 780_400)).toBe(true);
  });

  it('a credit-card debt question is supported', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(askDS.interpret('what is my credit card debt').name).not.toBe('unknown');
  });

  it('Ask and the Budget screen give the same category total', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const ask = askDS.answer('how much did I spend on groceries this month');
    const budget = budgetReportDS.build({ asOf: AS_OF }).spendByCategory['Groceries'];
    expect((ask.figures ?? [])[0]?.value).toBeCloseTo(budget, 2);
  });
});

describe('H11 — a duplicate category cap is resolved deterministically', () => {
  it('two caps on the same category do not silently drop the other', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const r = budgetReportDS.build({ asOf: AS_OF });
    const groceries = r.categories.find(c => c.key === 'groceries')!;
    // Two rows exist: Groceries $900 and groceries $400, neither timestamped.
    // Array order currently decides; $900 is the one the user set up.
    // `baseLimit` is the cap itself — `effectiveLimit` adds this row's rollover
    // carry on top, so it answers a different question than "which cap won".
    expect(groceries.id).toBe('bud-groceries');
    expect(groceries.baseLimit).toBe(900);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  MEDIUM
// ═════════════════════════════════════════════════════════════════════════════

describe('M1 — a responsibility split means the same thing on every screen', () => {
  it('budget spend honours a responsibility split, as the shared-spending panel does', () => {
    // Mara's OWN budget, which is where a responsibility split changes an
    // answer: the household's total is the household's however it is divided.
    // (Stated against the personal scope since H1 was fixed — before that the
    // household figure was one member's, which is what this used to compare to.)
    seedAs({ as: MARA, scope: 'personal' });
    const dining = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).spendByCategory['Dining'];
    const members = sharingDS.memberSpending(HH_HOME);
    // The $420 dinner is split 280/140. The budget charges Mara all 420, so her
    // Dining reads 483.61 where her share of the table is 140 less.
    expect(dining).toBeCloseTo(343.61, 2);
    expect(members.find(m => m.userId === DEV)?.responsible).toBeGreaterThan(0);
  });
});

describe('M2 — an expired policy is not sold as current cover', () => {
  it('the annual-premium total excludes cover that has lapsed', () => {
    seedAs({ as: NINA, scope: 'personal' });
    const r = insuranceReportDS.build(AS_OF);
    expect(r.expired.map(l => l.id)).toContain('pol-expired');
    expect(r.totalAnnualPremium).toBe(0);
  });
});

describe('M3 — the tax position stops at today', () => {
  it('a future-dated transaction is not claimed in the current year', () => {
    seedAs({ as: MARA, scope: 'personal' });
    // Mara's own deductibles are $4,517 of rental costs plus tx-ded-1
    // (Officeworks $420), which is dated 2026-09-02 — eight days from now and
    // therefore not yet spent. Only the $4,517 has happened.
    // (The figure this asserted before C1 was fixed included $89.99 of Nina's;
    // the leak is gone, so the expectation is stated in Mara's own money.)
    expect(taxYearDS.build({ fy: '2026-2027' }).deductibleExpenses).toBeCloseTo(4_517, 2);
  });
});

describe('M4 — a document follows the record it is filed against', () => {
  it('unsharing a loan takes its statement out of the household view', async () => {
    const v = visibleTo(MARA);
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    await seedDocuments(v.documents);
    sharingDS.unshare('loan', 'loan-home', HH_HOME);
    expect(documentsDS.inScope().map(d => d.id)).not.toContain('doc-home-loan');
  });
});

describe('M5 — a recurring bill survives being paid', () => {
  it('paying a recurring bill leaves the next occurrence in the list', () => {
    seedAs({ as: MARA, scope: 'personal' });
    billsDS.pay('bill-power');
    expect(billsDS.getAll().map(b => b.name)).toContain('Electricity');
  });

  it('and the forecast keeps projecting it', () => {
    seedAs({ as: MARA, scope: 'personal' });
    billsDS.pay('bill-power');
    const ids = forecastDS.gather({ asOf: AS_OF }).inputs.map(i => i.id);
    expect(ids).toContain('bill:bill-power');
  });
});

describe('M6 — the property page agrees with itself', () => {
  it('portfolio cash flow does not fold the owner-occupied home\'s mortgage into rental performance', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const totals = (propertyReportDS.build(AS_OF) as never as { totals: Record<string, number> }).totals;
    // The one rented property's own card says −$2,231/yr.
    expect(totals.annualCashFlow).toBeCloseTo(-2_231, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Invariants that DO hold — guard rails for the fixes above
// ═════════════════════════════════════════════════════════════════════════════

describe('holds today — do not regress', () => {
  it('a transfer pair is neither spend nor income', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const r = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true });
    expect(r.spendByCategory['Transfers']).toBeUndefined();
    expect(r.spendByCategory['Credit Card']).toBeUndefined();
  });

  it('a refund nets its purchase to zero rather than counting twice', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true }).spendByCategory['Electronics']).toBe(0);
  });

  it('a split transaction is reported by its lines, not its parent', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const r = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true });
    expect(r.spendByCategory['Home']).toBe(150);
    expect(r.spendByCategory['Health']).toBe(70);
  });

  it('a card repayment moves no balance twice — the card row stays authoritative', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(calculateNetWorth().credit_card_debt).toBe(8_412.90);
  });

  it('a directly-shared account is visible but enters nobody else\'s net worth', () => {
    seedAs({ as: NINA, scope: 'personal' });
    expect(useStore.getState().accounts.find(a => a.id === 'acc-mara-saver')).toBeTruthy();
    expect(calculateNetWorth().bank_balance).toBe(32_100);
  });

  it('a hidden account is out of net worth and out of the forecast', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(calculateNetWorth().bank_balance).toBe(284_941);   // 999,999 excluded
    expect(forecastDS.gather({ asOf: AS_OF }).accounts.map(a => a.accountId)).not.toContain('acc-hidden');
  });

  it('the same row shared with two households counts once in each, never twice in one', () => {
    seedAs({ as: MARA, scope: 'personal' });
    sharingDS.share('account', 'acc-joint', HH_INV);
    useStore.getState().setFinanceScope('household');
    useStore.getState().setActiveHouseholdId(HH_HOME);
    expect(calculateNetWorth().bank_balance).toBe(175_140.55);
    useStore.getState().setActiveHouseholdId(HH_INV);
    expect(calculateNetWorth().bank_balance).toBe(60_800);
  });

  it('the same row present twice under one id is counted once', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    const before = calculateNetWorth().bank_balance;
    const joint = useStore.getState().accounts.find(a => a.id === 'acc-joint')!;
    useStore.setState({ accounts: [...useStore.getState().accounts, { ...joint }] } as never);
    expect(calculateNetWorth().bank_balance).toBe(before);
  });

  it('the household total is exactly the members\' contributions added up', () => {
    for (const [who, hh] of [[MARA, HH_HOME], [NINA, HH_INV], [DEV, HH_FAM]] as [string, string][]) {
      seedAs({ as: who, scope: 'household', active: hh });
      const r = householdReportDS.build(hh)!;
      const summed = r.members.reduce((s, m) => s + m.netWorth.net_worth, 0);
      expect(Math.abs(r.total.net_worth - summed)).toBeLessThan(0.005);
    }
  });

  it('unsharing an account takes its inherited transactions with it', () => {
    seedAs({ as: MARA, scope: 'household', active: HH_HOME });
    useStore.setState({
      transactions: useStore.getState().transactions.map(t => ({ ...t, household_ids: [] })),
    } as never);
    const before = transactionsDS.getAll().length;
    sharingDS.unshare('account', 'acc-joint', HH_HOME);
    expect(transactionsDS.getAll().length).toBeLessThan(before);
    expect(transactionsDS.getAll().some(t => t.account_id === 'acc-joint')).toBe(false);
  });

  it('one member\'s private rows never reach another member\'s screen', () => {
    seedAs({ as: DEV, scope: 'household', active: HH_HOME });
    const ids = accountsDS.getAll().map(a => a.id);
    expect(ids).not.toContain('acc-mara-saver');
    expect(ids).not.toContain('acc-mara-usd');
    seedAs({ as: THEO, scope: 'personal' });
    expect(accountsDS.getAll().map(a => a.id)).toEqual(['acc-theo-est']);
  });

  it('a removed member is granted nothing by their old membership row', () => {
    seedAs({ as: THEO, scope: 'household', active: HH_INV });   // removed from HH_INV
    expect(householdReportDS.build(HH_INV)).toBeNull();
  });

  it('foreign-currency rows are counted in the display currency everywhere', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const nw = calculateNetWorth();
    expect(nw.bank_balance).toBe(284_941);           // USD 12,000 → AUD 18,240
    expect(nw.investments).toBe(589_004);            // VTS at display_value
    seedAs({ as: NINA, scope: 'personal' });
    expect(budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true })
      .spendByCategory['Subscriptions']).toBeCloseTo(717.14, 2);
  });

  it('an SMSF-held property adds nothing on top of the fund balance', () => {
    seedAs({ as: MARA, scope: 'personal' });
    // 1,850,000 home + 460,000 owned share of the unit. The $1.2m warehouse is
    // inside the SMSF balance already.
    expect(calculateNetWorth().property).toBe(2_310_000);
  });

  it('a property opted out of net worth contributes nothing', () => {
    seedAs({ as: THEO, scope: 'personal' });
    expect(calculateNetWorth().property).toBe(0);
  });

  it('an opted-out mortgage is netted by its property exactly once', () => {
    seedAs({ as: NINA, scope: 'personal' });
    const nw = calculateNetWorth();
    expect(nw.property).toBe(334_000);   // 430,000 − 96,000
    expect(nw.loans).toBe(0);            // the loans term skips it
  });

  it('a decade-old and a future-dated transaction stay out of this month', () => {
    seedAs({ as: MARA, scope: 'personal' });
    const r = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true });
    expect(r.spendByCategory['Travel'] ?? 0).toBe(0);
  });

  it('a brand-new account reports nothing rather than something wrong', () => {
    seedAs({ as: MARA, scope: 'personal', patch: {
      accounts: [], creditCards: [], transactions: [], investments: [], superFunds: [],
      loans: [], properties: [], bills: [], goals: [], budgets: [], incomeEntries: [],
      insurancePolicies: [], subscriptions: [], recurringSeries: [], transactionSplits: [],
    } });
    expect(calculateNetWorth().net_worth).toBe(0);
    expect(forecastDS.build({ asOf: AS_OF }).horizons.every(h => h.net === 0)).toBe(true);
    expect(budgetReportDS.build({ asOf: AS_OF }).totalSpent).toBe(0);
  });

  it('the shareable accessors still refuse what they always refused', () => {
    seedAs({ as: DEV, scope: 'personal' });
    expect(sharingDS.canShare('account', 'acc-joint', HH_INV).ok).toBe(false);
    seedAs({ as: THEO, scope: 'household', active: HH_HOME });
    expect(sharingDS.canShare('account', 'acc-theo-est', HH_HOME))
      .toEqual({ ok: false, error: 'Viewers can see shared money but not add to it.' });
  });

  it('re-sharing into a household it is already in is refused', () => {
    seedAs({ as: MARA, scope: 'personal' });
    expect(sharingDS.share('account', 'acc-joint', HH_HOME))
      .toEqual({ ok: false, error: "That's already shared with this household." });
  });

  it('subscriptions and recurring series are never another user\'s', () => {
    seedAs({ as: DEV, scope: 'personal' });
    expect(subscriptionsDS.getAll().every(s => !s.user_id || s.user_id === DEV)).toBe(true);
    expect(recurringSeriesDS.getAll().every(s => !s.user_id || s.user_id === DEV)).toBe(true);
  });
});
