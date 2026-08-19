/**
 * Phase 6.1 — financial insights, end to end through the store.
 *
 * The engine is unit-tested in isolation (utils/insights.test.ts). These are the
 * things it cannot prove on its own — the parts that only exist once the
 * transaction, budget, forecast, loan, property and tax gatherers, the store and
 * the sync queue are wired together:
 *
 *   • real data produces real insights, with no fixtures in between;
 *   • spend is counted the way every other surface counts it (transfers out,
 *     splits distributed), because the DS passes the canonical options;
 *   • a price rise is read off a series' own occurrences;
 *   • coverage comes from the data, so a short history is not compared with a
 *     month that was never loaded;
 *   • an insight never restates a live alert;
 *   • a dismissal reaches the store AND the wire, and survives a rebuild;
 *   • insight state and alert state share one table without pruning each other;
 *   • one user never sees, dismisses or is told about another's data.
 *
 * Sync is mocked, so every claim about "cross-device" is really "the right op,
 * with the right payload, was queued" — which is exactly what the other device
 * replays on bootstrap.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  Budget, Transaction, AlertState, Loan, Property, RecurringSeries,
} from '../types';

vi.hoisted(() => {
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    setItem: (k: string, v: string) => { mem.set(k, String(v)); },
    removeItem: (k: string) => { mem.delete(k); },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size; },
  };
});

vi.mock('./syncQueue', () => ({
  syncWithRetry: vi.fn(),
  registerSyncSuccess: vi.fn(),
  retryPendingSync: vi.fn(),
}));

import { useStore } from '../store';
import { syncWithRetry } from './syncQueue';
import { insightsDS, alertsDS, alertStatesDS } from './dataService';
import { insightWindows } from '../utils/insights';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const TODAY = '2026-08-17';
const { window: WINDOW, previousWindow: PREVIOUS } = insightWindows(TODAY, 30);
const mockedSync = vi.mocked(syncWithRetry);

/** A day inside each window, and one long before both. */
const NOW_DAY = '2026-08-10';        // inside the current window
const THEN_DAY = '2026-07-05';       // inside the previous window
const LONG_AGO = '2026-01-05';       // sets coverage back, so comparisons run

let seq = 0;
const tx = (o: Partial<Transaction> & { amount: number }): Transaction => {
  seq += 1;
  return {
    id: o.id ?? `t${seq}`, user_id: ME, account_id: 'acc-bank', account_type: 'bank',
    date: NOW_DAY, merchant: 'Merchant', currency: 'AUD', category: 'Groceries',
    is_duplicate_flagged: false, is_subscription: false, ...o,
  } as Transaction;
};

/**
 * The one transaction every seed carries: coverage is read off the user's own
 * history, so without something older than the comparison window the engine
 * (correctly) refuses to compare anything.
 */
const anchor = (userId = ME) =>
  tx({ id: `anchor-${userId}`, user_id: userId, amount: -10, date: LONG_AGO, merchant: 'Anchor' });

const budget = (o: Partial<Budget> = {}): Budget => ({
  id: o.id ?? 'b1', user_id: ME, scope: 'category', category: 'Groceries',
  limit_amount: 500, period: 'monthly', rollover_enabled: false, active: true, ...o,
});

const loan = (o: Partial<Loan> = {}): Loan => ({
  id: 'loan-1', user_id: ME, name: 'Mortgage', loan_type: 'mortgage',
  original_amount: 500_000, current_balance: 400_000, interest_rate: 6,
  minimum_repayment: 2_500, repayment_frequency: 'monthly', ...o,
} as Loan);

function seed(opts: {
  transactions?: Transaction[];
  budgets?: Budget[];
  loans?: Loan[];
  properties?: Property[];
  recurringSeries?: RecurringSeries[];
  alertStates?: AlertState[];
  accounts?: any[];
  userId?: string;
} = {}) {
  useStore.setState({
    user: { id: opts.userId ?? ME, email: 'me@example.com' } as any,
    transactions: opts.transactions ?? [],
    budgets: opts.budgets ?? [],
    loans: opts.loans ?? [],
    properties: opts.properties ?? [],
    recurringSeries: opts.recurringSeries ?? [],
    alertStates: opts.alertStates ?? [],
    accounts: opts.accounts ?? [{ id: 'acc-bank', name: 'Everyday', balance: 20_000, type: 'bank' }],
    // Everything the gatherers read — empty unless a test needs it.
    goals: [], goalContributions: [], investments: [], superFunds: [], creditCards: [],
    subscriptions: [], incomeEntries: [], bills: [], loanEvents: [],
    transactionSplits: [], customCategories: [],
  } as any);
}

