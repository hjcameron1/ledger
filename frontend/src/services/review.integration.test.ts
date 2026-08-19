/**
 * Phase 6.2 — the financial review, end to end through the store.
 *
 * The engine is unit-tested in isolation (utils/review.test.ts). These are the
 * things it cannot prove on its own — the parts that only exist once the
 * insight, transaction, forecast and goal gatherers, the store and the period
 * arithmetic are wired together:
 *
 *   • a real period of real transactions produces a real review;
 *   • the window IS the period, so "your July" is measured over July;
 *   • the totals are counted the way every other spend surface counts them;
 *   • earlier periods can be opened, and say less because they honestly know
 *     less — no forecast, no standing facts;
 *   • nothing a live alert is shouting is repeated;
 *   • a quiet period, and a period the history never loaded, are different
 *     answers and both are given;
 *   • opening an old review never touches the dismissals of the current one;
 *   • one user never sees another's money, goals or coverage.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Budget, Transaction, Goal, Loan, AlertState } from '../types';

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
import { reviewDS, alertsDS, alertStatesDS } from './dataService';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const TODAY = '2026-08-20';          // a Thursday, mid-month

/**
 * The latest complete month is July, and it is compared with the 31 days before
 * it (31 May – 30 June — trailing windows, not calendar months, so a period is
 * never compared with one of a different length).
 */
const JULY_DAY = '2026-07-10';
const JUNE_DAY = '2026-06-10';
const MAY_DAY = '2026-05-10';        // inside neither window
const LONG_AGO = '2026-01-05';       // sets coverage back, so comparisons run

const mockedSync = vi.mocked(syncWithRetry);

let seq = 0;
const tx = (o: Partial<Transaction> & { amount: number }): Transaction => {
  seq += 1;
  return {
    id: o.id ?? `t${seq}`, user_id: ME, account_id: 'acc-bank', account_type: 'bank',
    date: JULY_DAY, merchant: 'Merchant', currency: 'AUD', category: 'Groceries',
    is_duplicate_flagged: false, is_subscription: false, ...o,
  } as Transaction;
};

/** Coverage is read off the user's own history: without something old, nothing
 *  earlier than the data can be reviewed at all. */
const anchor = (userId = ME) =>
  tx({ id: `anchor-${userId}`, user_id: userId, amount: -10, date: LONG_AGO, merchant: 'Anchor' });

const goal = (o: Partial<Goal> = {}): Goal => ({
  id: 'g1', user_id: ME, name: 'House deposit', target_amount: 12_000,
  current_amount: 0, target_date: '2027-06-30', ...o,
} as Goal);

function seed(opts: {
  transactions?: Transaction[];
  budgets?: Budget[];
  goals?: Goal[];
  loans?: Loan[];
  alertStates?: AlertState[];
  accounts?: any[];
  userId?: string;
} = {}) {
  useStore.setState({
    user: { id: opts.userId ?? ME, email: 'me@example.com' } as any,
    transactions: opts.transactions ?? [],
    budgets: opts.budgets ?? [],
    goals: opts.goals ?? [],
    loans: opts.loans ?? [],
    alertStates: opts.alertStates ?? [],
    accounts: opts.accounts ?? [{ id: 'acc-bank', name: 'Everyday', balance: 20_000, type: 'bank' }],
    properties: [], recurringSeries: [], goalContributions: [], investments: [],
    superFunds: [], creditCards: [], subscriptions: [], incomeEntries: [], bills: [],
    loanEvents: [], transactionSplits: [], customCategories: [],
  } as any);
}

/** Spending doubled in July against the 31 days before it, across two
 *  categories — one category that IS the whole movement gets reported instead of
 *  the overall figure, and these tests are about the wiring, not that rule. */
const SPENT_MORE = [
  anchor(),
  tx({ id: 'j1', amount: -400, date: JUNE_DAY }),
  tx({ id: 'j2', amount: -300, date: JUNE_DAY, category: 'Dining' }),
  tx({ id: 'c1', amount: -1_400, date: JULY_DAY }),
  tx({ id: 'c2', amount: -900, date: '2026-07-20', category: 'Dining' }),
];

