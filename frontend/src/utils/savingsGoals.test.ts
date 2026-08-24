/**
 * Phase 4.3 — the savings-goal engine.
 *
 * The tests that matter here are the ones about MONEY BEING COUNTED ONCE. A
 * goal funded by a linked account and a hand-recorded deposit is the case where
 * an obvious implementation quietly doubles the user's savings and tells them
 * they can stop saving.
 */

import { describe, it, expect } from 'vitest';
import type { Goal, GoalContribution } from '../types';
import {
  buildGoalReport, goalLinks, isLinkedGoal, isReflected, linkValue,
  toContributionInput, toGoalInput, daysBetween,
  type ContributionInput, type GoalInput, type GoalLink, type SourceValue,
} from './savingsGoals';

const TODAY = '2026-08-17';

const goal = (o: Partial<GoalInput> = {}): GoalInput => ({
  id: 'g1', name: 'House deposit', targetAmount: 10_000,
  targetDate: '2027-08-17', openingAmount: 0, links: [], ...o,
});

const contribution = (o: Partial<ContributionInput> & { amount: number }): ContributionInput => ({
  id: `c${o.amount}`, goalId: 'g1', date: '2026-08-01', source: null, ...o,
});

const acct = (id: string, value: number): SourceValue => ({ type: 'account', id, value });

const report = (o: Partial<Parameters<typeof buildGoalReport>[0]> = {}) => buildGoalReport({
  asOf: TODAY, goals: o.goals ?? [goal()], contributions: o.contributions ?? [],
  balances: o.balances ?? [], capacity: o.capacity, commitments: o.commitments,
});

/** One goal's line, by id. */
const line = (r: ReturnType<typeof buildGoalReport>, id = 'g1') => r.lines.find(l => l.id === id)!;

/** A capacity of exactly $N a month, expressed the way the forecast reports it. */
const perMonth = (n: number) => ({ surplus: n * (90 / 30.4375), days: 90 });