const build = (opts: { alerts?: boolean } = {}) =>
  insightsDS.build({
    asOf: TODAY,
    alerts: opts.alerts ? alertsDS.build({ asOf: TODAY }) : null,
  });

const kinds = () => build().visible.map(i => i.kind);
const opsOf = (kind: string) => mockedSync.mock.calls.filter(c => c[0] === kind).map(c => c[1] as any);

/**
 * Spending tripled window on window, across two categories.
 *
 * Two rather than one on purpose: a single category that accounts for the whole
 * movement IS the movement, and the engine says so instead of the overall
 * figure. Spreading it keeps both sentences true, which is what these tests are
 * about — the wiring, not the supersession rules (those are unit-tested).
 */
const SPENT_MORE = [
  anchor(),
  tx({ id: 'p1', amount: -400, date: THEN_DAY }),
  tx({ id: 'p2', amount: -200, date: '2026-07-10', category: 'Dining' }),
  tx({ id: 'c1', amount: -1_200, date: NOW_DAY }),
  tx({ id: 'c2', amount: -600, date: '2026-08-04', category: 'Dining' }),
];
const SPEND_KEY = 'insight:spending-change:2026-08';

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Real data in, real insights out
// ═════════════════════════════════════════════════════════════════════════════
describe('building from live store data', () => {
  it('says nothing about a store with nothing in it', () => {
    const report = build();
    expect(report.visible).toEqual([]);
    expect(report.unreadCount).toBe(0);
    expect(report.resolvedKeys).toEqual([]);
  });

  it('reports spending that really moved, with the store as its only source', () => {
    seed({ transactions: SPENT_MORE });
    const insight = build().visible.find(i => i.kind === 'spending-change')!;
    expect(insight.direction).toBe('worsening');
    expect(insight.facts).toMatchObject({ current: 1_800, previous: 600, delta: 1_200 });
    expect(insight.window).toEqual(WINDOW);
    expect(insight.link.to).toContain('/accounts');
  });

  it('rebuilds to the same keys, so nothing accumulates', () => {
    seed({ transactions: SPENT_MORE });
    expect(build().visible.map(i => i.key)).toEqual(build().visible.map(i => i.key));
  });

  it('counts spend the way every other surface counts it — transfers are not spending', () => {
    seed({
      transactions: [
        anchor(),
        tx({ id: 'p1', amount: -400, date: THEN_DAY }),
        // A $5,000 internal movement in the current window. Counted as spending
        // it would dwarf everything; the canonical exclusion set drops it.
        tx({ id: 'move-out', amount: -5_000, date: NOW_DAY, is_transfer: true, transfer_pair_id: 'pair' }),
        tx({ id: 'move-in', amount: 5_000, date: NOW_DAY, is_transfer: true, transfer_pair_id: 'pair' }),
      ],
    });
    expect(kinds()).not.toContain('spending-change');
  });

  it('reads income the way the income tile does — a refund is not income', () => {
    seed({
      transactions: [
        anchor(),
        tx({ id: 'pay-then', amount: 4_000, date: THEN_DAY, category: 'Salary' }),
        tx({ id: 'pay-now', amount: 4_000, date: NOW_DAY, category: 'Salary' }),
        tx({ id: 'refund', amount: 900, date: NOW_DAY, transaction_type: 'refund' } as any),
      ],
    });
    expect(kinds()).not.toContain('income-change');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The other engines, through their own gatherers
// ═════════════════════════════════════════════════════════════════════════════
describe('the engines behind an insight', () => {
  it('prices a recurring rise from the series own occurrences', () => {
    const series: RecurringSeries = {
      id: 'rs-1', user_id: ME, merchant_normalized: 'streamflix', name: 'Streamflix',
      kind: 'subscription', frequency: 'monthly', expected_amount: -20,
      status: 'active',
    } as RecurringSeries;
    seed({
      recurringSeries: [series],
      transactions: [
        anchor(),
        tx({ id: 's1', amount: -20, date: '2026-05-04', merchant: 'Streamflix', merchant_normalized: 'streamflix' } as any),
        tx({ id: 's2', amount: -20, date: '2026-06-04', merchant: 'Streamflix', merchant_normalized: 'streamflix' } as any),
        tx({ id: 's3', amount: -20, date: '2026-07-04', merchant: 'Streamflix', merchant_normalized: 'streamflix' } as any),
        tx({ id: 's4', amount: -32, date: '2026-08-04', merchant: 'Streamflix', merchant_normalized: 'streamflix' } as any),
      ],
    });
    const insight = build().visible.find(i => i.kind === 'recurring-increase')!;
    expect(insight.facts).toMatchObject({
      name: 'Streamflix', amount: 32, previousAmount: 20, annualDelta: 144,
    });
    // Carried from the charge itself, so the engine can tell this rise is the
    // same money as a rise in that category and say it only once.
    expect(insight.facts.kind === 'recurring-increase' && insight.facts.category)
      .toBe('Groceries');
  });

  it('reports what an offset is saving, from the loan report', () => {
    seed({ transactions: [anchor()], loans: [loan({ offset_balance: 80_000 })] });
    const insight = build().visible.find(i => i.kind === 'offset-benefit')!;
    expect(insight.facts).toMatchObject({ offsetBalance: 80_000, savingPerYear: 4_800 });
    expect(insight.link.to).toBe('/loans');
  });

  it('reports a debt being paid down faster than the contract requires', () => {
    seed({
      transactions: [anchor()],
      loans: [loan({ extra_repayment: 800, start_date: '2020-08-01', term_months: 360 })],
    });
    const insight = build().visible.find(i => i.kind === 'debt-progress')!;
    expect(insight.direction).toBe('improving');
    expect(insight.impact.basis).toBe('per-month');
  });

  it('reports a budget missed two complete months running', () => {
    seed({
      budgets: [budget({ limit_amount: 300 })],
      transactions: [
        anchor(),
        tx({ id: 'jun', amount: -900, date: '2026-06-10' }),
        tx({ id: 'jul', amount: -900, date: '2026-07-10' }),
      ],
    });
    const insight = build().visible.find(i => i.kind === 'budget-trend')!;
    expect(insight.facts).toMatchObject({ trend: 'over', months: 2 });
    expect(insight.link.to).toContain('focus=budget');
  });

  it('reports an investment property against what it costs to hold', () => {
    const property: Property = {
      id: 'prop-1', user_id: ME, name: 'Unit 4', property_type: 'investment',
      purchase_price: 600_000, current_value: 750_000, ownership_percent: 100,
      rent_match_terms: ['Ray White'], expected_rent_amount: 700,
      expected_rent_frequency: 'weekly', property_expenses: [],
    } as Property;
    seed({
      properties: [property],
      transactions: [
        anchor(),
        tx({ id: 'rent1', amount: 700, date: '2026-08-01', merchant: 'Ray White', category: 'Rent' }),
        tx({ id: 'rent2', amount: 700, date: '2026-08-08', merchant: 'Ray White', category: 'Rent' }),
      ],
    });
    const insight = build().visible.find(i => i.kind === 'property-performance')!;
    expect(insight.facts).toMatchObject({ name: 'Unit 4', annualRent: 700 * 52 });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Coverage — a short history is not compared with months that were never there
// ═════════════════════════════════════════════════════════════════════════════
describe('sparse history', () => {
  it('takes coverage from the data, not from an assumption', () => {
    seed({ transactions: [anchor()] });
    expect(insightsDS.coverageFrom()).toBe(LONG_AGO);
  });

  it('refuses to compare two windows when the history only reaches one', () => {
    // Everything the user has starts inside the CURRENT window: there is no
    // earlier month to compare against, only an absence of one.
    seed({
      transactions: [
        tx({ id: 'c1', amount: -1_200, date: NOW_DAY }),
        tx({ id: 'c2', amount: -900, date: '2026-08-04' }),
      ],
    });
    const report = build();
    expect(report.visible.map(i => i.kind)).not.toContain('spending-change');
    expect(report.skipped.join(' ')).toContain(PREVIOUS.from);
  });

  it('still reports what needs only the window it does have', () => {
    seed({
      transactions: [tx({ id: 'c1', amount: -1_200, date: NOW_DAY })],
      loans: [loan({ offset_balance: 80_000 })],
    });
    expect(kinds()).toContain('offset-benefit');
  });

  it('does not fall over on a store that holds one transaction', () => {
    seed({ transactions: [tx({ id: 'only', amount: -40, date: NOW_DAY })] });
    expect(() => build()).not.toThrow();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Never two voices on one subject
// ═════════════════════════════════════════════════════════════════════════════
describe('an insight and a live alert', () => {
  /** Groceries doubled AND blew a $300 cap — one situation, two engines. */
  const OVERSPENT = {
    budgets: [budget({ limit_amount: 300 })],
    transactions: SPENT_MORE,
  };

  it('lets the alert speak and stays quiet about the same category', () => {
    seed(OVERSPENT);
    const alerts = alertsDS.build({ asOf: TODAY });
    expect(alerts.visible.map(a => a.key)).toContain('budget-limit:2026-08:groceries');

    const withAlerts = build({ alerts: true }).visible.map(i => i.entity);
    expect(withAlerts).not.toContain('category:groceries');
  });

  it('says it itself when no alert is speaking', () => {
    seed({ transactions: SPENT_MORE });   // no budget, so no budget alert
    expect(build({ alerts: true }).visible.map(i => i.entity)).toContain('spend:overall');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Dismissing, reading and resolving
// ═════════════════════════════════════════════════════════════════════════════
describe('what the user does about an insight', () => {
  beforeEach(() => seed({ transactions: SPENT_MORE }));

  it('dismisses one insight, and only that one', () => {
    const before = build().visible.length;
    alertStatesDS.save(SPEND_KEY, { dismissedStage: 3 });
    const after = build();
    expect(after.visible.map(i => i.key)).not.toContain(SPEND_KEY);
    expect(after.visible.length).toBe(before - 1);
    expect(after.all.find(i => i.key === SPEND_KEY)!.dismissed).toBe(true);
  });

  it('queues the dismissal for every other device', () => {
    const insight = build().visible.find(i => i.key === SPEND_KEY)!;
    alertStatesDS.save(insight.key, { dismissedStage: insight.stage });
    const [payload] = opsOf('alertState.save');
    expect(payload.data).toMatchObject({ alert_key: SPEND_KEY, dismissed_stage: insight.stage });
  });

  it('brings a dismissed insight back once the movement grows', () => {
    // A modest rise first — $250 across two categories, barely over the floor.
    const modest = [
      anchor(),
      tx({ id: 'p1', amount: -400, date: THEN_DAY }),
      tx({ id: 'p2', amount: -400, date: THEN_DAY, category: 'Dining' }),
      tx({ id: 'c1', amount: -530, date: NOW_DAY }),
      tx({ id: 'c2', amount: -520, date: NOW_DAY, category: 'Dining' }),
    ];
    useStore.setState({ transactions: modest } as any);
    const insight = build().visible.find(i => i.key === SPEND_KEY)!;
    expect(insight.stage).toBe(1);

    alertStatesDS.save(insight.key, { dismissedStage: insight.stage });
    expect(build().visible.map(i => i.key)).not.toContain(SPEND_KEY);

    // Another $700 through the same window, split so no single category becomes
    // the whole story: a materially bigger movement, and therefore a higher
    // stage than the one that was dismissed.
    useStore.setState({
      transactions: [
        ...modest,
        tx({ id: 'more1', amount: -350, date: NOW_DAY }),
        tx({ id: 'more2', amount: -350, date: NOW_DAY, category: 'Dining' }),
      ],
    } as any);
    const back = build().visible.find(i => i.key === SPEND_KEY);
    expect(back).toBeTruthy();
    expect(back!.stage).toBeGreaterThan(insight.stage);
  });

  it('records reading at the current stage', () => {
    const insight = build().visible.find(i => i.key === SPEND_KEY)!;
    alertStatesDS.save(insight.key, { readStage: insight.stage });
    expect(build().visible.find(i => i.key === SPEND_KEY)!.unread).toBe(false);
  });

  it('hands back the state of an insight whose movement has passed', () => {
    alertStatesDS.save(SPEND_KEY, { dismissedStage: 1 });
    // Spending settles back to where it was: nothing to say any more.
    useStore.setState({
      transactions: [anchor(), tx({ id: 'p1', amount: -400, date: THEN_DAY }), tx({ id: 'c1', amount: -400, date: NOW_DAY })],
    } as any);
    const report = build();
    expect(report.resolvedKeys).toContain(SPEND_KEY);

    alertStatesDS.prune(report.resolvedKeys);
    expect(useStore.getState().alertStates.map(a => a.alert_key)).not.toContain(SPEND_KEY);
    expect(opsOf('alertState.delete').map(p => p.key)).toContain(SPEND_KEY);
  });

  it('holds the prune guard while the store is still empty', () => {
    useStore.setState({ transactions: [], accounts: [], loans: [], budgets: [] } as any);
    expect(insightsDS.ready()).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Two engines, one table
// ═════════════════════════════════════════════════════════════════════════════
describe('insight state and alert state sharing a store', () => {
  beforeEach(() => {
    seed({ budgets: [budget({ limit_amount: 300 })], transactions: SPENT_MORE });
    alertStatesDS.save(SPEND_KEY, { dismissedStage: 3 });
    alertStatesDS.save('budget-limit:2026-08:groceries', { dismissedStage: 3 });
  });

  it('never reports the other side rows as resolved', () => {
    expect(alertsDS.build({ asOf: TODAY }).resolvedKeys).not.toContain(SPEND_KEY);
    expect(build().resolvedKeys).not.toContain('budget-limit:2026-08:groceries');
  });

  it('honours each side own dismissal', () => {
    expect(alertsDS.build({ asOf: TODAY }).visible.map(a => a.key))
      .not.toContain('budget-limit:2026-08:groceries');
    expect(build().visible.map(i => i.key)).not.toContain(SPEND_KEY);
  });

  it('keeps both rows in the one table', () => {
    expect(useStore.getState().alertStates.map(a => a.alert_key).sort())
      .toEqual(['budget-limit:2026-08:groceries', SPEND_KEY]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One user's money is not another's
// ═════════════════════════════════════════════════════════════════════════════
describe('user isolation', () => {
  it('ignores another user transactions entirely', () => {
    seed({
      transactions: [
        anchor(),
        ...SPENT_MORE.slice(1).map(t => ({ ...t, user_id: OTHER })),
      ],
    });
    expect(kinds()).not.toContain('spending-change');
  });

  it('takes coverage from the signed-in user history alone', () => {
    seed({
      transactions: [
        { ...anchor(OTHER), date: '2020-01-01' },
        tx({ id: 'mine', amount: -40, date: NOW_DAY }),
      ],
    });
    expect(insightsDS.coverageFrom()).toBe(NOW_DAY);
  });

  it('ignores another user loans', () => {
    seed({
      transactions: [anchor()],
      loans: [loan({ user_id: OTHER, offset_balance: 80_000 })],
    });
    expect(kinds()).not.toContain('offset-benefit');
  });

  it('ignores another user budgets', () => {
    seed({
      budgets: [budget({ user_id: OTHER, limit_amount: 300 })],
      transactions: [
        anchor(),
        tx({ id: 'jun', amount: -900, date: '2026-06-10' }),
        tx({ id: 'jul', amount: -900, date: '2026-07-10' }),
      ],
    });
    expect(kinds()).not.toContain('budget-trend');
  });

  it('never applies another user dismissal to my insight', () => {
    seed({
      transactions: SPENT_MORE,
      alertStates: [{
        id: 'as-other', user_id: OTHER, alert_key: SPEND_KEY, dismissed_stage: 3,
      } as AlertState],
    });
    expect(build().visible.map(i => i.key)).toContain(SPEND_KEY);
  });

  it('never prunes another user stored state', () => {
    seed({
      transactions: [anchor()],
      alertStates: [{
        id: 'as-other', user_id: OTHER, alert_key: 'insight:spending-change:2026-08', dismissed_stage: 1,
      } as AlertState],
    });
    expect(build().resolvedKeys).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Signals that disagree
// ═════════════════════════════════════════════════════════════════════════════
describe('conflicting signals in one store', () => {
  it('reports spending down and income down together, worst first', () => {
    seed({
      transactions: [
        anchor(),
        // Previous window: big pay, big spend.
        tx({ id: 'p-pay', amount: 7_000, date: THEN_DAY, category: 'Salary' }),
        tx({ id: 'p-spend', amount: -3_500, date: THEN_DAY }),
        tx({ id: 'p-spend2', amount: -3_500, date: THEN_DAY, category: 'Dining' }),
        // Current window: less of both — spending improved, income did not.
        tx({ id: 'c-pay', amount: 2_000, date: NOW_DAY, category: 'Salary' }),
        tx({ id: 'c-spend', amount: -2_000, date: NOW_DAY }),
        tx({ id: 'c-spend2', amount: -2_000, date: NOW_DAY, category: 'Dining' }),
      ],
    });
    const report = build();
    const byKind = new Map(report.visible.map(i => [i.kind, i.direction]));
    expect(byKind.get('spending-change')).toBe('improving');
    expect(byKind.get('income-change')).toBe('worsening');
    expect(report.visible[0].direction).toBe('worsening');
  });
});