const build = (opts: Parameters<typeof reviewDS.build>[0] = {}) =>
  reviewDS.build({ asOf: TODAY, kind: 'month', ...opts });

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  A real period, reviewed
// ═════════════════════════════════════════════════════════════════════════════
describe('the latest review', () => {
  it('reviews the month that has finished, not the one being lived in', () => {
    const report = build();
    expect(report.period).toMatchObject({ kind: 'month', key: '2026-07', from: '2026-07-01', to: '2026-07-31' });
    expect(report.latest).toBe(true);
    // The comparison is the 31 days before it, so like is compared with like.
    expect(report.comparedWith).toEqual({ from: '2026-05-31', to: '2026-06-30', days: 31 });
  });

  it('reports what really moved, with the store as its only source', () => {
    seed({ transactions: SPENT_MORE });
    const report = build();

    const kinds = [...report.biggest, ...report.worsened, ...report.improved].map(i => i.kind);
    expect(kinds).toContain('spending-change');
    expect(report.quiet).toBe(false);
    expect(report.totals).toMatchObject({ spend: 2_300, previousSpend: 700, spendDelta: 1_600 });
  });

  it('counts the totals the way every other surface counts them', () => {
    seed({
      transactions: [
        anchor(),
        tx({ id: 'spend', amount: -250, date: JULY_DAY }),
        tx({ id: 'pay', amount: 4_000, date: JULY_DAY, category: 'Salary' }),
        // An internal movement is not spending, and not income.
        tx({ id: 'move-out', amount: -5_000, date: JULY_DAY, is_transfer: true, transfer_pair_id: 'pair' }),
        tx({ id: 'move-in', amount: 5_000, date: JULY_DAY, is_transfer: true, transfer_pair_id: 'pair' }),
      ],
    });
    const totals = build().totals!;
    expect(totals.spend).toBe(250);
    expect(totals.income).toBe(4_000);
    // Net movement is what actually landed: the transfer nets to nothing.
    expect(totals.net).toBe(-250 + 4_000);
  });

  it('measures a week over its own seven days', () => {
    seed({
      transactions: [
        anchor(),
        tx({ id: 'in-week', amount: -900, date: '2026-08-12' }),   // inside 10–16 Aug
        tx({ id: 'out-week', amount: -900, date: '2026-08-18' }),  // the week still running
      ],
    });
    const report = build({ kind: 'week' });
    expect(report.period).toMatchObject({ key: '2026-W33', from: '2026-08-10', to: '2026-08-16', days: 7 });
    expect(report.totals!.spend).toBe(900);
  });

  it('offers a period to page back to, bounded by what the history covers', () => {
    seed({ transactions: [anchor()] });
    const months = reviewDS.periods('month', { asOf: TODAY });
    expect(months[0].key).toBe('2026-07');
    // Coverage starts in January, so December is not offered as a review.
    expect(months.map(m => m.key)).not.toContain('2025-12');
    expect(months.every(m => m.to >= LONG_AGO)).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Earlier periods
// ═════════════════════════════════════════════════════════════════════════════
describe('reviewing an earlier period', () => {
  it('opens the period asked for, and measures it over itself', () => {
    seed({
      transactions: [
        anchor(),
        tx({ id: 'june', amount: -1_500, date: JUNE_DAY }),
        tx({ id: 'may', amount: -200, date: MAY_DAY }),
      ],
    });
    const report = build({ periodKey: '2026-06' });
    expect(report.period.key).toBe('2026-06');
    expect(report.latest).toBe(false);
    expect(report.totals).toMatchObject({ spend: 1_500 });
  });

  it('says less about a finished period, and says why', () => {
    seed({
      transactions: SPENT_MORE,
      loans: [{
        id: 'loan-1', user_id: ME, name: 'Mortgage', loan_type: 'mortgage',
        original_amount: 500_000, current_balance: 300_000, interest_rate: 6,
        minimum_repayment: 2_500, repayment_frequency: 'monthly', offset_balance: 80_000,
      } as Loan],
      goals: [goal()],
    });

    const latest = build();
    const past = build({ periodKey: '2026-06' });

    // An offset saving is a fact about today, so it belongs to today's review.
    expect(latest.biggest.concat(latest.improved).some(i => i.kind === 'offset-benefit')).toBe(true);
    expect([...past.biggest, ...past.improved, ...past.worsened].every(i => i.window !== null)).toBe(true);
    expect(past.risks).toEqual([]);
    expect(past.skipped.some(s => s.includes('Upcoming risks'))).toBe(true);
  });

  it('falls back to the latest review rather than reviewing a period still being lived', () => {
    expect(build({ periodKey: '2026-08' }).period.key).toBe('2026-07');   // this month
    expect(build({ periodKey: '2026-W33' }).period.key).toBe('2026-07');  // wrong kind
    expect(build({ periodKey: 'nonsense' }).period.key).toBe('2026-07');
  });

  it('never prunes today’s dismissals because an old review does not mention them', () => {
    const stored: AlertState = {
      id: 's1', user_id: ME, alert_key: 'insight:spending-change:2026-08', dismissed_stage: 2,
    } as AlertState;
    seed({ transactions: SPENT_MORE, alertStates: [stored] });

    build({ periodKey: '2026-06' });

    // Reviews are derived, never stored: opening one writes nothing at all.
    expect(alertStatesDS.getAll()).toHaveLength(1);
    expect(mockedSync).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Quiet periods and sparse data
// ═════════════════════════════════════════════════════════════════════════════
describe('when there is nothing to say', () => {
  it('calls a period with no material movement quiet, and still shows what it was', () => {
    seed({
      transactions: [
        anchor(),
        tx({ id: 'june', amount: -800, date: JUNE_DAY }),
        tx({ id: 'july', amount: -820, date: JULY_DAY }),
      ],
    });
    const report = build();
    expect(report.quiet).toBe(true);
    expect(report.biggest).toEqual([]);
    expect(report.totals).toMatchObject({ spend: 820, previousSpend: 800, spendDelta: 20 });
  });

  it('says a period is not loaded rather than calling it quiet', () => {
    // A bank connected this month: there is no July in the file at all.
    seed({ transactions: [tx({ id: 'recent', amount: -300, date: '2026-08-12' })] });
    const report = build();

    expect(report.covered).toBe(false);
    expect(report.quiet).toBe(false);
    expect(report.totals).toBeNull();
    expect(report.skipped[0]).toContain('history only reaches back to');
  });

  it('reviews an empty account without inventing anything', () => {
    const report = build();
    expect(report.quiet).toBe(true);
    expect(report.totals).toMatchObject({ spend: 0, income: 0, net: 0 });
    expect(report.risks).toEqual([]);
    expect(report.actions).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Upcoming risks, from the engines that own them
// ═════════════════════════════════════════════════════════════════════════════
describe('risks', () => {
  it('names a goal the forecast cannot fund, using the goals engine’s own verdict', () => {
    seed({ transactions: [anchor()], goals: [goal()] });
    const report = build();

    const risk = report.risks.find(r => r.entity === 'goal:g1');
    expect(risk).toBeTruthy();
    expect(risk!.facts).toMatchObject({ kind: 'goal-shortfall', name: 'House deposit' });
    // And it comes with somewhere to go and something to do.
    expect(report.actions.some(a => a.to === risk!.link.to)).toBe(true);
  });

  it('does not repeat a goal a live alert is already shouting about', () => {
    seed({ transactions: [anchor()], goals: [goal()] });
    const alerts = alertsDS.build({ asOf: TODAY });
    expect(alerts.visible.some(a => a.key.startsWith('goal-behind:'))).toBe(true);

    const report = build({ alerts });
    expect(report.risks.some(r => r.entity === 'goal:g1')).toBe(false);
    expect(report.suppressed.alerts).toBeGreaterThan(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Duplicate suppression against live alerts
// ═════════════════════════════════════════════════════════════════════════════
describe('not repeating an alert', () => {
  /** Groceries is over its cap THIS month (an alert) and also moved a lot last
   *  month (an insight). One subject, one voice. */
  const seedBoth = () => seed({
    transactions: [
      ...SPENT_MORE,
      tx({ id: 'aug1', amount: -900, date: '2026-08-05' }),
      tx({ id: 'aug2', amount: -400, date: '2026-08-12' }),
    ],
    budgets: [{
      id: 'b1', user_id: ME, scope: 'category', category: 'Groceries',
      limit_amount: 500, period: 'monthly', rollover_enabled: false, active: true,
    } as Budget],
  });

  it('leaves the alerted category out of the review, and says where it went', () => {
    seedBoth();
    const alerts = alertsDS.build({ asOf: TODAY });
    expect(alerts.visible.some(a => a.key.includes('groceries'))).toBe(true);

    const withAlerts = build({ alerts });
    const shown = [...withAlerts.biggest, ...withAlerts.improved, ...withAlerts.worsened];
    expect(shown.some(i => i.entity === 'category:groceries')).toBe(false);
    expect(withAlerts.suppressed.alerts).toBeGreaterThan(0);
  });

  it('shows it again once the alert is not being shouted', () => {
    seedBoth();
    const report = build();
    const shown = [...report.biggest, ...report.improved, ...report.worsened];
    expect(shown.length).toBeGreaterThan(0);
    expect(report.suppressed.alerts).toBe(0);
  });

  it('says each thing once inside the review itself', () => {
    seedBoth();
    const report = build();
    const keys = [...report.biggest, ...report.improved, ...report.worsened].map(i => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    const targets = report.actions.map(a => a.to);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  One user, one review
// ═════════════════════════════════════════════════════════════════════════════
describe('user isolation', () => {
  it('never counts another user’s money in the totals', () => {
    seed({
      transactions: [
        anchor(),
        tx({ id: 'mine', amount: -500, date: JULY_DAY }),
        tx({ id: 'theirs', amount: -9_000, date: JULY_DAY, user_id: OTHER }),
      ],
    });
    expect(build().totals!.spend).toBe(500);
  });

  it('never reads another user’s history as coverage', () => {
    // They have years of history; I connected a bank this month.
    seed({
      transactions: [
        anchor(OTHER),
        tx({ id: 'mine', amount: -300, date: '2026-08-12' }),
      ],
    });
    expect(build().covered).toBe(false);
  });

  it('never raises a risk about another user’s goal', () => {
    seed({
      transactions: [anchor()],
      goals: [goal({ id: 'theirs', user_id: OTHER })],
    });
    expect(build().risks.some(r => r.entity === 'goal:theirs')).toBe(false);
  });
});