// ═════════════════════════════════════════════════════════════════════════════
//  Progress
// ═════════════════════════════════════════════════════════════════════════════
describe('what a goal is worth', () => {
  it('reports a manual goal from its opening amount', () => {
    const l = line(report({ goals: [goal({ openingAmount: 2_500 })] }));
    expect(l.saved).toBe(2_500);
    expect(l.remaining).toBe(7_500);
    expect(l.progressPct).toBe(25);
  });

  it('derives a linked goal from the live balance, not from the stored figure', () => {
    // The stored current_amount is a snapshot written at save time. Trusting it
    // would freeze the goal at whatever the balance was that day.
    const l = line(report({
      goals: [goal({
        openingAmount: 999,                       // stale; must be ignored
        links: [{ type: 'account', id: 'a1', link_type: 'percent', link_value: 50 }],
      })],
      balances: [acct('a1', 6_000)],
    }));
    expect(l.linkedSaved).toBe(3_000);
    expect(l.manualSaved).toBe(0);
    expect(l.saved).toBe(3_000);
  });

  it('caps a fixed-dollar link at what the account actually holds', () => {
    expect(linkValue({ type: 'account', id: 'a', link_type: 'amount', link_value: 5_000 }, 1_200))
      .toBe(1_200);
  });

  it('treats an overdrawn account as holding nothing, not as a debt to the goal', () => {
    expect(linkValue({ type: 'account', id: 'a', link_type: 'percent', link_value: 50 }, -800))
      .toBe(0);
  });

  it('adds up several sources of different kinds', () => {
    const l = line(report({
      goals: [goal({ links: [
        { type: 'account', id: 'a1', link_type: 'amount', link_value: 4_000 },
        { type: 'investment', id: 'i1', link_type: 'percent', link_value: 25 },
        { type: 'super', id: 's1', link_type: 'percent', link_value: 10 },
      ] })],
      balances: [
        acct('a1', 9_000),
        { type: 'investment', id: 'i1', value: 8_000 },
        { type: 'super', id: 's1', value: 50_000 },
      ],
    }));
    expect(l.saved).toBe(4_000 + 2_000 + 5_000);
  });

  it('clamps the bar at 100% but keeps the real saved figure', () => {
    const l = line(report({ goals: [goal({ openingAmount: 12_000 })] }));
    expect(l.progressPct).toBe(100);
    expect(l.saved).toBe(12_000);
    expect(l.remaining).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Counting each dollar once — the whole point of the source field
// ═════════════════════════════════════════════════════════════════════════════
describe('manual contributions alongside linked accounts', () => {
  const linked = (): GoalLink[] => [{ type: 'account', id: 'savings', link_type: 'percent', link_value: 100 }];

  it('does NOT add a deposit that is already sitting in the linked balance', () => {
    // $500 moved into the linked savings account: the balance went up by $500,
    // so adding the ledger row too would tell the user they saved $1,000.
    const l = line(report({
      goals: [goal({ links: linked() })],
      balances: [acct('savings', 3_500)],
      contributions: [contribution({ amount: 500, source: { type: 'account', id: 'savings' } })],
    }));
    expect(l.saved).toBe(3_500);
    expect(l.reflectedTotal).toBe(500);
    // Still recorded — it belongs in the history even though it isn't re-added.
    expect(l.contributionCount).toBe(1);
    expect(l.depositedTotal).toBe(500);
  });

  it('DOES add cash the app cannot see', () => {
    const l = line(report({
      goals: [goal({ links: linked() })],
      balances: [acct('savings', 3_000)],
      contributions: [contribution({ amount: 500, source: null })],
    }));
    expect(l.saved).toBe(3_500);
    expect(l.manualSaved).toBe(500);
  });

  it('DOES add a deposit into an account this goal is not linked to', () => {
    const l = line(report({
      goals: [goal({ links: linked() })],
      balances: [acct('savings', 3_000), acct('offset', 20_000)],
      contributions: [contribution({ amount: 500, source: { type: 'account', id: 'offset' } })],
    }));
    expect(l.saved).toBe(3_500);
  });

  it('keeps an account and an investment with the same id apart', () => {
    const links: GoalLink[] = [{ type: 'account', id: 'x', link_type: 'percent', link_value: 100 }];
    expect(isReflected(contribution({ amount: 1, source: { type: 'account', id: 'x' } }), links)).toBe(true);
    expect(isReflected(contribution({ amount: 1, source: { type: 'investment', id: 'x' } }), links)).toBe(false);
  });

  it('re-judges old contributions when the goal is linked LATER', () => {
    // Recorded while the goal was manual, then the account was linked. The rule
    // is evaluated against the links as they are NOW, so the same rows stop
    // being counted the moment their money became visible another way.
    const contributions = [contribution({ amount: 500, source: { type: 'account', id: 'savings' } })];

    const manual = line(report({
      goals: [goal({ openingAmount: 0 })],
      balances: [acct('savings', 3_000)],
      contributions,
    }));
    expect(manual.saved).toBe(500);

    const nowLinked = line(report({
      goals: [goal({ links: linked() })],
      balances: [acct('savings', 3_000)],
      contributions,
    }));
    expect(nowLinked.saved).toBe(3_000);
  });

  it('starts counting them again when the account is UNLINKED', () => {
    const contributions = [contribution({ amount: 500, source: { type: 'account', id: 'savings' } })];
    const l = line(report({
      goals: [goal({ links: [{ type: 'account', id: 'other', link_type: 'percent', link_value: 100 }] })],
      balances: [acct('savings', 3_000), acct('other', 1_000)],
      contributions,
    }));
    expect(l.saved).toBe(1_500);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Withdrawals
// ═════════════════════════════════════════════════════════════════════════════
describe('taking money back out', () => {
  it('subtracts a withdrawal from a manual goal', () => {
    const l = line(report({
      goals: [goal({ openingAmount: 1_000 })],
      contributions: [contribution({ amount: 400 }), contribution({ id: 'c2', amount: -250 })],
    }));
    expect(l.saved).toBe(1_150);
    expect(l.depositedTotal).toBe(400);
    expect(l.withdrawnTotal).toBe(250);
  });

  it('does not subtract a withdrawal from a LINKED account twice', () => {
    // The balance already fell by $500. Subtracting the ledger row as well
    // would double the loss.
    const l = line(report({
      goals: [goal({ links: [{ type: 'account', id: 'savings', link_type: 'percent', link_value: 100 }] })],
      balances: [acct('savings', 2_500)],
      contributions: [contribution({ amount: -500, source: { type: 'account', id: 'savings' } })],
    }));
    expect(l.saved).toBe(2_500);
    expect(l.withdrawnTotal).toBe(500);
  });

  it('reports an overdrawn goal honestly rather than clamping it to zero', () => {
    const l = line(report({
      goals: [goal({ openingAmount: 100 })],
      contributions: [contribution({ amount: -400 })],
    }));
    expect(l.saved).toBe(-300);
    expect(l.progressPct).toBe(0);       // a negative bar would be nonsense
    expect(l.remaining).toBe(10_300);    // and it really does need that much
  });

  it('drops a goal back out of "complete" when the money is withdrawn', () => {
    const done = line(report({ goals: [goal({ openingAmount: 10_000 })] }));
    expect(done.status).toBe('complete');

    const raided = line(report({
      goals: [goal({ openingAmount: 10_000 })],
      contributions: [contribution({ amount: -1 })],
      capacity: perMonth(1_000),
    }));
    expect(raided.status).not.toBe('complete');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Required contributions and deadlines
// ═════════════════════════════════════════════════════════════════════════════
describe('what has to go in, and by when', () => {
  it('spreads the remainder over the time left', () => {
    // $1,200 over 365 days: ~$100/month, ~$23/week.
    const l = line(report({
      goals: [goal({ targetAmount: 1_200, targetDate: '2027-08-17' })],
      capacity: perMonth(500),
    }));
    expect(l.daysRemaining).toBe(365);
    expect(l.requiredPerMonth).toBeCloseTo(100, 0);
    expect(l.requiredPerWeek).toBeCloseTo(23.01, 1);
  });

  it('asks for nothing once the target is reached', () => {
    const l = line(report({ goals: [goal({ openingAmount: 10_000 })] }));
    expect(l.status).toBe('complete');
    expect(l.requiredPerMonth).toBeNull();
    expect(l.requiredPerWeek).toBeNull();
  });

  it('marks a passed deadline overdue and stops quoting a monthly rate', () => {
    // "$X a month" is meaningless for a date that has gone; what is needed is
    // the whole remainder, now.
    const l = line(report({
      goals: [goal({ targetDate: '2026-06-01', openingAmount: 4_000 })],
      capacity: perMonth(5_000),
    }));
    expect(l.status).toBe('overdue');
    expect(l.daysRemaining).toBe(-77);
    expect(l.requiredPerMonth).toBeNull();
    expect(l.remaining).toBe(6_000);
    expect(l.allocatedPerMonth).toBe(0);
  });

  it('does not call a goal overdue if it was met before the date passed', () => {
    const l = line(report({ goals: [goal({ targetDate: '2026-06-01', openingAmount: 10_000 })] }));
    expect(l.status).toBe('complete');
  });

  it('treats a goal due today as overdue, not as needing an infinite rate', () => {
    // daysRemaining 0 would divide by zero and report an absurd weekly figure.
    const l = line(report({ goals: [goal({ targetDate: TODAY })], capacity: perMonth(100) }));
    expect(l.status).toBe('overdue');
    expect(l.requiredPerWeek).toBeNull();
  });

  it('has no pace to judge without a deadline', () => {
    const l = line(report({ goals: [goal({ targetDate: null })], capacity: perMonth(500) }));
    expect(l.status).toBe('no-deadline');
    expect(l.requiredPerMonth).toBeNull();
  });

  it('still projects a finish date for an open-ended goal', () => {
    // Nothing is required by a date, but "at this rate, about then" is useful.
    const l = line(report({
      goals: [goal({ targetDate: null, targetAmount: 1_000 })],
      capacity: perMonth(500),
    }));
    expect(l.allocatedPerMonth).toBe(500);
    expect(l.projectedDate).toBe('2026-10-17');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  On track — the forecast
// ═════════════════════════════════════════════════════════════════════════════
describe('whether the money exists', () => {
  const inAYear = (target: number) => goal({ targetAmount: target, targetDate: '2027-08-17' });

  it('is on track when the forecast covers what the deadline needs', () => {
    const l = line(report({ goals: [inAYear(1_200)], capacity: perMonth(500) }));
    expect(l.status).toBe('on-track');
    expect(l.allocatedPerMonth).toBeCloseTo(100, 0);
    expect(l.shortfallPerMonth).toBe(0);
  });

  it('is behind when the forecast has nothing spare', () => {
    const l = line(report({ goals: [inAYear(1_200)], capacity: { surplus: -900, days: 90 } }));
    expect(l.status).toBe('behind');
    expect(l.allocatedPerMonth).toBe(0);
    expect(l.shortfallPerMonth).toBeCloseTo(100, 0);
  });

  it('is at risk when the forecast covers only part of it', () => {
    const l = line(report({ goals: [inAYear(1_200)], capacity: perMonth(40) }));
    expect(l.status).toBe('at-risk');
    expect(l.allocatedPerMonth).toBe(40);
    expect(l.shortfallPerMonth).toBeCloseTo(60, 0);
  });

  it('says it does not know rather than guessing, when there is no forecast', () => {
    const l = line(report({ goals: [inAYear(1_200)] }));
    expect(l.status).toBe('unknown');
    expect(l.capacityKnown).toBe(false);
    expect(l.requiredPerMonth).toBeCloseTo(100, 0);   // still says what it needs
    expect(l.shortfallPerMonth).toBe(0);              // but claims no shortfall
  });

  it('projects a completion date from the allocated rate', () => {
    const l = line(report({
      goals: [goal({ targetAmount: 1_000, targetDate: '2027-08-17' })],
      capacity: perMonth(1_000),
    }));
    // Needs ~$83/mo, gets it, so ~12 months out — lands on its own deadline
    // (a day's rounding slack from the ceil on the day count).
    expect(l.projectedDate).toBe('2027-08-18');
  });

  it('never projects a date for a goal nothing is reaching', () => {
    const l = line(report({ goals: [inAYear(1_200)], capacity: { surplus: 0, days: 90 } }));
    expect(l.projectedDate).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Several goals at once — they compete
// ═════════════════════════════════════════════════════════════════════════════
describe('more than one goal', () => {
  const soon = goal({ id: 'soon', name: 'Car', targetAmount: 1_200, targetDate: '2027-08-17' });
  const later = goal({ id: 'later', name: 'House', targetAmount: 12_000, targetDate: '2029-08-17' });

  it('funds the nearest deadline first', () => {
    // $150/mo of capacity; Car needs ~$100, House ~$333. Car is funded whole
    // and House gets the rest — the reverse order would report both as fine
    // until the Car deadline arrived.
    const r = report({ goals: [later, soon], capacity: perMonth(150) });
    expect(line(r, 'soon').status).toBe('on-track');
    expect(line(r, 'soon').allocatedPerMonth).toBeCloseTo(100, 0);
    expect(line(r, 'later').status).toBe('at-risk');
    expect(line(r, 'later').allocatedPerMonth).toBeCloseTo(50, 0);
  });

  it('knocks an already-funded goal off track when a nearer one is added', () => {
    // The honest consequence of a shared wallet, and the thing a per-goal
    // calculation hides.
    const alone = report({ goals: [later], capacity: perMonth(350) });
    expect(line(alone, 'later').status).toBe('on-track');

    const competing = report({ goals: [later, soon], capacity: perMonth(350) });
    expect(line(competing, 'later').status).toBe('at-risk');
  });

  it('totals the requirement against the capacity', () => {
    const r = report({ goals: [soon, later], capacity: perMonth(150) });
    expect(r.totalRequiredPerMonth).toBeCloseTo(433.3, 0);
    expect(r.monthlyCapacity).toBeCloseTo(150, 0);
    expect(r.shortfallPerMonth).toBeCloseTo(283.3, 0);
    expect(r.unallocatedPerMonth).toBe(0);
  });

  it('reports what is left over when every goal is covered', () => {
    const r = report({ goals: [soon], capacity: perMonth(500) });
    expect(r.unallocatedPerMonth).toBeCloseTo(400, 0);
    expect(r.shortfallPerMonth).toBe(0);
  });

  // A forecast that expects to LOSE money frees up nothing. It does not owe the
  // goals the size of the loss on top of what they need — measuring against the
  // raw negative figure inflated the gap, and invented one where a completed
  // goal required nothing at all.
  it('treats a negative forecast as no spare cash, not as negative spare cash', () => {
    const r = report({ goals: [soon], capacity: perMonth(-300) });
    expect(r.monthlyCapacity).toBeCloseTo(-300, 0);
    // The gap is what the goal needs — NOT need + 300.
    expect(r.shortfallPerMonth).toBeCloseTo(r.totalRequiredPerMonth, 1);
    expect(r.unallocatedPerMonth).toBe(0);
  });

  it('claims no shortfall when nothing is required, however bad the forecast', () => {
    // A goal already reached requires nothing; a losing forecast must not
    // conjure a monthly gap out of it.
    const done = goal({ id: 'soon', targetAmount: 1_000, openingAmount: 1_000 });
    const r = report({ goals: [done], capacity: perMonth(-326.7) });
    expect(r.totalRequiredPerMonth).toBe(0);
    expect(r.shortfallPerMonth).toBe(0);
  });

  it('lets a completed goal free up the cash it was claiming', () => {
    const done = goal({ id: 'soon', name: 'Car', targetAmount: 1_200, targetDate: '2027-08-17', openingAmount: 1_200 });
    const r = report({ goals: [done, later], capacity: perMonth(150) });
    expect(line(r, 'soon').status).toBe('complete');
    expect(line(r, 'later').allocatedPerMonth).toBeCloseTo(150, 0);
  });

  it('gives dated goals first claim, then splits the rest between open-ended ones', () => {
    const openA = goal({ id: 'oa', targetDate: null, targetAmount: 5_000 });
    const openB = goal({ id: 'ob', targetDate: null, targetAmount: 5_000 });
    const r = report({ goals: [openA, openB, soon], capacity: perMonth(300) });
    expect(line(r, 'soon').allocatedPerMonth).toBeCloseTo(100, 0);
    expect(line(r, 'oa').allocatedPerMonth).toBeCloseTo(100, 0);
    expect(line(r, 'ob').allocatedPerMonth).toBeCloseTo(100, 0);
  });

  it('keeps each goal ledger to itself', () => {
    const r = report({
      goals: [goal({ id: 'g1', openingAmount: 0 }), goal({ id: 'g2', openingAmount: 0 })],
      contributions: [
        contribution({ id: 'c1', goalId: 'g1', amount: 100 }),
        contribution({ id: 'c2', goalId: 'g2', amount: 700 }),
      ],
    });
    expect(line(r, 'g1').saved).toBe(100);
    expect(line(r, 'g2').saved).toBe(700);
  });

  it('summarises the whole set', () => {
    const r = report({
      goals: [goal({ id: 'g1', targetAmount: 1_000, openingAmount: 1_000 }), goal({ id: 'g2', targetAmount: 3_000, openingAmount: 500 })],
      capacity: perMonth(100),
    });
    expect(r.totalTarget).toBe(4_000);
    expect(r.totalSaved).toBe(1_500);
    expect(r.completeCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Links that stop existing
// ═════════════════════════════════════════════════════════════════════════════
describe('when a linked asset goes away', () => {
  it('reports the broken link instead of silently valuing it at zero', () => {
    const l = line(report({
      goals: [goal({ links: [
        { type: 'account', id: 'gone', link_type: 'percent', link_value: 100 },
        { type: 'account', id: 'here', link_type: 'percent', link_value: 100 },
      ] })],
      balances: [acct('here', 2_000)],
    }));
    expect(l.saved).toBe(2_000);
    expect(l.brokenLinks).toEqual([{ type: 'account', id: 'gone' }]);
  });

  it('separates a deleted account from an emptied one', () => {
    // An account at $0 is a fact about the money. A deleted account is a fact
    // about the goal's configuration, and only one of them needs fixing.
    const l = line(report({
      goals: [goal({ links: [{ type: 'account', id: 'a1', link_type: 'percent', link_value: 100 }] })],
      balances: [acct('a1', 0)],
    }));
    expect(l.saved).toBe(0);
    expect(l.brokenLinks).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Reading what is actually stored
// ═════════════════════════════════════════════════════════════════════════════
describe('the stored shapes', () => {
  const stored = (o: Partial<Goal>): Goal => ({
    id: 'g1', name: 'Trip', target_amount: 5_000, current_amount: 0, ...o,
  } as Goal);

  it('reads the modern multi-source array', () => {
    const g = stored({ linked_sources: [{ type: 'investment', id: 'i1', link_type: 'percent', link_value: 30 }] });
    expect(goalLinks(g)).toEqual([{ type: 'investment', id: 'i1', link_type: 'percent', link_value: 30 }]);
    expect(isLinkedGoal(g)).toBe(true);
  });

  it('still funds a goal saved before multi-source links existed', () => {
    const g = stored({ linked_account_id: 'a9', link_type: 'amount', link_value: 750 });
    expect(goalLinks(g)).toEqual([{ type: 'account', id: 'a9', link_type: 'amount', link_value: 750 }]);
  });

  it('prefers the newer array when a goal carries both', () => {
    const g = stored({
      linked_sources: [{ type: 'account', id: 'new', link_type: 'percent', link_value: 100 }],
      linked_account_id: 'old', link_type: 'amount', link_value: 10,
    });
    expect(goalLinks(g).map(l => l.id)).toEqual(['new']);
  });

  it('is unlinked when the legacy trio is incomplete', () => {
    expect(goalLinks(stored({ linked_account_id: 'a9' }))).toEqual([]);
  });

  it('survives numbers arriving from Postgres as strings', () => {
    // DECIMAL columns come back as strings through PostgREST; '5000' + 100
    // would concatenate rather than add.
    const g = stored({ target_amount: '5000' as unknown as number, current_amount: '250' as unknown as number });
    const input = toGoalInput(g);
    expect(input.targetAmount).toBe(5_000);
    expect(input.openingAmount).toBe(250);
  });

  it('reads a contribution, trimming a timestamp back to a date', () => {
    const c = {
      id: 'c1', goal_id: 'g1', amount: '125.50', date: '2026-08-01T00:00:00Z',
      source_type: 'account', source_id: 'a1',
    } as unknown as GoalContribution;
    expect(toContributionInput(c)).toEqual({
      id: 'c1', goalId: 'g1', amount: 125.5, date: '2026-08-01',
      source: { type: 'account', id: 'a1' },
    });
  });

  it('treats a half-recorded source as untracked cash', () => {
    // A type with no id cannot be matched against a link, so counting it is the
    // only safe reading — the alternative silently drops the money.
    const c = { id: 'c1', goal_id: 'g1', amount: 10, date: '2026-08-01', source_type: 'account' } as GoalContribution;
    expect(toContributionInput(c).source).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts forward and backward', () => {
    expect(daysBetween('2026-08-17', '2026-08-24')).toBe(7);
    expect(daysBetween('2026-08-17', '2026-08-10')).toBe(-7);
  });

  it('refuses to guess at an unparseable date', () => {
    expect(daysBetween('2026-08-17', 'someday')).toBeNull();
  });

  it('is unaffected by daylight saving', () => {
    // Australia switches on 2026-10-04. A local-time implementation returns 6.
    expect(daysBetween('2026-10-01', '2026-10-08')).toBe(7);
  });
});


// ═════════════════════════════════════════════════════════════════════════════
//  Money earmarked for one goal (Phase 9.2 — what-if scenarios)
// ═════════════════════════════════════════════════════════════════════════════
describe('money the user has earmarked for a goal', () => {
  it('changes nothing when none is given', () => {
    const plain = report({ capacity: perMonth(500) });
    const same = report({ capacity: perMonth(500), commitments: {} });
    expect(same.lines).toEqual(plain.lines);
    expect(same.committedPerMonth).toBe(0);
  });

  it('goes to that goal in full, ahead of the shared pool', () => {
    const r = report({
      goals: [goal({ id: 'g1', targetDate: '2026-12-01' }), goal({ id: 'g2', targetDate: '2026-10-01' })],
      capacity: perMonth(300),
      commitments: { g1: 800 },
    });
    // g2 has the earlier deadline and would ordinarily take the pool first.
    expect(line(r, 'g1').allocatedPerMonth).toBe(800);
    expect(r.committedPerMonth).toBe(800);
  });

  it('is taken out of the pool so the same dollar is never promised twice', () => {
    const r = report({
      goals: [goal({ id: 'g1' }), goal({ id: 'g2' })],
      capacity: perMonth(1_000),
      commitments: { g1: 400 },
    });
    expect(line(r, 'g1').allocatedPerMonth).toBe(400);
    expect(line(r, 'g2').allocatedPerMonth).toBeLessThanOrEqual(600);
  });

  it('cannot conjure spare cash for anybody else when it exceeds the pool', () => {
    const r = report({
      goals: [goal({ id: 'g1' }), goal({ id: 'g2' })],
      capacity: perMonth(200),
      commitments: { g1: 5_000 },
    });
    expect(line(r, 'g2').allocatedPerMonth).toBe(0);
    expect(r.unallocatedPerMonth).toBe(0);
  });

  it('paying more than the deadline needs finishes the goal early', () => {
    const slow = line(report({ capacity: perMonth(500) }));
    const fast = line(report({ capacity: perMonth(500), commitments: { g1: 5_000 } }));
    expect(fast.allocatedPerMonth).toBe(5_000);
    expect(fast.status).toBe('on-track');
    expect(fast.projectedDate! < slow.projectedDate!).toBe(true);
  });

  it('still reports the goal at risk when the commitment is short', () => {
    const l = line(report({ capacity: perMonth(0), commitments: { g1: 100 } }));
    expect(l.status).toBe('at-risk');
    expect(l.shortfallPerMonth).toBeGreaterThan(0);
  });

  it('gives an overdue goal a finish date once real money is going into it', () => {
    const goals = [goal({ targetDate: '2026-01-01' })];
    expect(line(report({ goals, capacity: perMonth(500) })).allocatedPerMonth).toBe(0);
    const funded = line(report({ goals, capacity: perMonth(500), commitments: { g1: 1_000 } }));
    expect(funded.allocatedPerMonth).toBe(1_000);
    expect(funded.projectedDate).not.toBeNull();
    expect(funded.status).toBe('overdue'); // the deadline is still gone
  });

  it('ignores a commitment to a goal that is already complete', () => {
    const r = report({
      goals: [goal({ openingAmount: 10_000 })],
      capacity: perMonth(500),
      commitments: { g1: 900 },
    });
    expect(line(r).status).toBe('complete');
    expect(r.committedPerMonth).toBe(0);
  });

  it('ignores a commitment to a goal that is not there', () => {
    const r = report({ capacity: perMonth(500), commitments: { 'gone': 900 } });
    expect(r.committedPerMonth).toBe(0);
  });
});
