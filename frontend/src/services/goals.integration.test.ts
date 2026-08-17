/**
 * Phase 4.3 — savings goals, end to end through the store.
 *
 * The engine is unit-tested in isolation; these are the things it CANNOT prove
 * on its own — the parts that only exist once goals, contributions, balances,
 * the sync queue and the forecast are wired to the real data service:
 *
 *   • a contribution reaches the store and the report reflects it;
 *   • deleting a goal takes its whole ledger with it, locally and on the wire;
 *   • the report reads live account/investment/super balances;
 *   • the forecast actually feeds the on-track decision;
 *   • one user never sees or is costed against another's goals.
 *
 * Sync is mocked, so every assertion about "cross-device" is really "the right
 * op, with the right payload, was queued" — which is exactly what a second
 * device replays on bootstrap.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Goal, GoalContribution, Transaction } from '../types';

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
import { goalsDS, goalContributionsDS, goalReportDS } from './dataService';

const ME = 'user-ME';
const OTHER = 'user-OTHER';
const TODAY = '2026-08-17';
const mockedSync = vi.mocked(syncWithRetry);

const goal = (o: Partial<Goal>): Goal => ({
  id: 'g1', user_id: ME, name: 'House deposit', target_amount: 10_000,
  current_amount: 0, target_date: '2027-08-17', ...o,
} as Goal);

const contribution = (o: Partial<GoalContribution> & { amount: number }): GoalContribution => ({
  id: `c-${o.id ?? o.amount}`, user_id: ME, goal_id: 'g1', date: '2026-08-01', ...o,
} as GoalContribution);

function seed(opts: {
  goals?: Goal[]; contributions?: GoalContribution[];
  accounts?: any[]; investments?: any[]; superFunds?: any[]; transactions?: Transaction[];
} = {}) {
  useStore.setState({
    user: { id: ME, email: 'me@example.com' } as any,
    goals: opts.goals ?? [],
    goalContributions: opts.contributions ?? [],
    accounts: opts.accounts ?? [],
    investments: opts.investments ?? [],
    superFunds: opts.superFunds ?? [],
    transactions: opts.transactions ?? [],
    // Everything the forecast gatherer reads — empty unless a test needs it.
    creditCards: [], subscriptions: [], incomeEntries: [], bills: [],
    loans: [], recurringSeries: [], transactionSplits: [],
  } as any);
}

/** The report without the forecast — for the pure progress assertions. */
const progress = () => goalReportDS.build({ asOf: TODAY, capacity: false });
const kinds = () => mockedSync.mock.calls.map(c => c[0] as string);
const payloadOf = (kind: string) => mockedSync.mock.calls.find(c => c[0] === kind)?.[1] as any;

beforeEach(() => {
  localStorage.clear();
  mockedSync.mockClear();
  seed();
});

