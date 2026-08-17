/**
 * Phase 4.3 — the savings-goal view model.
 *
 * The engine decides the numbers; this decides what the card SAYS about them.
 * These tests pin the wording/tone/order rules so the component can stay a dumb
 * renderer with nothing of its own to test in a browser.
 */

import { describe, it, expect } from 'vitest';
import { buildGoalReport, type GoalInput } from './savingsGoals';
import { toGoalView, barFor, messageFor, sortLines, toneFor, labelFor } from './goalView';

const TODAY = '2026-08-17';

const goal = (o: Partial<GoalInput> = {}): GoalInput => ({
  id: 'g1', name: 'House deposit', targetAmount: 10_000,
  targetDate: '2027-08-17', openingAmount: 0, links: [], ...o,
});

const perMonth = (n: number) => ({ surplus: n * (90 / 30.4375), days: 90 });

const view = (o: Partial<Parameters<typeof buildGoalReport>[0]> = {}) => toGoalView(buildGoalReport({
  asOf: TODAY, goals: o.goals ?? [goal()], contributions: o.contributions ?? [],
  balances: o.balances ?? [], capacity: o.capacity,
}));

const only = (v: ReturnType<typeof view>) => v.lines[0];

// ═════════════════════════════════════════════════════════════════════════════
//  Tone and label
// ═════════════════════════════════════════════════════════════════════════════
describe('tone', () => {
  it('maps each status to a register', () => {
    expect(toneFor('complete')).toBe('good');
    expect(toneFor('on-track')).toBe('good');
    expect(toneFor('at-risk')).toBe('warn');
    expect(toneFor('behind')).toBe('bad');
    expect(toneFor('overdue')).toBe('bad');
    expect(toneFor('no-deadline')).toBe('neutral');
    expect(toneFor('unknown')).toBe('neutral');
  });

  it('has a label for every status', () => {
    for (const s of ['complete', 'on-track', 'at-risk', 'behind', 'overdue', 'no-deadline', 'unknown'] as const) {
      expect(labelFor(s).length).toBeGreaterThan(0);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The message
// ═════════════════════════════════════════════════════════════════════════════
describe('what the card says under a goal', () => {
  it('celebrates a reached goal and shows the overshoot', () => {
    const m = messageFor(only(view({ goals: [goal({ openingAmount: 11_000 })] })));
    expect(m).toEqual({ kind: 'complete', over: 1_000 });
  });

  it('says how short and how late an overdue goal is', () => {
    const m = messageFor(only(view({ goals: [goal({ targetDate: '2026-06-01', openingAmount: 4_000 })] })));
    expect(m).toEqual({ kind: 'overdue', short: 6_000, daysPast: 77 });
  });

  it('just states the remainder for an open-ended goal', () => {
    const m = messageFor(only(view({ goals: [goal({ targetDate: null, openingAmount: 2_000 })] })));
    expect(m).toEqual({ kind: 'open', remaining: 8_000 });
  });

  it('quotes the monthly figure when on track', () => {
    const m = messageFor(only(view({ goals: [goal({ targetAmount: 1_200 })], capacity: perMonth(500) })));
    expect(m.kind).toBe('on-track');
    expect(m.kind === 'on-track' && Math.round(m.perMonth)).toBe(100);
  });

  it('contrasts required against available when short', () => {
    const m = messageFor(only(view({ goals: [goal({ targetAmount: 1_200 })], capacity: perMonth(40) })));
    expect(m.kind).toBe('short');
    if (m.kind === 'short') {
      expect(Math.round(m.required)).toBe(100);
      expect(m.allocated).toBe(40);
      expect(Math.round(m.shortfall)).toBe(60);
    }
  });

  it('names the requirement when nothing is spare', () => {
    const m = messageFor(only(view({ goals: [goal({ targetAmount: 1_200 })], capacity: { surplus: -50, days: 90 } })));
    expect(m.kind).toBe('unfunded');
    expect(m.kind === 'unfunded' && Math.round(m.required)).toBe(100);
  });

  it('admits when there is no forecast to judge against', () => {
    const m = messageFor(only(view({ goals: [goal({ targetAmount: 1_200 })] })));
    expect(m.kind).toBe('unknown');
    expect(m.kind === 'unknown' && Math.round(m.required)).toBe(100);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The bar
// ═════════════════════════════════════════════════════════════════════════════
describe('the progress bar', () => {
  it('fills to the saved percentage', () => {
    const bar = barFor(only(view({ goals: [goal({ openingAmount: 3_000 })], capacity: perMonth(1) })));
    expect(bar.fillPct).toBe(30);
  });

  it('marks where the goal is projected to reach by its date', () => {
    // Half saved, and the funded rate carries it further by the deadline.
    const bar = barFor(only(view({
      goals: [goal({ targetAmount: 1_200, openingAmount: 600 })],
      capacity: perMonth(500),
    })));
    expect(bar.markerPct).not.toBeNull();
    expect(bar.markerPct!).toBeGreaterThan(bar.fillPct);
  });

  it('shows no marker when nothing extra is coming', () => {
    const bar = barFor(only(view({ goals: [goal({ targetAmount: 1_200, openingAmount: 600 })], capacity: { surplus: 0, days: 90 } })));
    expect(bar.markerPct).toBeNull();
  });

  it('shows no marker once the deadline has passed', () => {
    const bar = barFor(only(view({ goals: [goal({ targetDate: '2026-06-01', openingAmount: 500 })], capacity: perMonth(500) })));
    expect(bar.markerPct).toBeNull();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Order
// ═════════════════════════════════════════════════════════════════════════════
describe('the order goals appear in', () => {
  it('puts the ones needing attention first and finished ones last', () => {
    // $110/mo spare. `late` is past its date (overdue); `ontrack` needs ~$100
    // and is fully funded; `done` is finished.
    const v = view({
      goals: [
        goal({ id: 'done', targetAmount: 100, openingAmount: 100, targetDate: '2027-01-01' }),
        goal({ id: 'ontrack', targetAmount: 1_200, targetDate: '2027-08-17' }),
        goal({ id: 'late', targetAmount: 5_000, openingAmount: 1_000, targetDate: '2026-05-01' }),
      ],
      capacity: perMonth(110),
    });
    expect(v.lines.find(l => l.id === 'late')!.status).toBe('overdue');
    expect(v.lines.find(l => l.id === 'ontrack')!.status).toBe('on-track');
    const ids = v.lines.map(l => l.id);
    expect(ids.indexOf('late')).toBeLessThan(ids.indexOf('ontrack'));   // overdue before on-track
    expect(ids.indexOf('ontrack')).toBeLessThan(ids.indexOf('done'));   // on-track before complete
    expect(ids[ids.length - 1]).toBe('done');
  });

  it('orders goals of equal standing by deadline, soonest first', () => {
    const lines = sortLines([
      { id: 'far', name: 'B', status: 'on-track', targetDate: '2028-01-01' } as any,
      { id: 'near', name: 'A', status: 'on-track', targetDate: '2027-01-01' } as any,
    ]);
    expect(lines.map(l => l.id)).toEqual(['near', 'far']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  The whole card
// ═════════════════════════════════════════════════════════════════════════════
describe('the card as a whole', () => {
  it('is empty with no goals', () => {
    const v = view({ goals: [] });
    expect(v.isEmpty).toBe(true);
    expect(v.hasShortfall).toBe(false);
  });

  it('flags a shortfall when the forecast cannot cover the goals', () => {
    const v = view({ goals: [goal({ targetAmount: 12_000 })], capacity: perMonth(50) });
    expect(v.hasShortfall).toBe(true);
    expect(v.summary.shortfallPerMonth).toBeGreaterThan(0);
  });

  it('flags a shortfall when any goal is overdue, forecast or not', () => {
    const v = view({ goals: [goal({ targetDate: '2026-01-01', openingAmount: 1 })] });
    expect(v.hasShortfall).toBe(true);
  });

  it('reports combined progress across every goal', () => {
    const v = view({
      goals: [
        goal({ id: 'a', targetAmount: 1_000, openingAmount: 1_000 }),
        goal({ id: 'b', targetAmount: 3_000, openingAmount: 0 }),
      ],
      capacity: perMonth(100),
    });
    expect(v.summary.totalTarget).toBe(4_000);
    expect(v.summary.totalSaved).toBe(1_000);
    expect(v.summary.progressPct).toBe(25);
    expect(v.summary.completeCount).toBe(1);
  });

  it('does not flag a shortfall when everything is on track', () => {
    const v = view({ goals: [goal({ targetAmount: 1_200 })], capacity: perMonth(500) });
    expect(v.hasShortfall).toBe(false);
    expect(v.summary.unallocatedPerMonth).toBeGreaterThan(0);
  });
});
