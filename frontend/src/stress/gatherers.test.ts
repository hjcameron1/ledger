/**
 * PRE-MARKET STRESS TEST — every pure engine, through its REAL gatherer.
 *
 * The audit's coverage finding: unit tests pass while the integration is broken
 * (C2's dedupe had four passing unit tests and had never once fired in the
 * running app, because the tests hand-built inputs the gatherer never
 * produces). This file drives each engine through the accessor the app itself
 * uses, over the seeded 4-user / 3-household world, for every user — so a
 * gatherer that quietly diverges from its engine's expectations fails HERE,
 * not on a user's screen.
 *
 * It also pins the Low-finding fixes at the integration level:
 *   L1  household reconciliation is never IEEE negative zero
 *   L2  an unstorable amount is clamped before it can poison a total
 *   L3  an empty store raises no alert at all
 *   L4  one annualisation convention across incomeDS and scenarioDS
 *   L5  personal-by-nature slices never surface another user's rows
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
  accountsDS, transactionsDS, incomeDS, scenarioDS, superDS, subscriptionsDS,
  recurringSeriesDS, pendingPaymentsDS, salesDS, creditCardStatementsDS,
  alertsDS, insightsDS, budgetReportDS, forecastDS, goalReportDS,
  insuranceReportDS, loanReportDS, propertyReportDS, householdReportDS,
  reviewDS, taxYearDS, calculateNetWorth, askDS, currentScope, householdContext,
} from '../services/dataService';
import { activeHousehold } from '../utils/household';
import { buildAttentionFeed } from '../utils/attention';
import { annualEquivalent } from '../utils/adaptiveForecast';
import { useStore } from '../store';
import { seedAs, AS_OF } from './seed';
import { MARA, DEV, NINA, THEO, HH_HOME, HH_INV, HH_FAM } from './world';

const EVERYONE = [MARA, DEV, NINA, THEO];
const HOUSEHOLDS = [HH_HOME, HH_INV, HH_FAM];

beforeEach(() => { sync.mockClear(); });

/** Every number reachable in a report must be finite — NaN is a regression. */
function scanFinite(value: unknown, path = 'root'): void {
  if (typeof value === 'number') {
    expect(Number.isFinite(value), `${path} is ${value}`).toBe(true);
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => scanFinite(v, `${path}[${i}]`)); return; }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) scanFinite(v, `${path}.${k}`);
  }
}

// ─── The sweep: every engine through its real gatherer, for every user ──────

describe('every engine builds through its real gatherer, for every user', () => {
  for (const who of EVERYONE) {
    it(`${who}: the full report surface builds finite and well-formed`, () => {
      seedAs({ as: who });

      const budget = budgetReportDS.build({ asOf: AS_OF, includeUnbudgeted: true });
      scanFinite(budget, 'budget');
      // The interest note can never claim more than the month spent in total.
      expect(budget.interestSpent).toBeLessThanOrEqual(Math.max(budget.totalSpent, 0) + 0.01);

      const forecast = forecastDS.build({ asOf: AS_OF });
      scanFinite(forecast, 'forecast');

      const alerts = alertsDS.build({ asOf: AS_OF });
      scanFinite(alerts.visible.map(a => a.facts), 'alerts');
      for (const a of alerts.all) expect(a.title.length).toBeGreaterThan(0);

      const insights = insightsDS.build({ asOf: AS_OF });
      for (const i of insights.all) expect(i.title.length).toBeGreaterThan(0);

      // The Overview's merged feed, from the same two real reports it renders.
      const feed = buildAttentionFeed({
        alerts: alerts.visible, insights: insights.visible, reviewCount: 0,
      });
      expect(feed.total).toBe(feed.act.length + feed.know.length);

      scanFinite(goalReportDS.build({ asOf: AS_OF }), 'goals');
      scanFinite(insuranceReportDS.build(AS_OF), 'insurance');
      scanFinite(reviewDS.build({ asOf: AS_OF, kind: 'month' }), 'review');
      scanFinite(calculateNetWorth(), 'netWorth');
      scanFinite(taxYearDS.build({ fy: '2026-2027' }), 'tax');
      scanFinite(loanReportDS.build({ today: AS_OF }), 'loans');
      scanFinite(propertyReportDS.build(), 'property');
      scanFinite(scenarioDS.baselines({ asOf: AS_OF }), 'baselines');
    });
  }

  for (const hh of HOUSEHOLDS) {
    it(`${hh}: the household report reconciles without negative zero (L1)`, () => {
      for (const who of EVERYONE) {
        seedAs({ as: who, scope: 'household', active: hh });
        const report = householdReportDS.build(hh);
        if (!report) continue; // not a member — correctly refused
        scanFinite(report, `household:${hh}`);
        expect(Object.is(report.reconciliation, -0)).toBe(false);
      }
    });
  }
});