// ═════════════════════════════════════════════════════════════════════════════
//  Recording money
// ═════════════════════════════════════════════════════════════════════════════
describe('recording a contribution', () => {
  beforeEach(() => seed({ goals: [goal({ current_amount: 0 })] }));

  it('lands in the store and moves the report', () => {
    goalContributionsDS.add({ goal_id: 'g1', amount: 500, date: '2026-08-10', source_type: null, source_id: null });

    expect(useStore.getState().goalContributions).toHaveLength(1);
    expect(progress().lines[0].saved).toBe(500);
    expect(kinds()).toContain('goalContribution.create');
  });

  it('queues a create payload a second device can replay', () => {
    goalContributionsDS.add({ goal_id: 'g1', amount: 250, date: '2026-08-10', source_type: 'account', source_id: 'a1' });
    const pl = payloadOf('goalContribution.create');
    expect(pl.data).toMatchObject({ goal_id: 'g1', amount: 250, source_type: 'account', source_id: 'a1' });
    expect(pl.recordId).toBeTruthy();
  });

  it('records a withdrawal as a negative amount', () => {
    goalContributionsDS.add({ goal_id: 'g1', amount: 1_000, date: '2026-08-01', source_type: null, source_id: null });
    goalContributionsDS.add({ goal_id: 'g1', amount: -300, date: '2026-08-12', source_type: null, source_id: null });

    const line = progress().lines[0];
    expect(line.saved).toBe(700);
    expect(line.depositedTotal).toBe(1_000);
    expect(line.withdrawnTotal).toBe(300);
  });

  it('returns one goal ledger newest-first, not another goal\'s', () => {
    seed({ goals: [goal({ id: 'g1' }), goal({ id: 'g2' })] });
    goalContributionsDS.add({ goal_id: 'g1', amount: 100, date: '2026-08-01', source_type: null, source_id: null });
    goalContributionsDS.add({ goal_id: 'g1', amount: 200, date: '2026-08-15', source_type: null, source_id: null });
    goalContributionsDS.add({ goal_id: 'g2', amount: 999, date: '2026-08-10', source_type: null, source_id: null });

    const ledger = goalContributionsDS.forGoal('g1');
    expect(ledger).toHaveLength(2);
    expect(ledger[0].date).toBe('2026-08-15');   // newest first
    expect(ledger.every(c => c.goal_id === 'g1')).toBe(true);
  });

  it('edits a contribution in place, not as a new row', () => {
    const c = goalContributionsDS.add({ goal_id: 'g1', amount: 500, date: '2026-08-10', source_type: null, source_id: null });
    goalContributionsDS.update(c.id, { amount: 650 });

    expect(useStore.getState().goalContributions).toHaveLength(1);
    expect(progress().lines[0].saved).toBe(650);
    expect(kinds()).toContain('goalContribution.update');
  });

  it('removing a contribution takes it back off the total', () => {
    const c = goalContributionsDS.add({ goal_id: 'g1', amount: 500, date: '2026-08-10', source_type: null, source_id: null });
    goalContributionsDS.remove(c.id);
    expect(progress().lines[0].saved).toBe(0);
    expect(kinds()).toContain('goalContribution.delete');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Not counting the same money twice — through the real balance reads
// ═════════════════════════════════════════════════════════════════════════════
describe('a goal linked to a real account', () => {
  it('derives its balance from the live account and ignores a deposit already in it', () => {
    seed({
      goals: [goal({
        current_amount: 3_000,   // stale snapshot — must be ignored
        linked_sources: [{ type: 'account', id: 'a1', link_type: 'percent', link_value: 100 }],
      })],
      accounts: [{ id: 'a1', name: 'Savings', balance: 4_200, display_balance: 4_200 }],
      contributions: [contribution({ amount: 500, source_type: 'account', source_id: 'a1' })],
    });

    const line = progress().lines[0];
    expect(line.linkedSaved).toBe(4_200);
    expect(line.saved).toBe(4_200);           // NOT 4,200 + 500
    expect(line.reflectedTotal).toBe(500);    // recorded, not re-added
    expect(line.contributionCount).toBe(1);
  });

  it('reads investment and super values too', () => {
    seed({
      goals: [goal({ linked_sources: [
        { type: 'investment', id: 'i1', link_type: 'percent', link_value: 50 },
        { type: 'super', id: 's1', link_type: 'amount', link_value: 2_000 },
      ] })],
      // investmentsDS.getAll() recomputes display_value from shares × price × rate,
      // so the fixture must give it those rather than a bare display_value.
      investments: [{ id: 'i1', name: 'ETF', shares_owned: 80, current_price: 100, conversion_rate: 1 }],
      superFunds: [{ id: 's1', fund_name: 'Fund', balance: 90_000 }],
    });
    expect(progress().lines[0].saved).toBe(4_000 + 2_000);
  });

  it('counts a deposit into an account the goal is NOT linked to', () => {
    seed({
      goals: [goal({ linked_sources: [{ type: 'account', id: 'a1', link_type: 'percent', link_value: 100 }] })],
      accounts: [
        { id: 'a1', name: 'Savings', balance: 3_000, display_balance: 3_000 },
        { id: 'a2', name: 'Elsewhere', balance: 500, display_balance: 500 },
      ],
      contributions: [contribution({ amount: 500, source_type: 'account', source_id: 'a2' })],
    });
    expect(progress().lines[0].saved).toBe(3_500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Deleting a goal
// ═════════════════════════════════════════════════════════════════════════════
describe('deleting a goal', () => {
  it('removes the goal and its whole ledger from the store', () => {
    seed({
      goals: [goal({ id: 'g1' }), goal({ id: 'g2' })],
      contributions: [
        contribution({ id: 'a', goal_id: 'g1', amount: 100 }),
        contribution({ id: 'b', goal_id: 'g1', amount: 200 }),
        contribution({ id: 'c', goal_id: 'g2', amount: 300 }),
      ],
    });

    goalsDS.remove('g1');

    const s = useStore.getState();
    expect(s.goals.map(g => g.id)).toEqual(['g2']);
    // g2's contribution survives; g1's are gone.
    expect(s.goalContributions.map(c => c.goal_id)).toEqual(['g2']);
  });

  it('queues a delete for the goal AND for each of its contributions', () => {
    seed({
      goals: [goal({ id: 'g1' })],
      contributions: [contribution({ id: 'a', amount: 100 }), contribution({ id: 'b', amount: 200 })],
    });

    goalsDS.remove('g1');

    const deletes = mockedSync.mock.calls.filter(c => c[0] === 'goalContribution.delete');
    expect(deletes).toHaveLength(2);
    expect(kinds()).toContain('goal.delete');
  });

  it('does nothing to the queue when the goal had no contributions', () => {
    seed({ goals: [goal({ id: 'g1' })] });
    goalsDS.remove('g1');
    expect(kinds().filter(k => k === 'goalContribution.delete')).toHaveLength(0);
    expect(kinds()).toContain('goal.delete');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The forecast really drives "on track"
// ═════════════════════════════════════════════════════════════════════════════
describe('on-track uses the live forecast', () => {
  it('is on track when income comfortably outweighs outgoings', () => {
    seed({
      goals: [goal({ target_amount: 1_200, target_date: '2027-08-17', current_amount: 0 })],
      accounts: [{ id: 'a1', name: 'Everyday', balance: 5_000, display_balance: 5_000 }],
    });
    // $4,000/mo in, nothing out → plenty of headroom for a $100/mo goal.
    useStore.setState({
      incomeEntries: [{
        id: 'inc1', user_id: ME, source: 'Salary', amount: 4_000, display_amount: 4_000,
        frequency: 'monthly', is_recurring: true, status: 'approved', date: '2026-08-01', category: 'Salary',
      }] as any,
    });

    const line = goalReportDS.build({ asOf: TODAY }).lines[0];
    expect(line.capacityKnown).toBe(true);
    expect(line.status).toBe('on-track');
  });

  it('is behind when the forecast shows money going backwards', () => {
    seed({
      goals: [goal({ target_amount: 5_000, target_date: '2027-08-17', current_amount: 0 })],
      accounts: [{ id: 'a1', name: 'Everyday', balance: 5_000, display_balance: 5_000 }],
    });
    // A big recurring bill, no income → negative net, nothing spare for a goal.
    useStore.setState({
      bills: [{
        id: 'b1', user_id: ME, name: 'Rent', amount: 3_000, due_date: '2026-09-01',
        is_recurring: true, frequency: 'monthly', is_paid: false, category: 'Rent', kind: 'bill',
      }] as any,
    });

    const line = goalReportDS.build({ asOf: TODAY }).lines[0];
    expect(line.capacityKnown).toBe(true);
    expect(line.status).toBe('behind');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  User isolation
// ═════════════════════════════════════════════════════════════════════════════
describe('one user never sees or is costed against another', () => {
  it('excludes another user\'s goals and contributions from the report', () => {
    seed({
      goals: [
        goal({ id: 'mine', user_id: ME, current_amount: 100 }),
        goal({ id: 'theirs', user_id: OTHER, current_amount: 9_999 }),
      ],
      contributions: [
        contribution({ id: 'a', goal_id: 'mine', user_id: ME, amount: 50 }),
        contribution({ id: 'b', goal_id: 'theirs', user_id: OTHER, amount: 5_000 }),
      ],
    });

    const r = progress();
    expect(r.lines.map(l => l.id)).toEqual(['mine']);
    expect(r.lines[0].saved).toBe(150);       // 100 opening + own 50, none of theirs
    expect(goalContributionsDS.getAll().map(c => c.id)).toEqual(['a']);
  });

  it('does not let another user\'s goal be funded by my forecast capacity', () => {
    // Only my goal exists in the report; the other user's is filtered before the
    // engine ever sees it, so it cannot claim a share of my spare cash.
    seed({
      goals: [
        goal({ id: 'mine', user_id: ME, target_amount: 1_200, target_date: '2027-08-17' }),
        goal({ id: 'theirs', user_id: OTHER, target_amount: 1_200, target_date: '2026-09-01' }),
      ],
      accounts: [{ id: 'a1', name: 'Everyday', balance: 5_000, display_balance: 5_000 }],
    });
    useStore.setState({
      incomeEntries: [{
        id: 'inc1', user_id: ME, source: 'Salary', amount: 4_000, display_amount: 4_000,
        frequency: 'monthly', is_recurring: true, status: 'approved', date: '2026-08-01', category: 'Salary',
      }] as any,
    });

    const r = goalReportDS.build({ asOf: TODAY });
    expect(r.lines.map(l => l.id)).toEqual(['mine']);
    expect(r.lines[0].status).toBe('on-track');
  });
});