// ─── L2: unstorable amounts are clamped at the store-level writers ──────────

describe('L2 — amounts beyond float precision cannot enter the store', () => {
  it('an imported transaction with a non-finite amount lands as zero, not NaN', () => {
    seedAs({ as: DEV });
    const res = transactionsDS.ingest({
      account_id: useStore.getState().accounts[0]?.id ?? 'acc-x',
      account_type: 'bank', date: AS_OF, merchant: 'Broken import row',
      amount: Number.POSITIVE_INFINITY, currency: 'AUD',
      category: 'Uncategorised', category_source: 'auto',
      is_duplicate_flagged: false, is_subscription: false, source: 'statement',
    } as never);
    const row = res.transaction;
    expect(row && Number.isFinite(row.amount)).toBe(true);
    scanFinite(calculateNetWorth(), 'netWorth-after-broken-import');
  });

  it('a balance beyond MAX_SAFE_INTEGER is clamped on account create and update', () => {
    seedAs({ as: DEV });
    const acc = accountsDS.add({
      name: 'Fat finger', institution: 'Test', account_type: 'Everyday',
      balance: 9_007_199_254_740_993, currency: 'AUD', is_manual: true,
    } as never);
    expect(Math.abs(acc.balance)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    const upd = accountsDS.update(acc.id, { balance: -(2 ** 60) });
    expect(Math.abs(upd.balance)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
  });
});

// ─── L3: an empty store says nothing ────────────────────────────────────────

describe('L3 — a brand-new user hears nothing', () => {
  it('alerts, insights and the feed are all empty on an empty store', () => {
    seedAs({
      as: DEV,
      patch: {
        accounts: [], creditCards: [], transactions: [], subscriptions: [],
        investments: [], investmentSales: [], superFunds: [], incomeEntries: [],
        bills: [], goals: [], goalContributions: [], loans: [], loanEvents: [],
        properties: [], insurancePolicies: [], insurancePremiumHistory: [],
        budgets: [], recordShares: [], recurringSeries: [], transactionSplits: [],
        creditCardStatements: [], pendingPayments: [],
      },
    });
    const alerts = alertsDS.build({ asOf: AS_OF });
    expect(alerts.visible).toEqual([]);
    expect(alerts.all).toEqual([]);
    const insights = insightsDS.build({ asOf: AS_OF });
    expect(insights.visible).toEqual([]);
    const feed = buildAttentionFeed({ alerts: alerts.visible, insights: insights.visible, reviewCount: 0 });
    expect(feed.total).toBe(0);
  });
});

// ─── L4: one annualisation convention ───────────────────────────────────────

describe('L4 — the Income page and the scenario baselines agree', () => {
  for (const who of EVERYONE) {
    it(`${who}: every income entry annualises identically on both surfaces`, () => {
      seedAs({ as: who });
      const { entries, projected_annual } = incomeDS.getAll();
      const counted = entries.filter(e => e.is_recurring && e.status === 'approved');

      // display_amount ?? amount — the row idiom. A USD retainer counts at its
      // converted value everywhere (the raw-amount sum was itself a defect this
      // sweep found: US$6,000 in an AUD total whose rows read A$9,120).
      const valueOf = (e: { amount: number; display_amount?: number }) => e.display_amount ?? e.amount;

      // The page total is exactly the shared helper applied to its own entries…
      const expected = Math.round(counted.reduce(
        (s, e) => s + annualEquivalent(valueOf(e), (e.frequency ?? 'monthly') as never), 0) * 100) / 100;
      expect(projected_annual).toBeCloseTo(expected, 2);

      // …and the scenario baseline's monthly figure for the same entry is the
      // same convention divided by twelve — a what-if's "before" column can no
      // longer sit $660/yr away from the Income page it claims to reproduce.
      const base = scenarioDS.baselines({ asOf: AS_OF });
      for (const e of counted) {
        const monthly = base.monthlyIncomeById[e.id];
        if (monthly === undefined) continue; // not a forecastable stream
        expect(monthly * 12).toBeCloseTo(
          annualEquivalent(valueOf(e), (e.frequency ?? 'monthly') as never), 1);
      }
    });
  }
});

// ─── L5: personal-by-nature accessors stand on their own ────────────────────

describe('L5 — a user switch without a bootstrap leaks nothing', () => {
  it('super, subscriptions, series, sales, statements and pending payments all filter by owner', () => {
    // Mara's world is in the store; only the signed-in user changes — exactly
    // the state between a user switch and a completed (or failed) bootstrap.
    seedAs({ as: MARA });
    const u = { id: DEV, email: 'dev@stress.test', name: 'Dev' };
    useStore.setState({ user: u as never });

    for (const [label, rows] of Object.entries({
      super: superDS.getAll(),
      subscriptions: subscriptionsDS.getAll(),
      recurringSeries: recurringSeriesDS.getAll(),
      investmentSales: salesDS.getAll(),
      creditCardStatements: creditCardStatementsDS.getAll(),
      pendingPayments: pendingPaymentsDS.getAll(),
    })) {
      for (const r of rows as { user_id?: string }[]) {
        expect(r.user_id === undefined || r.user_id === DEV, `${label} leaked a row of ${r.user_id}`).toBe(true);
      }
    }

    // And the totals built on them cannot carry Mara's money to Dev's screen.
    const nw = calculateNetWorth();
    expect(nw.super).toBe(0);
  });
});

// ─── Ask, through the real vocabulary ───────────────────────────────────────

describe('Ask answers what Ledger holds', () => {
  it('a near-named policy answers instead of refusing (the audit\'s "home insurance")', () => {
    seedAs({ as: MARA });
    const intent = askDS.interpret('when does my home insurance renew');
    expect(intent.name).toBe('insurance-cover');
    expect(intent.policy?.name).toBe('Home & contents');
    expect(askDS.answer('when does my home insurance renew').headline.toLowerCase()).toContain('renew');
  });

  it('every user can ask what they owe on their cards', () => {
    for (const who of EVERYONE) {
      seedAs({ as: who });
      const a = askDS.answer('what is my credit card debt');
      expect(a.intent, who).toBe('net-worth');
      expect(a.headline.length).toBeGreaterThan(0);
    }
  });

  it('a genuine refusal names debts among what CAN be asked', () => {
    seedAs({ as: DEV });
    const a = askDS.answer('should I refinance my mortgage with a different bank');
    expect(a.intent).toBe('unknown');
    expect(a.headline).toContain('owe');
  });
});

// ─── The one card never contradicts itself ──────────────────────────────────

describe('no under-budget trend beside a live budget alert, any seat', () => {
  it('holds for every user in every scope they can reach', () => {
    const seats: { as: string; scope?: 'personal' | 'household'; active?: string }[] = [
      ...EVERYONE.map(as => ({ as })),
      { as: MARA, scope: 'household', active: HH_HOME },
      { as: MARA, scope: 'household', active: HH_INV },
      { as: DEV, scope: 'household', active: HH_FAM },
      { as: THEO, scope: 'household', active: HH_HOME },
    ];
    for (const seat of seats) {
      seedAs(seat);
      const alerts = alertsDS.build({ asOf: AS_OF });
      const insights = insightsDS.build({ asOf: AS_OF });
      const feed = buildAttentionFeed({ alerts: alerts.visible, insights: insights.visible, reviewCount: 0 });
      const liveBudgetNames = new Set(feed.act
        .filter(i => i.source.kind === 'alert' && (i.source.alert.facts.kind === 'budget-limit' || i.source.alert.facts.kind === 'budget-projected-over'))
        .map(i => (i.source as { alert: { facts: { name: string } } }).alert.facts.name));
      for (const k of feed.know) {
        if (k.source.kind !== 'insight') continue;
        const f = k.source.insight.facts as { kind?: string; trend?: string; name?: string };
        if (f.kind === 'budget-trend' && f.trend === 'under') {
          expect(liveBudgetNames.size === 0 || (f.name !== 'Overall spending' && !liveBudgetNames.has(f.name!)),
            `${seat.as}/${seat.scope ?? 'personal'} shows "${f.name} under" beside a live alert`).toBe(true);
        }
      }
    }
  });
});

// ─── The scope in view is always nameable ───────────────────────────────────

describe('household scope always resolves to a household the pill can name', () => {
  it('a stale or foreign active id falls back to personal, never a nameless view', () => {
    for (const who of EVERYONE) {
      for (const hh of [HH_HOME, HH_INV, HH_FAM, 'hh-stale-gone']) {
        seedAs({ as: who, scope: 'household', active: hh });
        if (currentScope() === 'household') {
          expect(activeHousehold(householdContext())?.name, `${who} viewing ${hh}`).toBeTruthy();
        }
      }
    }
  });
});
